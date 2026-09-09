-- =============================================================================
-- 0055 · Retiro de `core.salida_parada.sucursal_id`. Fase 5b de "paradas
--        autorizadas". docs/architecture/05-paradas-autorizadas-tarifas.md §4-§5.
--
-- QUÉ RESUELVE. Es el último uso estructural de `sucursal_id` en el eje de
-- paradas. Desde 0048 la columna está deprecada y poblada en paralelo con
-- `punto_id` (NOT NULL desde 0049). 0053/0054 ya movieron `snapshot_boleto`,
-- `salidas_del_dia`, `datos_manifiesto`, `generar_manifiestos` y `abordaje.ts`
-- a `core.punto_ruta`. Quedaban tres lectores y dos escritores:
--   * `core.materializar_salidas` (escribe `salida_parada.sucursal_id`),
--   * `core.trg_salida_parada_compat_punto` (deriva `punto_id` de `sucursal_id`),
--   * `core.repartir_cupo_offline` (lee `sp.sucursal_id` para `cupo_offline`),
--   * `api.v1_boleto` / `api.v1_salida` / `api.v1_venta` (JOIN a `core.sucursal`
--     por `sp.sucursal_id` para el nombre de origen/destino — se rompían para
--     boletos cuyo origen/destino es una parada no-terminal, F4-D1 en el eje API).
--
-- CÓMO. Re-emite los dos primeros sin la columna, re-cablea `repartir_cupo_offline`
-- y las vistas `api.*` vía `core.punto_ruta`, retira el compat trigger de
-- `salida_parada` y hace `DROP COLUMN`.
--
-- PRECONDICIÓN DE DEPLOY (ventana coordinada, D-8). Aplicar SOLO cuando la nube y
-- las 4 terminales estén en 0054. Una vez la nube corre 0055, los `salida_parada`
-- que emite no llevan `sucursal_id`; un nodo que todavía lea esa columna
-- (`< 0053`) tendría manifiestos / tickets / vistas API rotos. `punto_id` viaja
-- en el payload desde 0048, así que el orden nube-primero es seguro para los
-- nodos ya en 0054.
--
-- FUERA DE 5b (sub-PRs siguientes):
--   * F2-D3: retiro de `trg_aa_tramos_ocupacion_compat` (precondición propia:
--     los 5 nodos en >= 0050). Sigue load-bearing, no se toca aquí.
--   * F3-D2: guard de descuento de `registrar_venta` por `tipo='terminal'` +
--     extremo de ruta en vez de por `orden` — va con `crearRuta` (5c). Hoy es
--     equivalente (D2 garantiza terminal en los extremos), es una limpieza.
--   * F4-D2: `crearRuta` assert de `ruta_parada.orden` contiguo 0..n-1 (5c).
--
-- DEPLOY: `CREATE OR REPLACE` de 2 funciones + 3 vistas, 2 `DROP` y 1 `DROP
-- COLUMN`. Sin datos que migrar (la columna ya no la usa nadie tras los REPLACE).
-- =============================================================================


-- 1. `core.materializar_salidas` — deja de escribir `salida_parada.sucursal_id`.
--    Idéntica a la de 0052 salvo el INSERT de paradas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.materializar_salidas(
  p_horario_id uuid,
  p_dias       integer DEFAULT NULL,
  p_desde      date    DEFAULT NULL
)
RETURNS TABLE(creadas integer, ya_existentes integer, sin_paradas integer)
LANGUAGE plpgsql AS $function$
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
    -- tienen `horario_parada` llevan hora de paso y cierre de venta; las que no
    -- (paradas no-terminal) entran con ambos en NULL — D6. El `orden` sale de
    -- `ruta_parada.orden` y queda contiguo. `sucursal_id` se retiró en 0055: la
    -- sucursal de una terminal se resuelve por `punto_ruta`.
    INSERT INTO core.salida_parada (salida_id, punto_id, orden,
                                    hora_paso_programada, cierre_venta_en)
    SELECT v_salida_id, pr.id, rp.orden,
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
END $function$;

COMMENT ON FUNCTION core.materializar_salidas(uuid, integer, date) IS
  'Materializa salidas del horizonte para un horario. Una salida_parada por ruta_parada activa (paradas no-terminal sin hora, D6). Sin salida_parada.sucursal_id (0055). 05 §4.';


-- 2. `core.repartir_cupo_offline` — lee la sucursal de la terminal vía
--    `core.punto_ruta`, no `salida_parada.sucursal_id`. El bucle solo itera
--    terminales con ascenso, así que el JOIN es INNER y `pr.sucursal_id` nunca
--    es NULL. Idéntica a la de 0052 salvo el INSERT final.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.repartir_cupo_offline(p_salida_id uuid)
RETURNS integer
LANGUAGE plpgsql AS $function$
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
    SELECT p_salida_id, pr.sucursal_id, v_asientos, v_claves,
           int4range(v_orden, v_max_orden), now(), v_vigente_hasta
      FROM core.salida_parada sp
      JOIN core.punto_ruta pr ON pr.id = sp.punto_id
     WHERE sp.salida_id = p_salida_id AND sp.orden = v_orden;

    v_asignadas := v_asignadas + 1;
  END LOOP;

  RETURN v_asignadas;
END $function$;

COMMENT ON FUNCTION core.repartir_cupo_offline(uuid) IS
  'Reparto de cupo offline por bloques entre las terminales con ascenso. Sucursal de la terminal vía core.punto_ruta (0055). 01b §3.5 / 05 §4.';


-- 3. Vistas `api.*` — nombre de origen/destino desde `core.punto_ruta`, no
--    `core.sucursal`. Así una parada no-terminal (sin `sucursal_id`) también
--    aparece con su nombre. Mismas columnas de salida (contrato API estable).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW api.v1_boleto AS
SELECT b.folio,
       b.pasajero_nombre,
       b.asiento_num,
       b.estado,
       pr_o.nombre AS sucursal_origen,
       pr_d.nombre AS sucursal_destino,
       sp_o.hora_paso_programada AS fecha_hora_viaje,
       b.importe,
       v.es_reservacion,
       b.creado_en
  FROM core.boleto b
  JOIN core.venta v          ON v.id = b.venta_id
  JOIN core.salida sa        ON sa.id = b.salida_id
  JOIN core.salida_parada sp_o ON sp_o.salida_id = sa.id AND sp_o.orden = v.parada_origen_orden
  JOIN core.salida_parada sp_d ON sp_d.salida_id = sa.id AND sp_d.orden = v.parada_destino_orden
  JOIN core.punto_ruta pr_o  ON pr_o.id = sp_o.punto_id
  JOIN core.punto_ruta pr_d  ON pr_d.id = sp_d.punto_id
 WHERE b.activo;

CREATE OR REPLACE VIEW api.v1_salida AS
SELECT sa.id,
       sa.fecha_operacion,
       sa.estado,
       sa.conductor_nombre_snapshot AS conductor,
       tu.clave AS tipo_unidad,
       pr_o.nombre AS origen,
       pr_d.nombre AS destino,
       spo_o.hora_paso_programada AS hora_salida,
       sa.salida_real_en
  FROM core.salida sa
  JOIN core.tipo_unidad tu     ON tu.id = sa.tipo_unidad_id
  JOIN core.salida_parada spo_o ON spo_o.salida_id = sa.id AND spo_o.orden = 0
  JOIN core.salida_parada spo_d ON spo_d.salida_id = sa.id AND spo_d.orden = (
         SELECT max(salida_parada.orden) FROM core.salida_parada
          WHERE salida_parada.salida_id = sa.id)
  JOIN core.punto_ruta pr_o    ON pr_o.id = spo_o.punto_id
  JOIN core.punto_ruta pr_d    ON pr_d.id = spo_d.punto_id
 WHERE sa.activo;

CREATE OR REPLACE VIEW api.v1_venta AS
SELECT v.id,
       so.nombre AS sucursal_venta,
       v.es_reservacion,
       v.estado,
       v.importe_total,
       vs.pagado,
       vs.saldo_pendiente,
       spo_o.hora_paso_programada AS fecha_hora_viaje,
       pr_o.nombre AS origen,
       pr_d.nombre AS destino,
       v.creado_en
  FROM core.venta v
  JOIN core.sucursal so        ON so.id = v.sucursal_venta_id
  JOIN core.v_venta_saldo vs   ON vs.venta_id = v.id
  JOIN core.salida sa          ON sa.id = v.salida_id
  JOIN core.salida_parada spo_o ON spo_o.salida_id = sa.id AND spo_o.orden = v.parada_origen_orden
  JOIN core.salida_parada spo_d ON spo_d.salida_id = sa.id AND spo_d.orden = v.parada_destino_orden
  JOIN core.punto_ruta pr_o    ON pr_o.id = spo_o.punto_id
  JOIN core.punto_ruta pr_d    ON pr_d.id = spo_d.punto_id
 WHERE v.activo;


-- 4. Retirar el andamiaje de compat de `core.salida_parada` (0048).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_aa_compat_punto ON core.salida_parada;
DROP FUNCTION IF EXISTS core.trg_salida_parada_compat_punto();


-- 5. `DROP COLUMN core.salida_parada.sucursal_id`. La FK a `core.sucursal` se va
--    con la columna. `salida_parada_salida_orden_key (salida_id, orden)` sigue
--    siendo la unicidad vigente.
-- ---------------------------------------------------------------------------
ALTER TABLE core.salida_parada DROP COLUMN sucursal_id;
