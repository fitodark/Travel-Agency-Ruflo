-- =============================================================================
-- 0026 · Viajes efectuados: listado de salidas del día y manifiestos (F7, slice 1).
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
--                  docs/architecture/04-riesgos-roadmap.md §3 (F7)
--
-- El requisito: listar los viajes del día y poder imprimir DOS listas de
-- pasajeros — una para el conductor (por parada de ascenso, sin importes) y otra
-- para la terminal de origen (con casillas para palomear a mano, importes, saldo
-- pendiente, y los boletos en conflicto marcados).
--
-- Aquí se generan los DATOS y se encolan los dos `print_job`. Imprimirlos es F5;
-- este módulo termina donde termina F4 con los boletos: en la cola.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Las salidas de un día. Si se pasa `p_sucursal_id`, solo las que la tocan.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.salidas_del_dia(
  p_fecha       date,
  p_sucursal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  salida_id    uuid,
  horario_id   uuid,
  estado       text,
  hora_salida  timestamptz,
  origen       text,
  destino      text,
  conductor    text,
  boletos      integer
)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.horario_id, s.estado,
         spo.hora_paso_programada,
         suo.nombre,
         sud.nombre,
         s.conductor_nombre_snapshot,
         (SELECT count(*)::int FROM core.boleto b
           WHERE b.salida_id = s.id AND b.activo AND b.estado <> 'cancelado')
    FROM core.salida s
    JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = 0
    JOIN core.sucursal suo ON suo.id = spo.sucursal_id
    JOIN core.salida_parada spd ON spd.salida_id = s.id
     AND spd.orden = (SELECT max(orden) FROM core.salida_parada WHERE salida_id = s.id)
    JOIN core.sucursal sud ON sud.id = spd.sucursal_id
   WHERE s.activo
     AND s.fecha_operacion = p_fecha
     AND (p_sucursal_id IS NULL OR EXISTS (
       SELECT 1 FROM core.salida_parada sp
        WHERE sp.salida_id = s.id AND sp.sucursal_id = p_sucursal_id))
   ORDER BY spo.hora_paso_programada
$$;

COMMENT ON FUNCTION core.salidas_del_dia(date, uuid) IS
  'Listado de viajes del día para el módulo de viajes efectuados. F7.';


-- -----------------------------------------------------------------------------
-- Datos congelados de un manifiesto. `p_copia`:
--   'conductor' — por parada de ascenso, SIN importes ni saldo.
--   'terminal'  — con importes, saldo pendiente, conflictos y ocupación por tramo.
-- Lleva `generado_en`: las ventas posteriores no aparecen en el papel.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.datos_manifiesto(
  p_salida_id uuid,
  p_copia     text        DEFAULT 'terminal',
  p_ahora     timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sal         record;
  v_es_terminal boolean := (p_copia = 'terminal');
  v_n_paradas   integer;
  v_paradas     jsonb;
  v_ascensos    jsonb;
  v_ocup        jsonb;
BEGIN
  IF p_copia NOT IN ('conductor', 'terminal') THEN
    RAISE EXCEPTION 'copia de manifiesto inválida: %', p_copia;
  END IF;

  SELECT s.id, s.fecha_operacion, s.conductor_nombre_snapshot, s.estado,
         u.numero_economico, tu.clave AS tipo_unidad
    INTO v_sal
    FROM core.salida s
    LEFT JOIN core.unidad u      ON u.id  = s.unidad_id
    JOIN core.tipo_unidad tu     ON tu.id = s.tipo_unidad_id
   WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  SELECT count(*)::int INTO v_n_paradas
    FROM core.salida_parada WHERE salida_id = p_salida_id;

  SELECT jsonb_agg(jsonb_build_object(
           'orden', sp.orden, 'sucursal', su.nombre,
           'hora_paso', sp.hora_paso_programada) ORDER BY sp.orden)
    INTO v_paradas
    FROM core.salida_parada sp
    JOIN core.sucursal su ON su.id = sp.sucursal_id
   WHERE sp.salida_id = p_salida_id;

  SELECT jsonb_agg(a ORDER BY (a->>'parada_orden')::int)
    INTO v_ascensos
    FROM (
      SELECT jsonb_build_object(
        'parada_orden', spo.orden,
        'sucursal', suo.nombre,
        'pasajeros', COALESCE(jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'folio', b.folio,
            'asiento', b.asiento_num,
            'nombre', b.pasajero_nombre,
            'destino_orden', upper(b.tramos),
            'destino', sud.nombre,
            'conflicto', (b.estado = 'conflicto_sobreventa'),
            'importe', CASE WHEN v_es_terminal THEN b.importe END,
            'saldo_pendiente', CASE WHEN v_es_terminal THEN vs.saldo_pendiente END
          )) ORDER BY b.asiento_num
        ) FILTER (WHERE b.id IS NOT NULL), '[]'::jsonb)
      ) AS a
      FROM core.salida_parada spo
      JOIN core.sucursal suo ON suo.id = spo.sucursal_id
      LEFT JOIN core.boleto b
        ON b.salida_id = p_salida_id AND lower(b.tramos) = spo.orden
       AND b.activo AND b.estado <> 'cancelado'
      LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = b.venta_id
      LEFT JOIN core.salida_parada spd
        ON spd.salida_id = p_salida_id AND spd.orden = upper(b.tramos)
      LEFT JOIN core.sucursal sud ON sud.id = spd.sucursal_id
      WHERE spo.salida_id = p_salida_id
        AND spo.orden < v_n_paradas - 1
      GROUP BY spo.orden, suo.nombre
    ) q;

  IF v_es_terminal THEN
    SELECT jsonb_agg(jsonb_build_object(
             'tramo', format('[%s,%s)', g, g + 1),
             'vendidos', (SELECT count(*) FROM core.asiento_ocupacion o
                           WHERE o.salida_id = p_salida_id AND o.estado = 'firme'
                             AND o.tramos && int4range(g, g + 1))
           ) ORDER BY g)
      INTO v_ocup
      FROM generate_series(0, v_n_paradas - 2) g;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'salida_id',           v_sal.id,
    'copia',               p_copia,
    'fecha_operacion',     v_sal.fecha_operacion,
    'estado_salida',       v_sal.estado,
    'conductor',           v_sal.conductor_nombre_snapshot,
    'unidad',              v_sal.numero_economico,
    'tipo_unidad',         v_sal.tipo_unidad,
    'generado_en',         p_ahora,
    'paradas',             v_paradas,
    'ascensos',            COALESCE(v_ascensos, '[]'::jsonb),
    'ocupacion_por_tramo', v_ocup
  ));
END $$;

COMMENT ON FUNCTION core.datos_manifiesto(uuid, text, timestamptz) IS
  'Datos congelados de un manifiesto de abordaje (copia conductor o terminal). Blueprint 03 §2.5.';


-- -----------------------------------------------------------------------------
-- Encola los dos manifiestos. Si ya había manifiestos pendientes de esta salida
-- (una regeneración por venta tardía), se dan de baja: se imprime el último.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.generar_manifiestos(
  p_salida_id  uuid,
  p_usuario_id uuid,
  p_ahora      timestamptz DEFAULT now()
)
RETURNS TABLE (copia text, print_job_id uuid, pasajeros integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_sucursal_origen uuid;
  v_copia  text;
  v_datos  jsonb;
  v_id     uuid;
  v_n      integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.salida WHERE id = p_salida_id) THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  SELECT sp.sucursal_id INTO v_sucursal_origen
    FROM core.salida_parada sp WHERE sp.salida_id = p_salida_id AND sp.orden = 0;

  UPDATE core.print_job
     SET activo = false, desactivado_motivo = 'manifiesto regenerado'
   WHERE boleto_id IS NULL
     AND template_key IN ('manifiesto_conductor', 'manifiesto_terminal')
     AND estado = 'pendiente'
     AND datos->>'salida_id' = p_salida_id::text
     AND activo;

  FOREACH v_copia IN ARRAY ARRAY['conductor', 'terminal'] LOOP
    v_datos := core.datos_manifiesto(p_salida_id, v_copia, p_ahora);
    SELECT COALESCE(sum(jsonb_array_length(asc_i->'pasajeros')), 0)::int
      INTO v_n
      FROM jsonb_array_elements(v_datos->'ascensos') asc_i;

    INSERT INTO core.print_job (id, sucursal_id, template_key, datos, estado, boleto_id)
    VALUES (core.uuid_v7(), v_sucursal_origen, 'manifiesto_' || v_copia, v_datos, 'pendiente', NULL)
    RETURNING id INTO v_id;

    copia := v_copia; print_job_id := v_id; pasajeros := v_n;
    RETURN NEXT;
  END LOOP;
END $$;

COMMENT ON FUNCTION core.generar_manifiestos(uuid, uuid, timestamptz) IS
  'Encola los dos print_job de manifiesto (conductor y terminal) de una salida. F7.';
