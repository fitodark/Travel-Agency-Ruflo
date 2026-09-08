-- =============================================================================
-- 0049 · Banderas de ascenso/descenso en búsqueda y venta. Fase 1 de "paradas
--        autorizadas". docs/architecture/05-paradas-autorizadas-tarifas.md §4
--
-- CIERRA: `core.buscar_salidas` keyea por `salida_parada.punto_id` (su `p_origen`
-- / `p_destino` pasan a ser `core.punto_ruta.id`, misma firma uuid) y exige que el
-- origen permita ascenso en la ruta; `core.registrar_venta` / `core.adquirir_lease`
-- rechazan un origen que no permite ascenso (P-1 / D2); `punto_id` NOT NULL en
-- `ruta_parada` y `salida_parada`; se retira el andamiaje de compat de
-- `ruta_parada` (trigger + función de 0048) y su columna `sucursal_id`.
-- `core.asegurar_punto_terminal()` reemplaza el trigger para el camino local.
--
-- NO (Fase 5, plan §5): `DROP COLUMN core.salida_parada.sucursal_id` + retiro de
-- su compat trigger `trg_salida_parada_compat_punto` — lo usan `snapshot_boleto`
-- (0046), `datos_manifiesto`/`salidas_del_dia` (0026), vistas `api.*` (0030) y
-- `src/fleet/abordaje.ts`. Aquí `salida_parada.sucursal_id` pasa a NULLABLE
-- (deprecado pero presente, lo puebla `materializar_salidas` + su compat trigger).
--
-- DEPLOY (D-8): nube + 4 terminales en 0048 antes de 0049, misma ventana. Tras el
-- `DROP COLUMN`, los payloads de `ruta_parada` no traen `sucursal_id`; un nodo en
-- 0048 los ingiere igual (0031 toma columnas reales) y su compat trigger no
-- dispara porque el payload trae `punto_id`.
-- =============================================================================


-- 1. Helper de identidad del punto terminal de una sucursal. Reemplaza el compat
--    trigger de `ruta_parada` (0048): `crearRuta` y los fixtures lo llaman.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.asegurar_punto_terminal(p_sucursal_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := md5('core.punto_ruta:' || p_sucursal_id::text)::uuid;
BEGIN
  INSERT INTO core.punto_ruta (id, nombre, tipo, sucursal_id, zona_horaria)
  SELECT v_id, s.nombre, 'terminal', s.id, s.zona_horaria
    FROM core.sucursal s WHERE s.id = p_sucursal_id
  ON CONFLICT (id) DO NOTHING;
  RETURN v_id;
END $$;

COMMENT ON FUNCTION core.asegurar_punto_terminal(uuid) IS
  'Devuelve (creando si falta) el punto_ruta terminal de una sucursal. id determinista md5(). Reemplaza el compat trigger de 0048 para el camino de escritura local. 05 §4 Fase 1.';


-- ---------------------------------------------------------------------------
-- 2. Backfill de red de `punto_id` (defensivo: el compat trigger de 0048 ya lo
--    pobló en INSERT/ingest). Bajo `donaji.replicando` para no sellar HLC/outbox.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);

  UPDATE core.ruta_parada
     SET punto_id = md5('core.punto_ruta:' || sucursal_id::text)::uuid
   WHERE punto_id IS NULL AND sucursal_id IS NOT NULL;

  UPDATE core.salida_parada
     SET punto_id = md5('core.punto_ruta:' || sucursal_id::text)::uuid
   WHERE punto_id IS NULL AND sucursal_id IS NOT NULL;

  PERFORM set_config('donaji.replicando', 'off', true);
END $$;


-- ---------------------------------------------------------------------------
-- 3. `punto_id` NOT NULL. Si esto peta hay una fila punto_id NULL / sucursal_id
--    NULL real = bug de datos que hay que investigar, no silenciar.
--    `salida_parada.sucursal_id` deja de ser obligatorio: una parada de solo
--    descenso (Fase 4) viaja sin sucursal. Su `DROP COLUMN` + el retiro del
--    compat trigger de `salida_parada` + el re-cableo de `snapshot_boleto` /
--    manifiesto / `api.*` / `abordaje.ts` se hacen juntos en Fase 5.
-- ---------------------------------------------------------------------------
ALTER TABLE core.ruta_parada   ALTER COLUMN punto_id SET NOT NULL;
ALTER TABLE core.salida_parada ALTER COLUMN punto_id SET NOT NULL;
ALTER TABLE core.salida_parada ALTER COLUMN sucursal_id DROP NOT NULL;


-- ---------------------------------------------------------------------------
-- 4. Retirar SOLO el andamiaje de compat de `ruta_parada`. El de
--    `core.salida_parada` se queda hasta Fase 5.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_aa_compat_punto ON core.ruta_parada;
DROP FUNCTION IF EXISTS core.trg_ruta_parada_compat_punto();


-- ---------------------------------------------------------------------------
-- 5. `DROP COLUMN core.ruta_parada.sucursal_id`. La FK a `core.sucursal` se va
--    con la columna; la unique `(ruta_id, sucursal_id)` ya la dropeó 0048.
--    `ruta_parada_ruta_punto_key (ruta_id, punto_id)` es la unicidad vigente.
-- ---------------------------------------------------------------------------
ALTER TABLE core.ruta_parada DROP COLUMN sucursal_id;


-- ---------------------------------------------------------------------------
-- 6. core.buscar_salidas — misma firma que 0043; `p_origen` / `p_destino` pasan
--    a ser `core.punto_ruta.id`. Los joins van por `salida_parada.punto_id` y el
--    origen debe permitir ascenso en la ruta (D2 / P-1).
-- ---------------------------------------------------------------------------
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
  seleccionable      boolean,
  ruta_nombre        text,
  origen_nombre      text,
  destino_nombre     text,
  escalas            text[]
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
           AND cardinality(ofr.asientos) >= p_n_personas,
         r.nombre,
         puo.nombre,
         pud.nombre,
         COALESCE((
           SELECT array_agg(pux.nombre ORDER BY spx.orden)
             FROM core.salida_parada spx
             JOIN core.punto_ruta pux ON pux.id = spx.punto_id
            WHERE spx.salida_id = s.id
              AND spx.orden > spo.orden
              AND spx.orden < spd.orden
         ), ARRAY[]::text[])
    FROM core.salida s
    JOIN core.salida_parada spo
      ON spo.salida_id = s.id AND spo.punto_id = p_origen
    JOIN core.salida_parada spd
      ON spd.salida_id = s.id AND spd.punto_id = p_destino
    JOIN core.horario h ON h.id = s.horario_id
    JOIN core.ruta    r ON r.id = h.ruta_id
    -- El origen debe permitir ascenso en ESTA ruta (D2 / P-1): una parada de solo
    -- descenso nunca origina una venta.
    -- CAMBIO DE COMPORTAMIENTO (F1-D2): antes no había join a `ruta_parada`, así
    -- que una parada dada de baja (`activo = false`) seguía apareciendo como
    -- origen mientras existiera su `salida_parada`. Ahora `rpo.activo` la quita de
    -- la búsqueda para ese origen — intencional y coherente con D5 (baja lógica
    -- de parada de ruta).
    JOIN core.ruta_parada rpo
      ON rpo.ruta_id = h.ruta_id AND rpo.punto_id = p_origen
     AND rpo.permite_ascenso AND rpo.activo
    JOIN core.punto_ruta puo ON puo.id = p_origen
    JOIN core.punto_ruta pud ON pud.id = p_destino
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
     AND h.activo
     AND r.activo
     AND s.fecha_operacion = p_fecha
     AND s.estado = 'programada'
     AND spo.orden < spd.orden
   ORDER BY spo.hora_paso_programada, r.nombre
$$;

COMMENT ON FUNCTION core.buscar_salidas(date, uuid, uuid, integer, uuid, boolean, timestamptz) IS
  'Paso 2 del flujo de venta: salidas del día origen→destino (origen/destino = core.punto_ruta.id) con ruta, escalas, disponibilidad por tramo y tarifa. El origen debe permitir ascenso. Blueprint F4 · 05 §4.';


-- ---------------------------------------------------------------------------
-- 7. core.registrar_venta — copia vigente de 0023 + validación de que el orden
--    de origen permita ascenso en la ruta (P-1 / D2).
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
  v_tramo := int4range(p_origen_orden, p_destino_orden);

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
    -- El efectivo cuenta al instante; la transferencia, al verificarse (02b §2.2).
    v_pagado := CASE WHEN v_metodo = 'efectivo' THEN v_monto ELSE 0 END;
  END IF;

  v_saldo     := v_importe_total - v_pagado;
  v_liquidada := v_saldo <= 0;
  -- Prioridad de arbitraje (S2), mayor = más difícil de revertir. El cálculo
  -- canónico lo hace la reconciliación (F4 slice 4); esto es el valor inicial.
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
    INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos,
                             pasajero_nombre, importe, estado)
    VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_id, v_asiento, v_tramo,
            v_nombre, v_imp, 'emitido')
    RETURNING id INTO v_boleto_id;

    BEGIN
      INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, boleto_id,
                                          estado, sucursal_id, emitido_en, prioridad)
      VALUES (core.uuid_v7(), p_salida_id, v_asiento, v_tramo, v_boleto_id,
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
  'Registra una venta o reservación: N boletos con folio, N ocupaciones firmes, pago opcional. Valida que el origen permita ascenso (P-1). Blueprint F4 pasos 4-6 · 05 §4.';


-- ---------------------------------------------------------------------------
-- 8. core.adquirir_lease — copia vigente de 0022 + la misma validación de
--    ascenso sobre `p_desde`.
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

  -- Limpia leases vencidos de ESTE asiento para que no bloqueen por la constraint.
  -- Alias `al`: el OUT param `expira_en` haría ambigua la columna sin calificar.
  UPDATE core.asiento_lease AS al
     SET liberado_en = al.expira_en
   WHERE al.salida_id = p_salida_id
     AND al.asiento_num = p_asiento_num
     AND al.consumido_por_boleto_id IS NULL
     AND al.liberado_en IS NULL
     AND al.expira_en <= p_ahora;

  -- Ocupación firme que solapa: el asiento está vendido, no se puede reservar.
  IF EXISTS (
    SELECT 1 FROM core.asiento_ocupacion o
     WHERE o.salida_id = p_salida_id
       AND o.asiento_num = p_asiento_num
       AND o.estado = 'firme'
       AND o.tramos && int4range(p_desde, p_hasta)
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
      (salida_id, asiento_num, tramos, sucursal_id, otorgado_en, expira_en)
    VALUES
      (p_salida_id, p_asiento_num, int4range(p_desde, p_hasta), p_sucursal_id,
       p_ahora, v_exp)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    -- Otro lease vivo ya cubre este asiento en un tramo que solapa.
    estado := 'lease_ajeno'; RETURN NEXT; RETURN;
  END;

  estado := 'otorgado'; lease_id := v_id; expira_en := v_exp;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.adquirir_lease(uuid, smallint, integer, integer, uuid, integer, timestamptz) IS
  'Pide un lease de asiento (paso 3 con conexión). Devuelve otorgado/ocupado/lease_ajeno. El origen debe permitir ascenso (P-1). Blueprint 01b §5 · 05 §4.';
