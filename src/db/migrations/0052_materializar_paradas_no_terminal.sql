-- =============================================================================
-- 0052 · Materialización y cupo offline con paradas no-terminal. Fase 4 de
--        "paradas autorizadas". docs/architecture/05-paradas-autorizadas-tarifas.md §4.
--
-- Hasta 0051 `core.materializar_salidas` solo escribía `salida_parada` para las
-- paradas con fila en `core.horario_parada` — es decir, las terminales. Una
-- parada de solo descenso (o de solo ascenso) nunca llegaba a `salida_parada`,
-- así que no se podía vender un boleto hacia ella (los lookups de
-- `registrar_venta` por `orden` fallaban).
--
-- 0052:
--   - `materializar_salidas` escribe UNA fila de `salida_parada` por cada
--     `core.ruta_parada` de la ruta. Las que no tienen `horario_parada`
--     (paradas no-terminal) entran con `hora_paso_programada` y
--     `cierre_venta_en` en NULL (D6). El `orden` sale de `ruta_parada.orden`
--     y queda contiguo 0..n-1.
--   - `repartir_cupo_offline` reparte cupo SOLO entre terminales con ascenso.
--     Las paradas (`punto_ruta.tipo='parada'`) no entran al reparto ni reciben
--     bloque — no tienen `sucursal_id` (`core.cupo_offline.sucursal_id` es
--     NOT NULL) y nadie vende desde ellas de todos modos.
--
-- F2-Q1 (verificado): con las paradas ya materializadas, `core.tramo_ocupacion`
-- (0050) queda vivo por venta real. `max(orden)` en el helper sigue siendo la
-- última `salida_parada` = terminal destino (D5), así que el rango de ocupación
-- de un boleto a una parada de descenso llega al fin real de la ruta.
--
-- F3-D2 (diferido a Fase 5): el guard de descuento de `registrar_venta` es por
-- `orden` (`destino = n-1`), no por `tipo='terminal'`. Correcto mientras las
-- rutas siempre terminen en terminal (D5, lo enforcea `crearRuta` en Fase 5) —
-- se reescribe por `tipo` ahí, junto con la validación de alta de ruta.
--
-- DEPLOY: `0050`+`0051`+`0052` van juntos a nube + 4 terminales (nube en 0049).
-- `0052` no agrega esquema — solo `CREATE OR REPLACE` de dos funciones — así que
-- no necesita nada para el ingest.
-- =============================================================================


-- 1. core.materializar_salidas — el INSERT de `salida_parada` pasa de
--    `horario_parada` a `ruta_parada LEFT JOIN horario_parada`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.materializar_salidas(
  p_horario_id uuid,
  p_dias       integer DEFAULT NULL,
  p_desde      date    DEFAULT NULL
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

    IF v_salida_id IS NULL THEN
      ya_existentes := ya_existentes + 1;
      CONTINUE;
    END IF;

    -- Paradas de la salida: UNA por cada `ruta_parada` de la ruta. Las que
    -- tienen `horario_parada` (terminales / paradas de ascenso con horario)
    -- llevan hora de paso y cierre de venta; las que no (paradas no-terminal
    -- sin horario) entran con ambos en NULL — D6. El `orden` sale de
    -- `ruta_parada.orden` y queda contiguo.
    INSERT INTO core.salida_parada (salida_id, sucursal_id, punto_id, orden,
                                    hora_paso_programada, cierre_venta_en)
    SELECT v_salida_id, pr.sucursal_id, pr.id, rp.orden,
           CASE WHEN hp.hora_paso IS NOT NULL
                THEN (v_dia + hp.hora_paso) AT TIME ZONE pr.zona_horaria END,
           CASE WHEN hp.hora_paso IS NOT NULL
                THEN ((v_dia + hp.hora_paso) AT TIME ZONE pr.zona_horaria)
                       - make_interval(mins => v_cierre_min) END
      FROM core.ruta_parada rp
      JOIN core.punto_ruta  pr ON pr.id = rp.punto_id
      LEFT JOIN core.horario_parada hp
        ON hp.ruta_parada_id = rp.id AND hp.horario_id = p_horario_id
     WHERE rp.ruta_id = v_h.ruta_id
       AND rp.activo
     ORDER BY rp.orden;

    GET DIAGNOSTICS v_n_paradas = ROW_COUNT;
    IF v_n_paradas = 0 THEN
      sin_paradas := sin_paradas + 1;
    ELSE
      PERFORM core.repartir_cupo_offline(v_salida_id);
    END IF;
    creadas := creadas + 1;
  END LOOP;

  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.materializar_salidas(uuid, integer, date) IS
  'Crea las salidas del horizonte con mapa congelado y cupo repartido. Una salida_parada por ruta_parada; las paradas no-terminal entran sin hora. Job nocturno en la nube. Blueprint §6.1 · 05 §4.';


-- 2. core.repartir_cupo_offline — solo las terminales con ascenso venden.
--    Las paradas (`punto_ruta.tipo='parada'`) no entran al reparto.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.repartir_cupo_offline(p_salida_id uuid)
RETURNS integer   -- nº de sucursales con cupo asignado
LANGUAGE plpgsql AS $$
DECLARE
  v_mapa          jsonb;
  v_bloques       jsonb[];
  v_n_bloques     integer;
  v_max_orden     smallint;
  v_ordenes       smallint[];   -- órdenes de las terminales que VENDEN (origen + intermedias)
  v_n_vendedoras  integer;
  v_n_intermedias integer;      -- vendedoras sin el origen
  v_expira_h      integer;
  v_pos           integer;
  v_orden         smallint;
  v_bloque_idx    integer;
  v_asientos      smallint[];
  v_claves        text[];
  v_vigente_hasta timestamptz;
  v_asignadas     integer := 0;
BEGIN
  SELECT s.mapa_snapshot INTO v_mapa FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salida % no existe', p_salida_id;
  END IF;

  IF v_mapa->'bloques' IS NULL OR jsonb_array_length(v_mapa->'bloques') = 0 THEN
    RAISE EXCEPTION 'el mapa de la salida % no define bloques', p_salida_id;
  END IF;

  SELECT array_agg(b ORDER BY ord) INTO v_bloques
    FROM jsonb_array_elements(v_mapa->'bloques') WITH ORDINALITY AS t(b, ord);
  v_n_bloques := array_length(v_bloques, 1);

  SELECT max(orden) INTO v_max_orden
    FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF v_max_orden IS NULL OR v_max_orden < 1 THEN
    RAISE EXCEPTION 'la salida % tiene menos de dos paradas', p_salida_id;
  END IF;

  -- Vendedoras: terminales con ascenso, sin la última parada (el destino no vende).
  SELECT array_agg(sp.orden ORDER BY sp.orden) INTO v_ordenes
    FROM core.salida_parada sp
    JOIN core.salida sa      ON sa.id = sp.salida_id
    JOIN core.horario h      ON h.id  = sa.horario_id
    JOIN core.ruta_parada rp ON rp.ruta_id = h.ruta_id AND rp.punto_id = sp.punto_id
    JOIN core.punto_ruta pr  ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id
     AND pr.tipo = 'terminal'
     AND rp.permite_ascenso
     AND sp.orden < v_max_orden;

  v_n_vendedoras  := COALESCE(array_length(v_ordenes, 1), 0);
  IF v_n_vendedoras = 0 THEN
    RAISE EXCEPTION 'la salida % no tiene terminales que vendan', p_salida_id;
  END IF;
  v_n_intermedias := v_n_vendedoras - 1;   -- sin el origen

  IF v_n_bloques - v_n_intermedias < 1 THEN
    RAISE EXCEPTION
      'reparto por bloques insuficiente: % terminales vendedoras para % bloques (01b §3.5)',
      v_n_vendedoras, v_n_bloques;
  END IF;

  v_expira_h := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'horas_expiracion_cupo' AND effective_from <= now()
      ORDER BY effective_from DESC LIMIT 1),
    4);

  -- Empezar de cero: un reparto nuevo (p. ej. tras un cambio de conductor) manda.
  DELETE FROM core.cupo_offline WHERE salida_id = p_salida_id;

  FOR v_pos IN 1 .. v_n_vendedoras LOOP
    v_orden := v_ordenes[v_pos];

    IF v_pos = 1 THEN
      -- ORIGEN: bloques del frente que no se llevó ninguna intermedia + la banca.
      SELECT array_agg(a ORDER BY a), array_agg(DISTINCT c ORDER BY c)
        INTO v_asientos, v_claves
        FROM (
          SELECT s::smallint AS a, (v_bloques[k]->>'clave') AS c
            FROM generate_series(1, v_n_bloques - 1 - v_n_intermedias) AS k,
                 jsonb_array_elements_text(v_bloques[k]->'asientos') AS s
          UNION ALL
          SELECT s::smallint, (v_bloques[v_n_bloques]->>'clave')
            FROM jsonb_array_elements_text(v_bloques[v_n_bloques]->'asientos') AS s
        ) q;
      SELECT cierre_venta_en INTO v_vigente_hasta
        FROM core.salida_parada WHERE salida_id = p_salida_id AND orden = v_orden;
    ELSE
      -- INTERMEDIA (v_pos - 1)-ésima: el bloque en (n_bloques - n_intermedias - 1 + i).
      v_bloque_idx := v_n_bloques - v_n_intermedias - 1 + (v_pos - 1);
      SELECT array_agg(s::smallint ORDER BY s::smallint),
             ARRAY[v_bloques[v_bloque_idx]->>'clave']
        INTO v_asientos, v_claves
        FROM jsonb_array_elements_text(v_bloques[v_bloque_idx]->'asientos') AS s;
      -- SUPUESTO S5: los no vendidos regresan al pool a T-Nh de su propio paso.
      SELECT hora_paso_programada - make_interval(hours => v_expira_h)
        INTO v_vigente_hasta
        FROM core.salida_parada WHERE salida_id = p_salida_id AND orden = v_orden;
    END IF;

    INSERT INTO core.cupo_offline (salida_id, sucursal_id, asientos, bloques, tramos,
                                   vigente_desde, vigente_hasta)
    SELECT p_salida_id, sp.sucursal_id, v_asientos, v_claves,
           int4range(v_orden, v_max_orden), now(), v_vigente_hasta
      FROM core.salida_parada sp
     WHERE sp.salida_id = p_salida_id AND sp.orden = v_orden;

    v_asignadas := v_asignadas + 1;
  END LOOP;

  RETURN v_asignadas;
END $$;

COMMENT ON FUNCTION core.repartir_cupo_offline(uuid) IS
  'Reparte los asientos de una salida en cupos disjuntos por bloques contiguos, solo entre terminales con ascenso. Las paradas no-terminal no reciben cupo. Blueprint 01b §3 · 05 §4.';
