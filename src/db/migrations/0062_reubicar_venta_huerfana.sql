-- =============================================================================
-- 0062 · Reubicación de una venta huérfana completa (familias multi-boleto, N-14).
--        docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D12) / §7.3 (N-14)
--        / "Notas del review de Fase 6" (F6-D2).
--
-- CONTEXTO. `core.reubicar_huerfano` (`0060`/`0061`) solo reubica ventas de UN
-- boleto — para una venta multi-boleto (una familia que compró varios asientos en
-- una sola venta) traspasar el pago boleto a boleto rompe la contabilidad, así que
-- `0061` la rechaza. Esta función reubica la venta ENTERA en una sola operación:
-- emite una venta nueva con todos los boletos, traspasa el/los `core.pago` una
-- vez, y cierra la venta vieja.
--
-- N-14 (igual que la versión de un boleto):
--   * la venta huérfana YA PAGÓ (`pagado > 0`) ⇒ cada boleto nuevo se emite al
--     importe del boleto viejo correspondiente (se mantiene el precio); el/los
--     `core.pago` se traspasan a la venta nueva — sin mover efectivo.
--   * SIN pagar ⇒ cada boleto nuevo se emite a la tarifa vigente de la ruta nueva
--     para su tramo y categoría; la venta nueva queda `pendiente`.
--
-- Los boletos viejos quedan `estado='reasignado', activo=false` (F6-D1) y sus
-- asientos liberados; la venta vieja `cancelada`.
--
-- DEPLOY. 1 función nueva. Sin datos que migrar, sin ventana coordinada.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.reubicar_venta_huerfana(
  p_venta_vieja_id  uuid,
  p_salida_nueva_id uuid,
  -- [{ "boleto_viejo_id": uuid, "origen_orden": int, "destino_orden": int,
  --    "asiento_num": int }, ...] — una por cada boleto vivo de la venta vieja.
  p_asignaciones    jsonb,
  p_usuario_id      uuid,
  p_sucursal_id     uuid,
  p_ahora           timestamptz DEFAULT now()
)
RETURNS TABLE (
  venta_nueva_id   uuid,
  importe_total    numeric,
  pagado           numeric,
  saldo_pendiente  numeric,
  precio_mantenido boolean,
  boletos          jsonb,
  print_jobs       integer
)
LANGUAGE plpgsql AS $function$
DECLARE
  v_vv            core.venta%ROWTYPE;
  v_bo            core.boleto%ROWTYPE;
  v_vivos         uuid[];
  v_asig_ids      uuid[];
  v_pagado        numeric;
  v_mantiene      boolean;
  v_ruta_nueva    uuid;
  v_n_paradas     integer;
  v_estado_sal    text;
  v_mapa          jsonb;
  v_cierre        timestamptz;
  v_a             jsonb;
  v_bid           uuid;
  v_orig          integer;
  v_dest          integer;
  v_asiento       smallint;
  v_imp_nuevo     numeric;
  v_total         numeric := 0;
  v_plan          jsonb := '[]'::jsonb;
  v_saldo         numeric;
  v_liquidada     boolean;
  v_venta_id      uuid;
  v_boleto_id     uuid;
  v_folio         char(6);
  v_tramo         int4range;
  v_tramo_ocup    int4range;
  v_boletos       jsonb := '[]'::jsonb;
  v_print_jobs    integer := 0;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.reubicar_venta_huerfana no se ejecuta durante la replicación';
  END IF;

  SELECT * INTO v_vv FROM core.venta WHERE id = p_venta_vieja_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la venta % no existe', p_venta_vieja_id;
  END IF;
  IF v_vv.estado = 'cancelada' THEN
    RAISE EXCEPTION 'la venta % ya está cancelada', p_venta_vieja_id;
  END IF;

  IF p_asignaciones IS NULL OR jsonb_typeof(p_asignaciones) <> 'array'
     OR jsonb_array_length(p_asignaciones) = 0 THEN
    RAISE EXCEPTION 'faltan las asignaciones de asiento';
  END IF;

  -- Las asignaciones deben cubrir EXACTAMENTE los boletos vivos de la venta,
  -- una vez cada uno (si no, el pago se traspasaría dejando boletos huérfanos).
  SELECT array_agg(id ORDER BY id) INTO v_vivos
    FROM core.boleto
   WHERE venta_id = p_venta_vieja_id AND activo AND estado = 'emitido';
  SELECT array_agg(x ORDER BY x) INTO v_asig_ids
    FROM (SELECT DISTINCT (e->>'boleto_viejo_id')::uuid AS x
            FROM jsonb_array_elements(p_asignaciones) e) q;

  IF v_vivos IS NULL THEN
    RAISE EXCEPTION 'la venta % no tiene boletos emitidos que reubicar', p_venta_vieja_id;
  END IF;
  IF v_vivos IS DISTINCT FROM v_asig_ids
     OR jsonb_array_length(p_asignaciones) <> array_length(v_vivos, 1) THEN
    RAISE EXCEPTION 'las asignaciones deben cubrir exactamente los % boletos vivos de la venta, una vez cada uno',
      array_length(v_vivos, 1);
  END IF;

  -- Salida destino.
  SELECT s.estado, s.mapa_snapshot INTO v_estado_sal, v_mapa
    FROM core.salida s WHERE s.id = p_salida_nueva_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida nueva % no existe', p_salida_nueva_id;
  END IF;
  IF v_estado_sal <> 'programada' THEN
    RAISE EXCEPTION 'la salida nueva % está % : no admite reubicación', p_salida_nueva_id, v_estado_sal;
  END IF;

  SELECT count(*)::int INTO v_n_paradas
    FROM core.salida_parada WHERE salida_id = p_salida_nueva_id;

  SELECT h.ruta_id INTO v_ruta_nueva
    FROM core.salida sa JOIN core.horario h ON h.id = sa.horario_id
   WHERE sa.id = p_salida_nueva_id;

  SELECT COALESCE(vs.pagado, 0) INTO v_pagado
    FROM core.v_venta_saldo vs WHERE vs.venta_id = v_vv.id;
  v_mantiene := v_pagado > 0;

  -- F6-D4: libera reservas caducas de la salida destino antes de tomar asientos.
  PERFORM core.liberar_reservas_caducas(p_salida_nueva_id, p_ahora);

  -- 1ª pasada: validar cada asignación y calcular el importe nuevo por boleto.
  FOR v_a IN SELECT * FROM jsonb_array_elements(p_asignaciones) LOOP
    v_bid     := (v_a->>'boleto_viejo_id')::uuid;
    v_orig    := (v_a->>'origen_orden')::int;
    v_dest    := (v_a->>'destino_orden')::int;
    v_asiento := (v_a->>'asiento_num')::smallint;

    SELECT * INTO v_bo FROM core.boleto WHERE id = v_bid;

    IF v_orig < 0 OR v_dest <= v_orig OR v_dest > v_n_paradas - 1 THEN
      RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
        v_orig, v_dest, p_salida_nueva_id, v_n_paradas;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM core.salida_parada sp
        JOIN core.ruta_parada rp ON rp.ruta_id = v_ruta_nueva AND rp.punto_id = sp.punto_id
       WHERE sp.salida_id = p_salida_nueva_id AND sp.orden = v_orig
         AND rp.permite_ascenso AND rp.activo
    ) THEN
      RAISE EXCEPTION 'la parada de origen (orden %) de la salida nueva no permite ascenso', v_orig;
    END IF;

    SELECT sp.cierre_venta_en INTO v_cierre
      FROM core.salida_parada sp
     WHERE sp.salida_id = p_salida_nueva_id AND sp.orden = v_orig;
    IF v_cierre IS NOT NULL AND v_cierre <= p_ahora THEN
      RAISE EXCEPTION 'la venta para la parada % de la salida nueva ya cerró', v_orig;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_mapa->'asientos') e
       WHERE (e->>'num')::smallint = v_asiento
         AND COALESCE((e->>'vendible')::boolean, true)
    ) THEN
      RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida nueva', v_asiento;
    END IF;

    IF v_mantiene THEN
      v_imp_nuevo := v_bo.importe;
    ELSE
      SELECT t.importe INTO v_imp_nuevo
        FROM core.v_tarifa_vigente t
       WHERE t.ruta_id = v_ruta_nueva
         AND t.parada_origen_orden = v_orig
         AND t.parada_destino_orden = v_dest
         AND t.categoria_pasajero = v_bo.categoria_pasajero
       ORDER BY t.effective_from DESC LIMIT 1;
      IF v_imp_nuevo IS NULL THEN
        RAISE EXCEPTION 'no hay tarifa vigente para el tramo [%,%) categoría % de la ruta nueva',
          v_orig, v_dest, v_bo.categoria_pasajero;
      END IF;
    END IF;

    v_total := v_total + v_imp_nuevo;
    v_plan := v_plan || jsonb_build_object(
      'boleto_viejo_id', v_bid, 'origen_orden', v_orig, 'destino_orden', v_dest,
      'asiento_num', v_asiento, 'importe', v_imp_nuevo,
      'nombre', v_bo.pasajero_nombre, 'categoria', v_bo.categoria_pasajero);
  END LOOP;

  v_saldo     := v_total - LEAST(v_pagado, v_total);
  v_liquidada := v_saldo <= 0;

  -- Venta nueva (una sola, con todos los boletos de la familia).
  INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, cliente_id, contacto_telefono,
                          es_reservacion, salida_id, parada_origen_orden, parada_destino_orden,
                          importe_total, estado)
  VALUES (core.uuid_v7(), p_sucursal_id, p_usuario_id, v_vv.cliente_id, v_vv.contacto_telefono,
          v_vv.es_reservacion, p_salida_nueva_id,
          (v_plan->0->>'origen_orden')::int, (v_plan->0->>'destino_orden')::int,
          v_total, CASE WHEN v_liquidada THEN 'liquidada' ELSE 'pendiente' END)
  RETURNING id INTO v_venta_id;

  -- 2ª pasada: emitir cada boleto + su ocupación firme.
  FOR v_a IN SELECT * FROM jsonb_array_elements(v_plan) LOOP
    v_orig    := (v_a->>'origen_orden')::int;
    v_dest    := (v_a->>'destino_orden')::int;
    v_asiento := (v_a->>'asiento_num')::smallint;
    v_imp_nuevo := (v_a->>'importe')::numeric;
    v_tramo      := int4range(v_orig, v_dest);
    v_tramo_ocup := core.tramo_ocupacion(p_salida_nueva_id, v_orig, v_dest);

    v_folio := core.siguiente_folio(p_sucursal_id);
    INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, tramos_ocupacion,
                             pasajero_nombre, importe, categoria_pasajero, estado)
    VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_nueva_id, v_asiento,
            v_tramo, v_tramo_ocup, v_a->>'nombre', v_imp_nuevo, v_a->>'categoria', 'emitido')
    RETURNING id INTO v_boleto_id;

    BEGIN
      INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, tramos_ocupacion,
                                          boleto_id, estado, sucursal_id, emitido_en, prioridad)
      VALUES (core.uuid_v7(), p_salida_nueva_id, v_asiento, v_tramo, v_tramo_ocup,
              v_boleto_id, 'firme', p_sucursal_id, p_ahora, CASE WHEN v_liquidada THEN 3 ELSE 1 END);
    EXCEPTION WHEN exclusion_violation THEN
      RAISE EXCEPTION 'el asiento % ya está ocupado en la salida nueva', v_asiento;
    END;

    v_boletos := v_boletos || jsonb_build_object(
      'boleto_id', v_boleto_id, 'folio', v_folio, 'asiento_num', v_asiento,
      'pasajero', v_a->>'nombre', 'importe', v_imp_nuevo);
  END LOOP;

  -- Traspasar el/los pago a la venta nueva (F6-D2: la venta entera, no boleto a
  -- boleto) y cerrar el lado viejo.
  IF v_pagado > 0 THEN
    UPDATE core.pago SET venta_id = v_venta_id
     WHERE venta_id = v_vv.id AND activo;
  END IF;

  UPDATE core.asiento_ocupacion
     SET estado = 'liberado', desactivado_motivo = 'venta reubicada (D12/N-14)'
   WHERE boleto_id = ANY (v_vivos) AND estado IN ('firme', 'conflicto');
  UPDATE core.boleto SET estado = 'reasignado', activo = false WHERE id = ANY (v_vivos);
  UPDATE core.venta  SET estado = 'cancelada'  WHERE id = v_vv.id;

  INSERT INTO core.nota_auditoria (id, entidad, entidad_id, tipo, detalle,
                                   usuario_id, sucursal_id, ocurrido_en)
  VALUES (core.uuid_v7(), 'core.venta', p_venta_vieja_id, 'reubicacion',
          jsonb_build_object('venta_nueva_id', v_venta_id, 'salida_nueva_id', p_salida_nueva_id,
                             'precio_mantenido', v_mantiene, 'importe_total', v_total,
                             'boletos', v_boletos),
          p_usuario_id, p_sucursal_id, p_ahora);

  IF v_liquidada THEN
    v_print_jobs := core.encolar_impresion_venta(v_venta_id);
  END IF;

  venta_nueva_id   := v_venta_id;
  importe_total    := v_total;
  pagado           := LEAST(v_pagado, v_total);
  saldo_pendiente  := v_saldo;
  precio_mantenido := v_mantiene;
  boletos          := v_boletos;
  print_jobs       := v_print_jobs;
  RETURN NEXT;
END $function$;

COMMENT ON FUNCTION core.reubicar_venta_huerfana(uuid, uuid, jsonb, uuid, uuid, timestamptz) IS
  'N-14 / F6-D2. Reubica una venta huérfana COMPLETA (multi-boleto, familia) en una salida de la ruta nueva: emite una venta nueva con todos los boletos al precio pagado (traspasa el pago una vez) o a la tarifa vigente si no había pago. Boletos viejos → reasignado + activo=false; venta vieja cancelada. 05 §7.3.';
