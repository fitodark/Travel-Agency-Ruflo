-- =============================================================================
-- 0058 · Caducidad de reservas sin pagar (D9). Fase 6b de "paradas autorizadas".
--        docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D9) / §4.
--
-- QUÉ RESUELVE. Una reserva sin pagar (`es_reservacion = true`, sin ningún pago)
-- CADUCA 1 h antes de `salida.hora_salida` (hora de paso de la parada de origen,
-- orden 0): su asiento se libera y vuelve al cupo. **Liberación perezosa**, no
-- job nocturno: cualquier camino que consulte disponibilidad, adquiera lease o
-- registre venta materializa la caducidad de esa salida.
--
-- ALCANCE. Solo las reservas SIN NINGÚN pago (`pagado = 0`) se auto-liberan
-- (asiento + boleto + venta cancelados). Una reserva con abono parcial mantiene
-- el asiento hasta la cancelación explícita (6c), que maneja el reembolso.
--
-- CÓMO.
--   * `core.reservas_caducas(salida, ahora)` — STABLE: lista las ocupaciones que
--     ya deberían estar liberadas.
--   * `core.liberar_reservas_caducas(salida, ahora)` — VOLATILE: las materializa
--     (`asiento_ocupacion.estado='liberado'`, `boleto.estado='cancelado'`,
--     `venta.estado='cancelada'`). Guarda contra `sync.replicando()`.
--   * `core.asientos_libres` deja de contar como ocupado un asiento sostenido por
--     una reserva caduca (lado de LECTURA, sin escribir).
--   * `core.adquirir_lease` y `core.registrar_venta` llaman a
--     `liberar_reservas_caducas` antes de tocar el asiento (lado de ESCRITURA).
--
-- DEPLOY. `CREATE OR REPLACE` de 2 funciones nuevas + 3 re-emitidas. Sin datos
-- que migrar, sin ventana coordinada: la caducidad es una función determinista
-- del reloj — todos los nodos calculan el mismo resultado (como la expiración de
-- leases).
-- =============================================================================


-- 1. `core.reservas_caducas` — qué está caduco AHORA (solo lectura).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.reservas_caducas(
  p_salida_id uuid,
  p_ahora     timestamptz DEFAULT now()
)
RETURNS TABLE (ocupacion_id uuid, boleto_id uuid, venta_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT o.id, b.id, v.id
    FROM core.asiento_ocupacion o
    JOIN core.boleto b          ON b.id = o.boleto_id
    JOIN core.venta  v          ON v.id = b.venta_id
    JOIN core.salida_parada spo ON spo.salida_id = o.salida_id AND spo.orden = 0
    LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = v.id
   WHERE o.salida_id = p_salida_id
     AND o.estado = 'firme'
     AND o.activo
     AND v.es_reservacion
     AND v.estado = 'pendiente'
     AND b.estado <> 'cancelado'
     AND COALESCE(vs.pagado, 0) = 0            -- sin NINGÚN pago (el abono parcial es 6c)
     AND spo.hora_paso_programada IS NOT NULL
     AND spo.hora_paso_programada - interval '1 hour' <= p_ahora
$$;

COMMENT ON FUNCTION core.reservas_caducas(uuid, timestamptz) IS
  'D9. Ocupaciones de una salida sostenidas por una reserva sin pagar cuya salida de origen parte en menos de 1 h: deberían estar liberadas.';


-- 2. `core.liberar_reservas_caducas` — materializa la caducidad.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.liberar_reservas_caducas(
  p_salida_id uuid,
  p_ahora     timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_n integer;
BEGIN
  IF sync.replicando() THEN
    RETURN 0;
  END IF;

  WITH c AS (
    SELECT ocupacion_id, boleto_id, venta_id
      FROM core.reservas_caducas(p_salida_id, p_ahora)
  ),
  libera_ocup AS (
    UPDATE core.asiento_ocupacion
       SET estado = 'liberado', desactivado_motivo = 'reserva caducada (D9)'
     WHERE id IN (SELECT ocupacion_id FROM c)
     RETURNING 1
  ),
  cancela_boleto AS (
    UPDATE core.boleto
       SET estado = 'cancelado'
     WHERE id IN (SELECT boleto_id FROM c) AND estado <> 'cancelado'
     RETURNING 1
  ),
  cancela_venta AS (
    UPDATE core.venta AS ve
       SET estado = 'cancelada'
     WHERE ve.id IN (SELECT DISTINCT venta_id FROM c)
       AND NOT EXISTS (
         SELECT 1 FROM core.boleto bx
          WHERE bx.venta_id = ve.id AND bx.activo AND bx.estado <> 'cancelado'
            AND bx.id NOT IN (SELECT boleto_id FROM c)
       )
     RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM c;

  RETURN v_n;
END $$;

COMMENT ON FUNCTION core.liberar_reservas_caducas(uuid, timestamptz) IS
  'D9. Libera el asiento (estado=liberado) y cancela boleto + venta de las reservas sin pagar caducas de una salida. Liberación perezosa; determinista del reloj.';


-- 3. `core.asientos_libres` — no cuenta como ocupada una reserva caduca.
--    Idéntica a 0050 salvo el filtro extra en la ocupación firme.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.asientos_libres(
  p_salida_id uuid, p_desde integer, p_hasta integer,
  p_ahora timestamp with time zone DEFAULT now()
)
RETURNS smallint[]
LANGUAGE plpgsql STABLE AS $function$
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
            -- D9: una reserva sin pagar caduca ya no ocupa el asiento.
            AND o.id NOT IN (
              SELECT ocupacion_id FROM core.reservas_caducas(p_salida_id, p_ahora)
            )
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
END $function$;


-- 4. `core.adquirir_lease` — libera las reservas caducas de la salida antes de
--    evaluar si el asiento está ocupado. Idéntica a 0050 salvo ese PERFORM.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.adquirir_lease(
  p_salida_id uuid, p_asiento_num smallint, p_desde integer, p_hasta integer,
  p_sucursal_id uuid, p_duracion_seg integer DEFAULT NULL::integer,
  p_ahora timestamp with time zone DEFAULT now()
)
RETURNS TABLE(estado text, lease_id uuid, expira_en timestamp with time zone)
LANGUAGE plpgsql AS $function$
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

  -- D9: materializa la caducidad de reservas sin pagar de esta salida.
  PERFORM core.liberar_reservas_caducas(p_salida_id, p_ahora);

  UPDATE core.asiento_lease AS al
     SET liberado_en = al.expira_en
   WHERE al.salida_id = p_salida_id
     AND al.asiento_num = p_asiento_num
     AND al.consumido_por_boleto_id IS NULL
     AND al.liberado_en IS NULL
     AND al.expira_en <= p_ahora;

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
END $function$;


-- 5. `core.registrar_venta` — libera las reservas caducas de la salida antes de
--    ocupar asientos. Idéntica a 0057 salvo ese PERFORM.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.registrar_venta(
  p_salida_id uuid, p_sucursal_venta_id uuid, p_usuario_id uuid, p_contacto_telefono text,
  p_origen_orden integer, p_destino_orden integer, p_pasajeros jsonb,
  p_es_reservacion boolean DEFAULT false, p_cliente_id uuid DEFAULT NULL::uuid,
  p_pago jsonb DEFAULT NULL::jsonb, p_con_conexion boolean DEFAULT true,
  p_ahora timestamp with time zone DEFAULT now()
)
RETURNS TABLE(venta_id uuid, estado_venta text, importe_total numeric, pagado numeric,
              saldo_pendiente numeric, boletos jsonb, print_jobs integer, imprimible boolean)
LANGUAGE plpgsql AS $function$
DECLARE
  v_estado_salida  text;
  v_mapa           jsonb;
  v_n_paradas      integer;
  v_cierre         timestamptz;
  v_zona_muerta    integer;
  v_importe_total  numeric;
  v_metodo         text;
  v_monto          numeric;
  v_es_abono       boolean;
  v_corte_id       uuid;
  v_sucursal_cobro uuid;
  v_pagado         numeric := 0;
  v_saldo          numeric;
  v_liquidada      boolean;
  v_prioridad      integer;
  v_venta_id       uuid;
  v_p              jsonb;
  v_asiento        smallint;
  v_nombre         text;
  v_imp            numeric;
  v_lease_id       uuid;
  v_lease          core.asiento_lease%ROWTYPE;
  v_folio          char(6);
  v_boleto_id      uuid;
  v_boletos        jsonb := '[]'::jsonb;
  v_print_jobs     integer := 0;
  v_tramo          int4range;
  v_tramo_ocup     int4range;
  v_ruta_id        uuid;
  v_validar_estr   boolean;
  v_categoria      text;
  v_tarifa         numeric;
  v_desc_ok        boolean;
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

  -- D9: materializa la caducidad de reservas sin pagar de esta salida antes de
  -- evaluar la disponibilidad del asiento.
  PERFORM core.liberar_reservas_caducas(p_salida_id, p_ahora);

  SELECT count(*)::int INTO v_n_paradas
    FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF p_origen_orden < 0 OR p_destino_orden <= p_origen_orden
     OR p_destino_orden > v_n_paradas - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_origen_orden, p_destino_orden, p_salida_id, v_n_paradas;
  END IF;
  v_tramo      := int4range(p_origen_orden, p_destino_orden);
  v_tramo_ocup := core.tramo_ocupacion(p_salida_id, p_origen_orden, p_destino_orden);

  SELECT h.ruta_id INTO v_ruta_id
    FROM core.salida sa JOIN core.horario h ON h.id = sa.horario_id
   WHERE sa.id = p_salida_id;

  v_validar_estr := COALESCE(
    (SELECT (valor::text)::boolean FROM core.parametro
      WHERE clave = 'validar_tarifa_estricta' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1), true);

  SELECT
    EXISTS (SELECT 1 FROM core.ruta_parada rp JOIN core.punto_ruta pr ON pr.id = rp.punto_id
             WHERE rp.ruta_id = v_ruta_id AND rp.activo
               AND rp.orden = p_origen_orden AND rp.orden = 0 AND pr.tipo = 'terminal')
    AND
    EXISTS (SELECT 1 FROM core.ruta_parada rp JOIN core.punto_ruta pr ON pr.id = rp.punto_id
             WHERE rp.ruta_id = v_ruta_id AND rp.activo
               AND rp.orden = p_destino_orden AND pr.tipo = 'terminal'
               AND rp.orden = (SELECT max(orden) FROM core.ruta_parada
                                WHERE ruta_id = v_ruta_id AND activo))
    INTO v_desc_ok;

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

  IF p_pago IS NOT NULL THEN
    v_metodo   := p_pago->>'metodo';
    v_monto    := (p_pago->>'monto')::numeric;
    v_es_abono := COALESCE((p_pago->>'es_abono')::boolean, false);
    IF v_metodo NOT IN ('efectivo', 'transferencia', 'corresponsal') THEN
      RAISE EXCEPTION 'método de pago inválido: %', v_metodo;
    END IF;
    IF v_monto IS NULL OR v_monto <= 0 THEN
      RAISE EXCEPTION 'el monto del pago debe ser positivo';
    END IF;

    IF v_metodo = 'corresponsal' THEN
      v_sucursal_cobro := (p_pago->>'sucursal_cobro_id')::uuid;
      IF v_sucursal_cobro IS NULL THEN
        RAISE EXCEPTION 'un pago corresponsal necesita la sucursal donde se cobró';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM core.sucursal
                      WHERE id = v_sucursal_cobro AND sin_sistema AND activo) THEN
        RAISE EXCEPTION 'la sucursal de cobro corresponsal % no existe o no es "sin sistema"', v_sucursal_cobro;
      END IF;
      IF v_es_abono OR v_monto <> v_importe_total THEN
        RAISE EXCEPTION 'un pago corresponsal cubre el total de la venta, sin abonos parciales';
      END IF;
    ELSE
      v_sucursal_cobro := p_sucursal_venta_id;
    END IF;

    v_corte_id := COALESCE((p_pago->>'corte_caja_id')::uuid,
                           core.corte_abierto(p_sucursal_venta_id));
    v_pagado := CASE WHEN v_metodo IN ('efectivo', 'corresponsal') THEN v_monto ELSE 0 END;
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

    v_categoria := COALESCE(NULLIF(v_p->>'categoria', ''), 'general');
    IF v_categoria NOT IN ('general','inapam','menor') THEN
      RAISE EXCEPTION 'categoría de pasajero inválida: %', v_categoria;
    END IF;

    IF v_categoria <> 'general' AND NOT v_desc_ok THEN
      RAISE EXCEPTION 'la categoría % solo aplica de la terminal de origen a la de destino (tramo completo), no en paradas intermedias',
        v_categoria;
    END IF;

    IF v_validar_estr THEN
      SELECT t.importe INTO v_tarifa
        FROM core.v_tarifa_vigente t
       WHERE t.ruta_id = v_ruta_id
         AND t.parada_origen_orden = p_origen_orden
         AND t.parada_destino_orden = p_destino_orden
         AND t.categoria_pasajero = v_categoria
       ORDER BY t.effective_from DESC LIMIT 1;
      IF v_tarifa IS NULL THEN
        RAISE EXCEPTION 'no hay tarifa vigente para el tramo [%,%) categoría % (ruta %)',
          p_origen_orden, p_destino_orden, v_categoria, v_ruta_id;
      END IF;
      IF v_imp <> v_tarifa THEN
        RAISE EXCEPTION 'el importe del pasajero (%) no coincide con la tarifa vigente (%) para el tramo [%,%) categoría %',
          v_imp, v_tarifa, p_origen_orden, p_destino_orden, v_categoria;
      END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_mapa->'asientos') a
       WHERE (a->>'num')::smallint = v_asiento
         AND COALESCE((a->>'vendible')::boolean, true)
    ) THEN
      RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida %', v_asiento, p_salida_id;
    END IF;

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

    v_folio := core.siguiente_folio(p_sucursal_venta_id);
    INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, tramos_ocupacion,
                             pasajero_nombre, importe, categoria_pasajero, estado)
    VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_id, v_asiento, v_tramo, v_tramo_ocup,
            v_nombre, v_imp, v_categoria, 'emitido')
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
      'pasajero', v_nombre, 'importe', v_imp, 'categoria', v_categoria);
  END LOOP;

  IF p_pago IS NOT NULL THEN
    INSERT INTO core.pago (id, venta_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                           metodo, monto, es_abono, verificado, referencia_transferencia, pagado_en)
    VALUES (core.uuid_v7(), v_venta_id, v_sucursal_cobro, v_corte_id, p_usuario_id,
            v_metodo, v_monto, v_es_abono, v_metodo IN ('efectivo', 'corresponsal'),
            CASE WHEN v_metodo = 'transferencia' THEN p_pago->>'referencia' END, p_ahora);
  END IF;

  IF v_liquidada THEN
    v_print_jobs := core.encolar_impresion_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT
    v_venta_id,
    CASE WHEN v_liquidada THEN 'liquidada' ELSE 'pendiente' END,
    v_importe_total, v_pagado, v_saldo, v_boletos, v_print_jobs, v_liquidada;
END $function$;

COMMENT ON FUNCTION core.registrar_venta(uuid, uuid, uuid, text, integer, integer, jsonb, boolean, uuid, jsonb, boolean, timestamptz) IS
  'Venta / reserva de una salida. Tarifa estricta + categoría (D4); descuento por tipo de punto (F3-D2); pago `corresponsal` (D8); libera reservas caducas de la salida (D9). 02b §4 / 05 §4.';
