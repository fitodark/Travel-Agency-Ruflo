-- =============================================================================
-- 0018 · Materialización de salidas.
-- Blueprint v0.2 · docs/architecture/02-modelo-datos.md §6.1
--                  docs/architecture/04-riesgos-roadmap.md §3 (F3)
--
-- Un horario es una PLANTILLA temporal; una salida es la INSTANCIA concreta (el
-- viaje del 14 de marzo a las 07:00). Este job nocturno corre EN LA NUBE y crea
-- las salidas del horizonte de 90 días (SUPUESTO S6), que bajan replicadas a
-- todas las sucursales. Sin esto, una terminal offline no podría vender viajes
-- futuros; por eso el horizonte es largo, para cubrir el peor corte plausible.
--
-- CORRECCIÓN D-7: el mapa de asientos se CONGELA en `salida.mapa_snapshot` al
-- materializar. NO se resuelve en vivo por la cadena conductor -> unidad ->
-- tipo_unidad -> mapa: un relevo de conductor (evento cotidiano) no puede
-- invalidar asientos ya vendidos en otras sucursales.
--
-- Es idempotente por `UNIQUE (horario_id, fecha_operacion)`: correrlo de nuevo
-- solo agrega los días que falten y no toca los que ya existen.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.materializar_salidas(
  p_horario_id uuid,
  p_dias       integer DEFAULT NULL,   -- NULL = usa core.parametro
  p_desde      date    DEFAULT NULL    -- NULL = current_date
)
RETURNS TABLE (creadas integer, ya_existentes integer, sin_paradas integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_h            record;
  v_mapa         jsonb;
  v_tipo_unidad  uuid;
  v_conductor_nombre text;
  v_horizonte    integer;
  v_desde        date;
  v_cierre_min   integer;
  v_dia          date;
  v_salida_id    uuid;
  v_es_nueva     boolean;
  v_n_paradas    integer;
BEGIN
  creadas := 0; ya_existentes := 0; sin_paradas := 0;

  SELECT h.id, h.ruta_id, h.hora_salida, h.dias_semana, h.conductor_id, h.unidad_id,
         h.vigente_desde, h.vigente_hasta, h.activo,
         (h.effective_from <= now() AND (h.effective_until IS NULL OR h.effective_until > now())) AS vigente
    INTO v_h
    FROM core.horario h
   WHERE h.id = p_horario_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'horario % no existe', p_horario_id;
  END IF;
  IF NOT v_h.activo OR NOT v_h.vigente THEN
    RAISE EXCEPTION 'el horario % no está vigente: no se materializa', p_horario_id;
  END IF;
  IF v_h.conductor_id IS NULL THEN
    RAISE EXCEPTION 'el horario % no tiene conductor: sin él no se resuelve el tipo de unidad ni el mapa (D-7)', p_horario_id;
  END IF;

  -- Cadena D-7: conductor -> tipo_unidad -> mapa. El mapa se copia tal cual esté
  -- AHORA; lo que se materialice hoy queda congelado con este mapa.
  SELECT c.tipo_unidad_id, c.nombre, tu.mapa
    INTO v_tipo_unidad, v_conductor_nombre, v_mapa
    FROM core.conductor c
    JOIN core.tipo_unidad tu ON tu.id = c.tipo_unidad_id
   WHERE c.id = v_h.conductor_id;

  IF v_mapa IS NULL THEN
    RAISE EXCEPTION 'el conductor del horario % no tiene tipo de unidad con mapa', p_horario_id;
  END IF;

  v_horizonte := COALESCE(
    p_dias,
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'horizonte_materializacion_dias' AND effective_from <= now()
      ORDER BY effective_from DESC LIMIT 1),
    90);
  v_desde := COALESCE(p_desde, current_date);
  v_cierre_min := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_cierre_venta' AND effective_from <= now()
      ORDER BY effective_from DESC LIMIT 1),
    15);

  FOR v_dia IN
    SELECT d::date
      FROM generate_series(v_desde, v_desde + v_horizonte, interval '1 day') d
     WHERE extract(isodow FROM d)::smallint = ANY (v_h.dias_semana)
       AND d::date >= COALESCE(v_h.vigente_desde, v_desde)
       AND d::date <= COALESCE(v_h.vigente_hasta, 'infinity'::date)
  LOOP
    INSERT INTO core.salida (horario_id, fecha_operacion, tipo_unidad_id, mapa_snapshot,
                             unidad_id, conductor_id, conductor_nombre_snapshot, estado)
    VALUES (p_horario_id, v_dia, v_tipo_unidad, v_mapa,
            v_h.unidad_id, v_h.conductor_id, v_conductor_nombre, 'programada')
    ON CONFLICT (horario_id, fecha_operacion) DO NOTHING
    RETURNING id INTO v_salida_id;

    v_es_nueva := v_salida_id IS NOT NULL;
    IF NOT v_es_nueva THEN
      ya_existentes := ya_existentes + 1;
      CONTINUE;
    END IF;

    -- Paradas de la salida: hora de paso por parada (no solo la de origen), con
    -- la zona horaria de cada sucursal. El cierre de venta va S4 minutos antes.
    INSERT INTO core.salida_parada (salida_id, sucursal_id, orden,
                                    hora_paso_programada, cierre_venta_en)
    SELECT v_salida_id, rp.sucursal_id, hp.orden,
           (v_dia + hp.hora_paso) AT TIME ZONE s.zona_horaria,
           ((v_dia + hp.hora_paso) AT TIME ZONE s.zona_horaria)
             - make_interval(mins => v_cierre_min)
      FROM core.horario_parada hp
      JOIN core.ruta_parada rp ON rp.id = hp.ruta_parada_id
      JOIN core.sucursal    s  ON s.id  = rp.sucursal_id
     WHERE hp.horario_id = p_horario_id
     ORDER BY hp.orden;

    GET DIAGNOSTICS v_n_paradas = ROW_COUNT;
    IF v_n_paradas = 0 THEN
      sin_paradas := sin_paradas + 1;
    END IF;
    creadas := creadas + 1;
  END LOOP;

  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.materializar_salidas(uuid, integer, date) IS
  'Crea las salidas del horizonte para un horario, con mapa congelado. Job nocturno en la nube. Blueprint §6.1.';
