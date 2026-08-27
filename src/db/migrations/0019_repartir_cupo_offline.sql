-- =============================================================================
-- 0019 · Reparto de cupo offline por bloques contiguos.
-- Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §3
--                  docs/architecture/04-riesgos-roadmap.md §3 (F3, criterio 2)
--
-- MECANISMO 1 contra la sobreventa offline: al materializar una salida, sus
-- asientos se reparten entre las sucursales que venden, en CONJUNTOS DISJUNTOS.
-- Sin conexión, una sucursal solo puede vender los suyos; los demás salen en
-- gris. La sobreventa deja de ser "improbable" y pasa a ser IMPOSIBLE por
-- construcción.
--
-- Se reparten BLOQUES CONTIGUOS COMPLETOS (filas o banca), nunca asientos
-- sueltos de filas distintas: si a una intermedia le tocaran {3, 9, 16}, una
-- pareja quedaría separada aunque la unidad fuera casi vacía.
--
-- Reparto v1 (§3.3): cada parada intermedia recibe UNA fila completa; el origen
-- se queda con el resto, incluida la banca trasera de 4 (el único bloque para un
-- grupo familiar). Ponderar por `ruta_parada.peso_cupo` según demanda histórica
-- es v2 y no se implementa aquí.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.repartir_cupo_offline(p_salida_id uuid)
RETURNS integer   -- nº de sucursales con cupo asignado
LANGUAGE plpgsql AS $$
DECLARE
  v_mapa          jsonb;
  v_bloques       jsonb[];
  v_n_bloques     integer;
  v_n_paradas     integer;
  v_n_intermedias integer;
  v_expira_h      integer;
  v_i             integer;
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

  SELECT count(*)::int INTO v_n_paradas
    FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF v_n_paradas < 2 THEN
    RAISE EXCEPTION 'la salida % tiene menos de dos paradas', p_salida_id;
  END IF;
  v_n_intermedias := v_n_paradas - 2;   -- sin origen ni destino

  IF v_n_bloques - v_n_intermedias < 1 THEN
    RAISE EXCEPTION
      'reparto por bloques insuficiente: % paradas vendedoras para % bloques (01b §3.5)',
      v_n_paradas - 1, v_n_bloques;
  END IF;

  v_expira_h := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'horas_expiracion_cupo' AND effective_from <= now()
      ORDER BY effective_from DESC LIMIT 1),
    4);

  -- Empezar de cero: un reparto nuevo (p. ej. tras un cambio de conductor) manda.
  DELETE FROM core.cupo_offline WHERE salida_id = p_salida_id;

  FOR v_i IN 0 .. v_n_paradas - 2 LOOP   -- vendedoras: orden 0 .. n-2
    IF v_i = 0 THEN
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
        FROM core.salida_parada WHERE salida_id = p_salida_id AND orden = 0;
    ELSE
      -- INTERMEDIA i: el bloque en (n_bloques - n_intermedias - 1 + i).
      v_bloque_idx := v_n_bloques - v_n_intermedias - 1 + v_i;
      SELECT array_agg(s::smallint ORDER BY s::smallint),
             ARRAY[v_bloques[v_bloque_idx]->>'clave']
        INTO v_asientos, v_claves
        FROM jsonb_array_elements_text(v_bloques[v_bloque_idx]->'asientos') AS s;
      -- SUPUESTO S5: los no vendidos regresan al pool a T-Nh de su propio paso.
      SELECT hora_paso_programada - make_interval(hours => v_expira_h)
        INTO v_vigente_hasta
        FROM core.salida_parada WHERE salida_id = p_salida_id AND orden = v_i;
    END IF;

    INSERT INTO core.cupo_offline (salida_id, sucursal_id, asientos, bloques, tramos,
                                   vigente_desde, vigente_hasta)
    SELECT p_salida_id, sp.sucursal_id, v_asientos, v_claves,
           int4range(v_i, v_n_paradas - 1), now(), v_vigente_hasta
      FROM core.salida_parada sp
     WHERE sp.salida_id = p_salida_id AND sp.orden = v_i;

    v_asignadas := v_asignadas + 1;
  END LOOP;

  RETURN v_asignadas;
END $$;

COMMENT ON FUNCTION core.repartir_cupo_offline(uuid) IS
  'Reparte los asientos de una salida en cupos disjuntos por bloques contiguos. Blueprint 01b §3.';


-- -----------------------------------------------------------------------------
-- La materialización reparte el cupo de cada salida nueva (§6.1 paso 3).
-- -----------------------------------------------------------------------------
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
    ELSE
      PERFORM core.repartir_cupo_offline(v_salida_id);
    END IF;
    creadas := creadas + 1;
  END LOOP;

  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.materializar_salidas(uuid, integer, date) IS
  'Crea las salidas del horizonte para un horario, con mapa congelado y cupo repartido. Job nocturno en la nube. Blueprint §6.1.';
