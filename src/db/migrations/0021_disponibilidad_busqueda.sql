-- =============================================================================
-- 0021 · Disponibilidad de asientos por tramo y búsqueda de salidas.
-- Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §2, §3.4
--                  docs/architecture/04-riesgos-roadmap.md §3 (F4, pasos 1-2)
--
-- Pasos 1 y 2 del flujo de venta: dada fecha + origen + destino + nº de personas,
-- el vendedor ve las salidas del día con la disponibilidad REAL por tramo. Un
-- horario lleno se muestra, pero no es seleccionable (req. §Venta de Boletos).
--
-- La disponibilidad se calcula SIEMPRE por tramo `[origen_orden, destino_orden)`:
-- un asiento ocupado de P0 a P2 sigue libre de P2 a P3. Y respeta la regla de oro
-- del modo offline (01b §3.4): sin conexión, una sucursal solo puede ofrecer los
-- asientos de su propio cupo; el resto sale en gris y no es seleccionable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Asientos SIN ocupación firme ni lease vivo que solapen el tramo pedido.
-- Es la disponibilidad "de la unidad", antes de aplicar la regla de cupo.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.asientos_libres(
  p_salida_id uuid,
  p_desde     integer,
  p_hasta     integer,
  p_ahora     timestamptz DEFAULT now()
)
RETURNS smallint[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(a.num ORDER BY a.num), ARRAY[]::smallint[])
    FROM core.salida s
    CROSS JOIN LATERAL (
      SELECT (e->>'num')::smallint AS num
        FROM jsonb_array_elements(s.mapa_snapshot->'asientos') e
       WHERE COALESCE((e->>'vendible')::boolean, true)
    ) a
   WHERE s.id = p_salida_id
     AND NOT EXISTS (
       SELECT 1 FROM core.asiento_ocupacion o
        WHERE o.salida_id = p_salida_id
          AND o.asiento_num = a.num
          AND o.estado = 'firme'
          AND o.tramos && int4range(p_desde, p_hasta)
     )
     AND NOT EXISTS (
       SELECT 1 FROM core.asiento_lease l
        WHERE l.salida_id = p_salida_id
          AND l.asiento_num = a.num
          AND l.consumido_por_boleto_id IS NULL
          AND l.liberado_en IS NULL
          AND l.expira_en > p_ahora
          AND l.tramos && int4range(p_desde, p_hasta)
     )
$$;

COMMENT ON FUNCTION core.asientos_libres(uuid, integer, integer, timestamptz) IS
  'Asientos vendibles de una salida sin ocupación firme ni lease vivo que solapen [desde,hasta). Blueprint 01b §2.';


-- -----------------------------------------------------------------------------
-- Asientos que una sucursal PUEDE OFRECER en el paso 3, aplicando la regla de
-- oro del modo offline. Con conexión: cualquier asiento libre. Sin conexión:
-- solo los del cupo propio, y solo mientras el cupo esté vigente descontando la
-- zona muerta (01b §4) — a `vigente_hasta - zona_muerta` la sucursal dueña deja
-- de venderlos aunque siga offline, porque es una condición sobre su reloj.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.asientos_ofrecibles(
  p_salida_id           uuid,
  p_desde               integer,
  p_hasta               integer,
  p_sucursal_vendedora  uuid,
  p_con_conexion        boolean DEFAULT true,
  p_ahora               timestamptz DEFAULT now()
)
RETURNS smallint[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_libres    smallint[];
  v_cupo      smallint[];
  v_zona_min  integer;
BEGIN
  v_libres := core.asientos_libres(p_salida_id, p_desde, p_hasta, p_ahora);

  IF p_con_conexion THEN
    RETURN v_libres;
  END IF;

  v_zona_min := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_zona_muerta' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1),
    15);

  SELECT co.asientos INTO v_cupo
    FROM core.cupo_offline co
   WHERE co.salida_id = p_salida_id
     AND co.sucursal_id = p_sucursal_vendedora
     AND co.tramos @> int4range(p_desde, p_hasta)
     AND co.vigente_desde <= p_ahora
     AND co.vigente_hasta - make_interval(mins => v_zona_min) > p_ahora;

  IF v_cupo IS NULL THEN
    RETURN ARRAY[]::smallint[];
  END IF;

  -- Intersección: libres ∩ cupo propio, preservando orden.
  RETURN ARRAY(
    SELECT n FROM unnest(v_libres) n
     WHERE n = ANY (v_cupo)
     ORDER BY n
  );
END $$;

COMMENT ON FUNCTION core.asientos_ofrecibles(uuid, integer, integer, uuid, boolean, timestamptz) IS
  'Asientos que una sucursal puede ofrecer en el paso 3: libres, y si está offline solo los de su cupo vigente. Blueprint 01b §3.4.';


-- -----------------------------------------------------------------------------
-- Paso 2: las salidas de un día para un par origen→destino, con disponibilidad
-- por tramo y la tarifa vigente. `seleccionable` resume las tres condiciones que
-- el vendedor no debería tener que razonar: salida programada (no en ruta), venta
-- todavía abierta, y caben las N personas.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.buscar_salidas(
  p_fecha               date,
  p_origen              uuid,
  p_destino             uuid,
  p_n_personas          integer,
  p_sucursal_vendedora  uuid,
  p_con_conexion        boolean DEFAULT true,
  p_ahora               timestamptz DEFAULT now()
)
RETURNS TABLE (
  salida_id          uuid,
  horario_id         uuid,
  fecha_operacion    date,
  hora_salida_origen timestamptz,
  origen_orden       smallint,
  destino_orden      smallint,
  estado             text,
  cierre_venta_en    timestamptz,
  importe            numeric,
  asientos_ofrecibles smallint[],
  disponibles        integer,
  seleccionable      boolean
)
LANGUAGE sql STABLE AS $$
  SELECT s.id,
         s.horario_id,
         s.fecha_operacion,
         spo.hora_paso_programada,
         spo.orden,
         spd.orden,
         s.estado,
         spo.cierre_venta_en,
         t.importe,
         ofr.asientos,
         cardinality(ofr.asientos),
         s.estado = 'programada'
           AND spo.cierre_venta_en > p_ahora
           AND cardinality(ofr.asientos) >= p_n_personas
    FROM core.salida s
    JOIN core.salida_parada spo
      ON spo.salida_id = s.id AND spo.sucursal_id = p_origen
    JOIN core.salida_parada spd
      ON spd.salida_id = s.id AND spd.sucursal_id = p_destino
    JOIN core.horario h ON h.id = s.horario_id
    LEFT JOIN core.v_tarifa_vigente t
      ON t.ruta_id = h.ruta_id
     AND t.parada_origen_orden = spo.orden
     AND t.parada_destino_orden = spd.orden
    CROSS JOIN LATERAL (
      SELECT core.asientos_ofrecibles(
        s.id, spo.orden, spd.orden, p_sucursal_vendedora, p_con_conexion, p_ahora
      ) AS asientos
    ) ofr
   WHERE s.activo
     AND s.fecha_operacion = p_fecha
     AND s.estado = 'programada'
     AND spo.orden < spd.orden
   ORDER BY spo.hora_paso_programada
$$;

COMMENT ON FUNCTION core.buscar_salidas(date, uuid, uuid, integer, uuid, boolean, timestamptz) IS
  'Paso 2 del flujo de venta: salidas del día origen→destino con disponibilidad por tramo y tarifa. Blueprint F4.';
