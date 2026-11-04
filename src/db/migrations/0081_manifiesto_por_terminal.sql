-- =============================================================================
-- 0081 · Manifiesto por terminal + Viajes en terminales intermedias.
--        docs/architecture/06-lugar-paso-paqueteria.md §1.1 (L8, L9), Fase B.
--
-- REGLA (PO, 2026-11-03). Las terminales intermedias tendrán sistema propio:
-- cada terminal imprime SU manifiesto (copia conductor + copia terminal) con
-- los pasajeros que suben ahí, respetando los lugares ya vendidos. El de la
-- terminal de origen lleva además las ventas con lugar de paso (MOD-7).
--
-- QUIÉN CUBRE A QUIÉN. Un pasajero va en el manifiesto de la terminal que
-- "cubre" su punto de ascenso (`lower(tramos)`): la terminal con sucursal más
-- cercana en orden <= ese punto (`core.terminal_que_cubre`). Así:
--   * sube en una terminal            → el manifiesto de esa terminal;
--   * lugar de paso (tramo desde el origen, 0079) → el de la terminal de origen;
--   * sube en una parada sin sistema  → el de la última terminal antes de ella
--     (si no, no saldría en ningún papel).
--
-- CAMBIOS (las tres cambian de firma: DROP + CREATE)
--   1. `core.terminal_que_cubre(salida, orden)` — helper nuevo.
--   2. `core.salidas_del_dia` gana `es_origen`, `hora_paso` (de MI terminal) y
--      `boletos_aqui` (los que cubre mi manifiesto). Con sucursal: lista las
--      salidas donde mi terminal es parada de ASCENSO (no la última), no solo
--      las que salen de ella (revierte en parte 0066, ahora a propósito y
--      marcadas "de paso"). Sin sucursal: igual que antes.
--   3. `core.datos_manifiesto` gana `p_sucursal_id` (NULL = lista completa,
--      compatible). El jsonb gana `terminal`, `terminal_orden`, y por pasajero
--      `lugar_abordaje` + `cobrar` (lo que cobra el conductor, 0079).
--   4. `core.generar_manifiestos` gana `p_sucursal_id` (NULL = origen): filtra
--      por esa terminal, encola en su impresora y solo regenera SUS jobs.
--
-- DEPLOY. Sin DDL de tablas. El jsonb del print_job es autocontenido: un nodo
-- viejo imprime los suyos sin las claves nuevas (la plantilla las trata como
-- opcionales). Requiere 0079 (`venta.lugar_abordaje`, método `conductor`).
-- =============================================================================


-- 1. `core.terminal_que_cubre`
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.terminal_que_cubre(p_salida_id uuid, p_orden integer)
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT pr.sucursal_id
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id
     AND sp.orden <= p_orden
     AND pr.tipo = 'terminal'
     AND pr.sucursal_id IS NOT NULL
   ORDER BY sp.orden DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION core.terminal_que_cubre(uuid, integer) IS
  'L8 (06 §1.1). Sucursal de la terminal más cercana en orden <= p_orden: la que lleva en su manifiesto a quien sube en ese punto. 0081.';


-- 2. `core.salidas_del_dia`
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.salidas_del_dia(date, uuid);

CREATE FUNCTION core.salidas_del_dia(
  p_fecha       date,
  p_sucursal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  salida_id    uuid,
  horario_id   uuid,
  ruta_id      uuid,
  estado       text,
  hora_salida  timestamptz,
  origen       text,
  destino      text,
  conductor    text,
  unidad_id    uuid,
  unidad       text,
  boletos      integer,
  es_origen    boolean,       -- 0081
  hora_paso    timestamptz,   -- 0081: por MI terminal (= hora_salida en el origen)
  boletos_aqui integer        -- 0081: los que cubre mi manifiesto
)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.horario_id, h.ruta_id, s.estado,
         spo.hora_paso_programada,
         puo.nombre,
         pud.nombre,
         s.conductor_nombre_snapshot,
         s.unidad_id,
         u.numero_economico,
         (SELECT count(*)::int FROM core.boleto b
           WHERE b.salida_id = s.id AND b.activo AND b.estado <> 'cancelado'),
         mia.orden = 0,
         mia.hora_paso_programada,
         (SELECT count(*)::int FROM core.boleto b
           WHERE b.salida_id = s.id AND b.activo AND b.estado <> 'cancelado'
             AND (p_sucursal_id IS NULL
                  OR core.terminal_que_cubre(s.id, lower(b.tramos)) = p_sucursal_id))
    FROM core.salida s
    JOIN core.horario h ON h.id = s.horario_id
    JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = 0
    JOIN core.punto_ruta puo ON puo.id = spo.punto_id
    JOIN core.salida_parada spd ON spd.salida_id = s.id
     AND spd.orden = (SELECT max(orden) FROM core.salida_parada WHERE salida_id = s.id)
    JOIN core.punto_ruta pud ON pud.id = spd.punto_id
    LEFT JOIN core.unidad u ON u.id = s.unidad_id
    -- MI parada: el origen si no hay sucursal; si la hay, la terminal de mi
    -- sucursal donde se permite ascenso (nunca la última: ahí solo se baja).
    JOIN LATERAL (
      SELECT sp.orden, sp.hora_paso_programada
        FROM core.salida_parada sp
        JOIN core.punto_ruta pr  ON pr.id = sp.punto_id
        JOIN core.ruta_parada rp ON rp.ruta_id = h.ruta_id AND rp.punto_id = sp.punto_id
       WHERE sp.salida_id = s.id
         AND (CASE WHEN p_sucursal_id IS NULL THEN sp.orden = 0
                   ELSE pr.sucursal_id = p_sucursal_id
                        AND rp.permite_ascenso AND rp.activo
                        AND sp.orden < spd.orden END)
       ORDER BY sp.orden
       LIMIT 1
    ) mia ON true
   WHERE s.activo
     AND s.fecha_operacion = p_fecha
   ORDER BY mia.hora_paso_programada
$$;

COMMENT ON FUNCTION core.salidas_del_dia(date, uuid) IS
  'Viajes del día para el módulo de viajes: los que SALEN de mi terminal (es_origen) y los que PASAN por ella con ascenso ("de paso", 0081 / L8). hora_paso y boletos_aqui son de mi terminal. Gana ruta_id/unidad (0074). F7 · 05 §4 · 06 §1.1.';


-- 3. `core.datos_manifiesto`
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.datos_manifiesto(uuid, text, timestamptz);

CREATE FUNCTION core.datos_manifiesto(
  p_salida_id   uuid,
  p_copia       text        DEFAULT 'terminal',
  p_ahora       timestamptz DEFAULT now(),
  p_sucursal_id uuid        DEFAULT NULL     -- 0081: NULL = lista completa
)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sal       record;
  v_paradas   jsonb;
  v_pasajeros jsonb;
  v_terminal  text;
  v_t_orden   integer;
BEGIN
  IF p_copia NOT IN ('conductor', 'terminal') THEN
    RAISE EXCEPTION 'copia de manifiesto inválida: %', p_copia;
  END IF;

  SELECT s.id, s.fecha_operacion, s.conductor_nombre_snapshot, s.estado,
         u.numero_economico, tu.clave AS tipo_unidad
    INTO v_sal
    FROM core.salida s
    LEFT JOIN core.unidad u  ON u.id  = s.unidad_id
    JOIN core.tipo_unidad tu ON tu.id = s.tipo_unidad_id
   WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  -- 0081: la terminal cuyo manifiesto es (la primera parada de esa sucursal).
  IF p_sucursal_id IS NOT NULL THEN
    SELECT pr.nombre, sp.orden INTO v_terminal, v_t_orden
      FROM core.salida_parada sp
      JOIN core.punto_ruta pr ON pr.id = sp.punto_id
     WHERE sp.salida_id = p_salida_id AND pr.sucursal_id = p_sucursal_id
     ORDER BY sp.orden LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'la salida % no pasa por la sucursal %', p_salida_id, p_sucursal_id;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'orden', sp.orden, 'punto', pr.nombre, 'tipo', pr.tipo,
           'hora_paso', sp.hora_paso_programada) ORDER BY sp.orden), '[]'::jsonb)
    INTO v_paradas
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id;

  -- Lista única por boleto vivo; con sucursal, solo los que cubre su terminal.
  -- `cobrar` = importe del boleto si la venta se cobra por conductor (0079).
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'folio',          b.folio,
             'asiento',        b.asiento_num,
             'nombre',         b.pasajero_nombre,
             'sube_en',        puo.nombre,
             'sube_en_orden',  spo.orden,
             'baja_en',        pud.nombre,
             'baja_en_orden',  spd.orden,
             'estatus_pago',   CASE WHEN COALESCE(vs.saldo_pendiente, 0) <= 0
                                    THEN 'pagado' ELSE 'pendiente' END,
             'conflicto',      (b.estado = 'conflicto_sobreventa'),
             'lugar_abordaje', v.lugar_abordaje,
             'cobrar',         CASE WHEN EXISTS (
                                 SELECT 1 FROM core.pago p
                                  WHERE p.venta_id = b.venta_id AND p.activo
                                    AND p.metodo = 'conductor')
                               THEN b.importe END
           )
           ORDER BY spo.orden, (v.lugar_abordaje IS NOT NULL), b.asiento_num
         ), '[]'::jsonb)
    INTO v_pasajeros
    FROM core.boleto b
    JOIN core.venta v ON v.id = b.venta_id
    JOIN core.salida_parada spo
      ON spo.salida_id = p_salida_id AND spo.orden = lower(b.tramos)
    JOIN core.punto_ruta puo ON puo.id = spo.punto_id
    JOIN core.salida_parada spd
      ON spd.salida_id = p_salida_id AND spd.orden = upper(b.tramos)
    JOIN core.punto_ruta pud ON pud.id = spd.punto_id
    LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = b.venta_id
   WHERE b.salida_id = p_salida_id
     AND b.activo
     AND b.estado <> 'cancelado'
     AND (p_sucursal_id IS NULL
          OR core.terminal_que_cubre(p_salida_id, lower(b.tramos)) = p_sucursal_id);

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'salida_id',       v_sal.id,
    'copia',           p_copia,
    'fecha_operacion', v_sal.fecha_operacion,
    'estado_salida',   v_sal.estado,
    'conductor',       v_sal.conductor_nombre_snapshot,
    'unidad',          v_sal.numero_economico,
    'tipo_unidad',     v_sal.tipo_unidad,
    'generado_en',     p_ahora,
    'terminal',        v_terminal,
    'terminal_orden',  v_t_orden,
    'paradas',         v_paradas,
    'pasajeros',       v_pasajeros
  ));
END $$;

COMMENT ON FUNCTION core.datos_manifiesto(uuid, text, timestamptz, uuid) IS
  'Datos congelados de un manifiesto: lista única por pasajero (D11/N-8). Con p_sucursal_id, solo los que cubre esa terminal (core.terminal_que_cubre) + lugar de paso y monto a cobrar por conductor (0081 / L8). paradas nunca ausente (0072). 03 §2.5 · 06 §1.1.';


-- 4. `core.generar_manifiestos`
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.generar_manifiestos(uuid, uuid, timestamptz);

CREATE FUNCTION core.generar_manifiestos(
  p_salida_id   uuid,
  p_usuario_id  uuid,
  p_ahora       timestamptz DEFAULT now(),
  p_sucursal_id uuid        DEFAULT NULL     -- 0081: NULL = terminal de origen
)
RETURNS TABLE (copia text, print_job_id uuid, pasajeros integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_sucursal uuid;
  v_copia    text;
  v_datos    jsonb;
  v_id       uuid;
  v_n        integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.salida WHERE id = p_salida_id) THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  v_sucursal := p_sucursal_id;
  IF v_sucursal IS NULL THEN
    SELECT pr.sucursal_id INTO v_sucursal
      FROM core.salida_parada sp
      JOIN core.punto_ruta pr ON pr.id = sp.punto_id
     WHERE sp.salida_id = p_salida_id AND sp.orden = 0;
  END IF;

  -- Solo se regeneran los jobs pendientes de ESTA terminal.
  UPDATE core.print_job
     SET activo = false, desactivado_motivo = 'manifiesto regenerado'
   WHERE boleto_id IS NULL
     AND template_key IN ('manifiesto_conductor', 'manifiesto_terminal')
     AND estado = 'pendiente'
     AND sucursal_id = v_sucursal
     AND datos->>'salida_id' = p_salida_id::text
     AND activo;

  FOREACH v_copia IN ARRAY ARRAY['conductor', 'terminal'] LOOP
    v_datos := core.datos_manifiesto(p_salida_id, v_copia, p_ahora, v_sucursal);
    v_n := COALESCE(jsonb_array_length(v_datos->'pasajeros'), 0);

    INSERT INTO core.print_job (id, sucursal_id, template_key, datos, estado, boleto_id)
    VALUES (core.uuid_v7(), v_sucursal, 'manifiesto_' || v_copia, v_datos, 'pendiente', NULL)
    RETURNING id INTO v_id;

    copia := v_copia; print_job_id := v_id; pasajeros := v_n;
    RETURN NEXT;
  END LOOP;
END $$;

COMMENT ON FUNCTION core.generar_manifiestos(uuid, uuid, timestamptz, uuid) IS
  'Encola los dos print_job de manifiesto (conductor y terminal) de UNA terminal de la salida (origen por defecto), con sus pasajeros (0081 / L8). F7 · 05 §4 · 06 §1.1.';
