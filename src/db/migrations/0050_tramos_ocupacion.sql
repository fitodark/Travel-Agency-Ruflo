-- =============================================================================
-- 0050 · Semántica de ocupación del asiento. Fase 2 de "paradas autorizadas".
--        docs/architecture/05-paradas-autorizadas-tarifas.md §3 y §4 (Fase 2).
--
-- El boleto pasa a guardar DOS rangos:
--   `tramos`            = viaje  (tarifa, impresión, manifiesto). NO cambia.
--   `tramos_ocupacion`  = ocupación física del asiento (EXCLUDE, disponibilidad,
--                          cupo). Puede ser MÁS ancho que el viaje:
--     - lower = 0 (origen de la ruta) si la venta la origina una parada de
--       ascenso sin POS (`punto_ruta.tipo='parada'`): el asiento se aparta
--       desde el origen y ya no se vende desde ahí (P-3 / D3).
--     - upper = n-1 (fin de ruta) si el destino es una parada de solo descenso
--       (`punto_ruta.tipo='parada'` con `permite_descenso`): nadie asciende ahí
--       para recomprar el tramo liberado (D3).
--
-- La restricción de exclusión (la invariante de 0005) pasa a operar sobre
-- `tramos_ocupacion`. Toda la data actual es terminal→terminal, así que el
-- backfill `tramos_ocupacion := tramos` es exacto.
--
-- DEPLOY (D-8): nube + 4 terminales en 0049 antes de 0050, misma ventana. El
-- `ADD COLUMN` es nullable + backfill + `SET NOT NULL`; un nodo en 0049 que
-- ingiere filas sin `tramos_ocupacion` las tomaría NULL — por eso el
-- `SET NOT NULL` va en esta misma migración y el orden de despliegue importa.
-- =============================================================================


-- 1. Helper: rango de ocupación a partir del rango de viaje, para una salida.
--    Lo usan asientos_libres, adquirir_lease y registrar_venta.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.tramo_ocupacion(
  p_salida_id uuid,
  p_desde     integer,
  p_hasta     integer
)
RETURNS int4range
LANGUAGE sql STABLE AS $$
  WITH p AS (
    SELECT sp.orden,
           pr.tipo,
           rp.permite_descenso
      FROM core.salida_parada sp
      JOIN core.salida sa      ON sa.id = sp.salida_id
      JOIN core.horario h      ON h.id  = sa.horario_id
      JOIN core.ruta_parada rp ON rp.ruta_id = h.ruta_id AND rp.punto_id = sp.punto_id
      JOIN core.punto_ruta pr  ON pr.id = sp.punto_id
     WHERE sp.salida_id = p_salida_id
  )
  SELECT int4range(
    CASE WHEN (SELECT tipo FROM p WHERE orden = p_desde) = 'parada'
         THEN 0 ELSE p_desde END,
    CASE WHEN (SELECT tipo = 'parada' AND permite_descenso FROM p WHERE orden = p_hasta)
         THEN (SELECT max(orden) FROM p) ELSE p_hasta END
  )
$$;

COMMENT ON FUNCTION core.tramo_ocupacion(uuid, integer, integer) IS
  'Rango de ocupación físico del asiento para un viaje [desde,hasta): se extiende a 0 si el origen es parada, y a n-1 si el destino es parada de descenso. 05 §3.';


-- 2. Columnas nuevas + backfill + NOT NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE core.boleto            ADD COLUMN IF NOT EXISTS tramos_ocupacion int4range;
ALTER TABLE core.asiento_ocupacion ADD COLUMN IF NOT EXISTS tramos_ocupacion int4range;
ALTER TABLE core.asiento_lease     ADD COLUMN IF NOT EXISTS tramos_ocupacion int4range;

UPDATE core.boleto            SET tramos_ocupacion = tramos WHERE tramos_ocupacion IS NULL;
UPDATE core.asiento_ocupacion SET tramos_ocupacion = tramos WHERE tramos_ocupacion IS NULL;
UPDATE core.asiento_lease     SET tramos_ocupacion = tramos WHERE tramos_ocupacion IS NULL;

-- Compat: `tramos_ocupacion` cae de vuelta al viaje cuando el insertador no lo da.
-- Necesario en la ventana de despliegue — una terminal en 0049 que vende empuja
-- `boleto` / `asiento_ocupacion` a la nube en 0050 sin la columna (0031 toma solo
-- columnas reales del payload) y el `SET NOT NULL` la rechazaría. `registrar_venta`
-- y `adquirir_lease` (0050) siempre la calculan; esto solo cubre el borde.
CREATE OR REPLACE FUNCTION core.trg_tramos_ocupacion_compat()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tramos_ocupacion IS NULL THEN
    NEW.tramos_ocupacion := NEW.tramos;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.boleto','core.asiento_ocupacion','core.asiento_lease'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_aa_tramos_ocupacion_compat ON %s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_aa_tramos_ocupacion_compat BEFORE INSERT ON %s
         FOR EACH ROW EXECUTE FUNCTION core.trg_tramos_ocupacion_compat()', t);
  END LOOP;
END $$;

ALTER TABLE core.boleto            ALTER COLUMN tramos_ocupacion SET NOT NULL;
ALTER TABLE core.asiento_ocupacion ALTER COLUMN tramos_ocupacion SET NOT NULL;
ALTER TABLE core.asiento_lease     ALTER COLUMN tramos_ocupacion SET NOT NULL;


-- 3. La invariante de exclusión pasa a `tramos_ocupacion`.
-- ---------------------------------------------------------------------------
ALTER TABLE core.asiento_ocupacion
  DROP CONSTRAINT IF EXISTS asiento_ocupacion_salida_id_asiento_num_tramos_excl,
  DROP CONSTRAINT IF EXISTS asiento_ocupacion_no_solapa;
ALTER TABLE core.asiento_ocupacion
  ADD CONSTRAINT asiento_ocupacion_no_solapa EXCLUDE USING gist (
    salida_id        WITH =,
    asiento_num      WITH =,
    tramos_ocupacion WITH &&
  ) WHERE (estado = 'firme');

ALTER TABLE core.asiento_lease
  DROP CONSTRAINT IF EXISTS asiento_lease_salida_id_asiento_num_tramos_excl,
  DROP CONSTRAINT IF EXISTS asiento_lease_vivo_no_solapa;
ALTER TABLE core.asiento_lease
  ADD CONSTRAINT asiento_lease_vivo_no_solapa EXCLUDE USING gist (
    salida_id        WITH =,
    asiento_num      WITH =,
    tramos_ocupacion WITH &&
  ) WHERE (consumido_por_boleto_id IS NULL AND liberado_en IS NULL);


-- 4. core.asientos_libres — solapamiento contra `tramos_ocupacion` del rango de
--    ocupación que TENDRÍA la venta pedida, no contra el viaje pelado.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.asientos_libres(
  p_salida_id uuid,
  p_desde     integer,
  p_hasta     integer,
  p_ahora     timestamptz DEFAULT now()
)
RETURNS smallint[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_ocup int4range := core.tramo_ocupacion(p_salida_id, p_desde, p_hasta);
BEGIN
  RETURN (
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
            AND o.tramos_ocupacion && v_ocup
       )
       AND NOT EXISTS (
         SELECT 1 FROM core.asiento_lease l
          WHERE l.salida_id = p_salida_id
            AND l.asiento_num = a.num
            AND l.consumido_por_boleto_id IS NULL
            AND l.liberado_en IS NULL
            AND l.expira_en > p_ahora
            AND l.tramos_ocupacion && v_ocup
       )
  );
END $$;

COMMENT ON FUNCTION core.asientos_libres(uuid, integer, integer, timestamptz) IS
  'Asientos vendibles de una salida sin ocupación firme ni lease vivo cuyo tramos_ocupacion solape el de la venta pedida. Blueprint 01b §2 · 05 §3.';


-- 5. core.adquirir_lease — copia vigente de 0049 + tramos_ocupacion.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.adquirir_lease(
  p_salida_id    uuid,
  p_asiento_num  smallint,
  p_desde        integer,
  p_hasta        integer,
  p_sucursal_id  uuid,
  p_duracion_seg integer     DEFAULT NULL,
  p_ahora        timestamptz DEFAULT now()
)
RETURNS TABLE (estado text, lease_id uuid, expira_en timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_estado_salida text;
  v_n_tramos      integer;
  v_dur_seg       integer;
  v_id            uuid;
  v_exp           timestamptz;
  v_ocup          int4range;
BEGIN
  SELECT s.estado INTO v_estado_salida FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado_salida <> 'programada' THEN
    RAISE EXCEPTION 'la salida % está % : no se puede reservar asiento', p_salida_id, v_estado_salida;
  END IF;

  SELECT count(*)::int INTO v_n_tramos
    FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF p_desde < 0 OR p_hasta <= p_desde OR p_hasta > v_n_tramos - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_desde, p_hasta, p_salida_id, v_n_tramos;
  END IF;

  -- El punto de origen del lease debe permitir ascenso en la ruta (D2 / P-1).
  IF NOT EXISTS (
    SELECT 1
      FROM core.salida_parada sp
      JOIN core.salida sa      ON sa.id = sp.salida_id
      JOIN core.horario h      ON h.id  = sa.horario_id
      JOIN core.ruta_parada rp ON rp.ruta_id = h.ruta_id AND rp.punto_id = sp.punto_id
     WHERE sp.salida_id = p_salida_id
       AND sp.orden = p_desde
       AND rp.permite_ascenso AND rp.activo
  ) THEN
    RAISE EXCEPTION 'la parada de origen (orden %) de la salida % no permite ascenso',
      p_desde, p_salida_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM core.salida s
      CROSS JOIN LATERAL jsonb_array_elements(s.mapa_snapshot->'asientos') e
     WHERE s.id = p_salida_id
       AND (e->>'num')::smallint = p_asiento_num
       AND COALESCE((e->>'vendible')::boolean, true)
  ) THEN
    RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida %', p_asiento_num, p_salida_id;
  END IF;

  v_ocup := core.tramo_ocupacion(p_salida_id, p_desde, p_hasta);

  -- Limpia leases vencidos de ESTE asiento para que no bloqueen por la constraint.
  UPDATE core.asiento_lease AS al
     SET liberado_en = al.expira_en
   WHERE al.salida_id = p_salida_id
     AND al.asiento_num = p_asiento_num
     AND al.consumido_por_boleto_id IS NULL
     AND al.liberado_en IS NULL
     AND al.expira_en <= p_ahora;

  -- Ocupación firme que solapa el rango de ocupación: el asiento está vendido.
  IF EXISTS (
    SELECT 1 FROM core.asiento_ocupacion o
     WHERE o.salida_id = p_salida_id
       AND o.asiento_num = p_asiento_num
       AND o.estado = 'firme'
       AND o.tramos_ocupacion && v_ocup
  ) THEN
    estado := 'ocupado'; RETURN NEXT; RETURN;
  END IF;

  v_dur_seg := COALESCE(
    p_duracion_seg,
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_lease' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1) * 60,
    900);
  v_exp := p_ahora + make_interval(secs => v_dur_seg);

  BEGIN
    INSERT INTO core.asiento_lease
      (salida_id, asiento_num, tramos, tramos_ocupacion, sucursal_id, otorgado_en, expira_en)
    VALUES
      (p_salida_id, p_asiento_num, int4range(p_desde, p_hasta), v_ocup, p_sucursal_id,
       p_ahora, v_exp)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    estado := 'lease_ajeno'; RETURN NEXT; RETURN;
  END;

  estado := 'otorgado'; lease_id := v_id; expira_en := v_exp;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.adquirir_lease(uuid, smallint, integer, integer, uuid, integer, timestamptz) IS
  'Pide un lease de asiento (paso 3). Reserva el rango de ocupación (0..n-1 con paradas). Devuelve otorgado/ocupado/lease_ajeno. Blueprint 01b §5 · 05 §3.';


-- 6. core.registrar_venta — copia vigente de 0049 + tramos_ocupacion en boleto
--    y asiento_ocupacion.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.registrar_venta(
  p_salida_id         uuid,
  p_sucursal_venta_id uuid,
  p_usuario_id        uuid,
  p_contacto_telefono text,
  p_origen_orden      integer,
  p_destino_orden     integer,
  p_pasajeros         jsonb,
  p_es_reservacion    boolean     DEFAULT false,
  p_cliente_id        uuid        DEFAULT NULL,
  p_pago              jsonb       DEFAULT NULL,
  p_con_conexion      boolean     DEFAULT true,
  p_ahora             timestamptz DEFAULT now()
)
RETURNS TABLE (
  venta_id        uuid,
  estado_venta    text,
  importe_total   numeric,
  pagado          numeric,
  saldo_pendiente numeric,
  boletos         jsonb,
  print_jobs      integer,
  imprimible      boolean
)
LANGUAGE plpgsql AS $$
DECLARE
  v_estado_salida text;
  v_mapa          jsonb;
  v_n_paradas     integer;
  v_cierre        timestamptz;
  v_zona_muerta   integer;
  v_importe_total numeric;
  v_metodo        text;
  v_monto         numeric;
  v_es_abono      boolean;
  v_corte_id      uuid;
  v_pagado        numeric := 0;
  v_saldo         numeric;
  v_liquidada     boolean;
  v_prioridad     integer;
  v_venta_id      uuid;
  v_p             jsonb;
  v_asiento       smallint;
  v_nombre        text;
  v_imp           numeric;
  v_lease_id      uuid;
  v_lease         core.asiento_lease%ROWTYPE;
  v_folio         char(6);
  v_boleto_id     uuid;
  v_boletos       jsonb := '[]'::jsonb;
  v_print_jobs    integer := 0;
  v_tramo         int4range;
  v_tramo_ocup    int4range;
BEGIN
  IF p_contacto_telefono IS NULL OR btrim(p_contacto_telefono) = '' THEN
    RAISE EXCEPTION 'el teléfono de contacto es obligatorio (S11)';
  END IF;

  SELECT s.estado, s.mapa_snapshot INTO v_estado_salida, v_mapa
    FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado_salida <> 'programada' THEN
    RAISE EXCEPTION 'la salida % está % : no se puede vender ni reservar', p_salida_id, v_estado_salida;
  END IF;

  SELECT count(*)::int INTO v_n_paradas
    FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF p_origen_orden < 0 OR p_destino_orden <= p_origen_orden
     OR p_destino_orden > v_n_paradas - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_origen_orden, p_destino_orden, p_salida_id, v_n_paradas;
  END IF;
  v_tramo      := int4range(p_origen_orden, p_destino_orden);
  v_tramo_ocup := core.tramo_ocupacion(p_salida_id, p_origen_orden, p_destino_orden);

  -- El punto de origen debe permitir ascenso en la ruta (D2 / P-1): una parada
  -- de solo descenso nunca origina una venta.
  IF NOT EXISTS (
    SELECT 1
      FROM core.salida_parada sp
      JOIN core.salida sa      ON sa.id = sp.salida_id
      JOIN core.horario h      ON h.id  = sa.horario_id
      JOIN core.ruta_parada rp ON rp.ruta_id = h.ruta_id AND rp.punto_id = sp.punto_id
     WHERE sp.salida_id = p_salida_id
       AND sp.orden = p_origen_orden
       AND rp.permite_ascenso AND rp.activo
  ) THEN
    RAISE EXCEPTION 'la parada de origen (orden %) de la salida % no permite ascenso',
      p_origen_orden, p_salida_id;
  END IF;

  SELECT sp.cierre_venta_en INTO v_cierre
    FROM core.salida_parada sp
   WHERE sp.salida_id = p_salida_id AND sp.orden = p_origen_orden;
  IF v_cierre <= p_ahora THEN
    RAISE EXCEPTION 'la venta para la parada % de la salida % ya cerró', p_origen_orden, p_salida_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.usuario u
     WHERE u.id = p_usuario_id AND u.activo
       AND u.effective_from <= p_ahora
       AND (u.effective_until IS NULL OR u.effective_until > p_ahora)
  ) THEN
    RAISE EXCEPTION 'el usuario % no existe o no está vigente', p_usuario_id;
  END IF;

  IF p_pasajeros IS NULL OR jsonb_typeof(p_pasajeros) <> 'array'
     OR jsonb_array_length(p_pasajeros) = 0 THEN
    RAISE EXCEPTION 'la venta no lleva pasajeros';
  END IF;

  SELECT COALESCE(sum((e->>'importe')::numeric), 0) INTO v_importe_total
    FROM jsonb_array_elements(p_pasajeros) e;

  v_zona_muerta := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_zona_muerta' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1), 15);

  -- --- Pago (paso 6): resolver corte y cuánto cuenta ya ---
  IF p_pago IS NOT NULL THEN
    v_metodo   := p_pago->>'metodo';
    v_monto    := (p_pago->>'monto')::numeric;
    v_es_abono := COALESCE((p_pago->>'es_abono')::boolean, false);
    IF v_metodo NOT IN ('efectivo', 'transferencia') THEN
      RAISE EXCEPTION 'método de pago inválido: %', v_metodo;
    END IF;
    IF v_monto IS NULL OR v_monto <= 0 THEN
      RAISE EXCEPTION 'el monto del pago debe ser positivo';
    END IF;
    v_corte_id := COALESCE((p_pago->>'corte_caja_id')::uuid,
                           core.corte_abierto(p_sucursal_venta_id));
    v_pagado := CASE WHEN v_metodo = 'efectivo' THEN v_monto ELSE 0 END;
  END IF;

  v_saldo     := v_importe_total - v_pagado;
  v_liquidada := v_saldo <= 0;
  v_prioridad := CASE WHEN v_liquidada THEN 3 WHEN v_pagado > 0 THEN 2 ELSE 1 END;

  INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, cliente_id, contacto_telefono,
                          es_reservacion, salida_id, parada_origen_orden, parada_destino_orden,
                          importe_total, estado)
  VALUES (core.uuid_v7(), p_sucursal_venta_id, p_usuario_id, p_cliente_id, p_contacto_telefono,
          p_es_reservacion, p_salida_id, p_origen_orden, p_destino_orden,
          v_importe_total, CASE WHEN v_liquidada THEN 'liquidada' ELSE 'pendiente' END)
  RETURNING id INTO v_venta_id;

  FOR v_p IN SELECT * FROM jsonb_array_elements(p_pasajeros) LOOP
    v_asiento  := (v_p->>'asiento_num')::smallint;
    v_nombre   := v_p->>'nombre';
    v_imp      := (v_p->>'importe')::numeric;
    v_lease_id := (v_p->>'lease_id')::uuid;

    IF v_nombre IS NULL OR btrim(v_nombre) = '' THEN
      RAISE EXCEPTION 'falta el nombre del pasajero del asiento %', v_asiento;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_mapa->'asientos') a
       WHERE (a->>'num')::smallint = v_asiento
         AND COALESCE((a->>'vendible')::boolean, true)
    ) THEN
      RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida %', v_asiento, p_salida_id;
    END IF;

    -- Autorización para ocupar el asiento.
    IF v_lease_id IS NOT NULL THEN
      SELECT * INTO v_lease FROM core.asiento_lease
       WHERE id = v_lease_id
         AND consumido_por_boleto_id IS NULL AND liberado_en IS NULL
         AND expira_en > p_ahora;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'el lease % no está vivo', v_lease_id;
      END IF;
      IF v_lease.sucursal_id <> p_sucursal_venta_id THEN
        RAISE EXCEPTION 'el lease % es de otra sucursal', v_lease_id;
      END IF;
      IF v_lease.asiento_num <> v_asiento OR NOT (v_lease.tramos @> v_tramo) THEN
        RAISE EXCEPTION 'el lease % no cubre el asiento % en el tramo pedido', v_lease_id, v_asiento;
      END IF;
    ELSIF NOT p_con_conexion THEN
      -- Regla de oro offline (01b §3.4): solo el cupo propio vigente.
      IF NOT EXISTS (
        SELECT 1 FROM core.cupo_offline co
         WHERE co.salida_id = p_salida_id
           AND co.sucursal_id = p_sucursal_venta_id
           AND v_asiento = ANY (co.asientos)
           AND co.tramos @> v_tramo
           AND co.vigente_desde <= p_ahora
           AND co.vigente_hasta - make_interval(mins => v_zona_muerta) > p_ahora
      ) THEN
        RAISE EXCEPTION 'sin conexión, el asiento % no está en el cupo vigente de la sucursal %',
          v_asiento, p_sucursal_venta_id;
      END IF;
    END IF;
    -- Con conexión y sin lease: se permite directo; el EXCLUDE es la última defensa.

    v_folio := core.siguiente_folio(p_sucursal_venta_id);
    INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, tramos_ocupacion,
                             pasajero_nombre, importe, estado)
    VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_id, v_asiento, v_tramo, v_tramo_ocup,
            v_nombre, v_imp, 'emitido')
    RETURNING id INTO v_boleto_id;

    BEGIN
      INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, tramos_ocupacion, boleto_id,
                                          estado, sucursal_id, emitido_en, prioridad)
      VALUES (core.uuid_v7(), p_salida_id, v_asiento, v_tramo, v_tramo_ocup, v_boleto_id,
              'firme', p_sucursal_venta_id, p_ahora, v_prioridad);
    EXCEPTION WHEN exclusion_violation THEN
      RAISE EXCEPTION 'el asiento % ya está vendido en un tramo que solapa', v_asiento;
    END;

    IF v_lease_id IS NOT NULL THEN
      PERFORM core.consumir_lease(v_lease_id, v_boleto_id, p_ahora);
    END IF;

    v_boletos := v_boletos || jsonb_build_object(
      'boleto_id', v_boleto_id, 'folio', v_folio, 'asiento_num', v_asiento,
      'pasajero', v_nombre, 'importe', v_imp);
  END LOOP;

  IF p_pago IS NOT NULL THEN
    INSERT INTO core.pago (id, venta_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                           metodo, monto, es_abono, verificado, referencia_transferencia, pagado_en)
    VALUES (core.uuid_v7(), v_venta_id, p_sucursal_venta_id, v_corte_id, p_usuario_id,
            v_metodo, v_monto, v_es_abono, v_metodo = 'efectivo',
            p_pago->>'referencia', p_ahora);
  END IF;

  IF v_liquidada THEN
    v_print_jobs := core.encolar_impresion_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT
    v_venta_id,
    CASE WHEN v_liquidada THEN 'liquidada' ELSE 'pendiente' END,
    v_importe_total, v_pagado, v_saldo, v_boletos, v_print_jobs, v_liquidada;
END $$;

COMMENT ON FUNCTION core.registrar_venta(uuid, uuid, uuid, text, integer, integer, jsonb, boolean, uuid, jsonb, boolean, timestamptz) IS
  'Registra una venta o reservación: N boletos (viaje + ocupación), N ocupaciones firmes, pago opcional. El asiento se ocupa hasta fin de ruta si el destino es parada de descenso. Blueprint F4 · 05 §3-§4.';
