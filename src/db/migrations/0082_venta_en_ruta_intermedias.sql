-- =============================================================================
-- 0082 · Venta en una salida EN RUTA desde terminales posteriores al origen.
--        docs/architecture/06-lugar-paso-paqueteria.md §1.1 (L7, L8), Fase B.
--
-- QUÉ RESUELVE. Las terminales intermedias tendrán sistema propio y venden los
-- lugares que llegan libres a su terminal — incluido el asiento que libera un
-- no-show de lugar de paso (L7: "estando en ruta cabría la posibilidad de que
-- alguien pueda abordar en la siguiente sucursal autorizada"). Hasta hoy la
-- venta exigía `salida.estado = 'programada'`: en cuanto el origen marcaba la
-- unidad EN RUTA, Acatlán ya no podía vender aunque la unidad aún no pasara.
--
-- REGLA. Una salida es vendible para un origen de orden `o` si:
--   estado = 'programada'                   (cualquier origen), o
--   estado = 'en_ruta' AND o > 0            (terminal posterior al origen).
-- El tiempo lo sigue cuidando `salida_parada.cierre_venta_en` de ESA parada
-- (cuando la unidad ya pasó, la venta ahí ya cerró). `finalizada`/`cancelada`
-- nunca venden.
--
-- CAMBIOS. Helper `core.salida_vendible(estado, orden)` + CREATE OR REPLACE de
-- 4 funciones, idénticas a su versión vigente salvo el candado de estado:
--   * `core.registrar_venta`      (0079)
--   * `core.adquirir_lease`       (0063)
--   * `core.vender_asiento_extra` (0075)
--   * `core.buscar_salidas`       (0068) — WHERE y columna `seleccionable`.
-- Misma firma en las cuatro: sin cambios en `src/`.
--
-- DEPLOY. Solo funciones. Requiere 0079.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.salida_vendible(p_estado text, p_origen_orden integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_estado = 'programada' OR (p_estado = 'en_ruta' AND p_origen_orden > 0)
$$;

COMMENT ON FUNCTION core.salida_vendible(text, integer) IS
  'L7/L8 (06 §1.1). Programada vende desde cualquier origen; en ruta solo desde terminales posteriores al origen (orden > 0). El tiempo lo cuida cierre_venta_en. 0082.';


-- 1. `core.registrar_venta` (0079 + candado 0082)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.registrar_venta(
  p_salida_id uuid, p_sucursal_venta_id uuid, p_usuario_id uuid, p_contacto_telefono text,
  p_origen_orden integer, p_destino_orden integer, p_pasajeros jsonb,
  p_cliente_id uuid DEFAULT NULL::uuid,
  p_pago jsonb DEFAULT NULL::jsonb, p_con_conexion boolean DEFAULT true,
  p_ahora timestamp with time zone DEFAULT now(),
  p_lugar_abordaje text DEFAULT NULL           -- 0079
)
RETURNS TABLE(venta_id uuid, estado_venta text, importe_total numeric, pagado numeric,
              saldo_pendiente numeric, boletos jsonb, print_jobs integer, imprimible boolean,
              comprobante_impreso boolean)
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
  v_degradado      boolean;
  v_efectivo_recibido numeric;
  v_efectivo_cambio   numeric;
  v_transfer_finalizada boolean := false;
  v_estado_final   text;
  v_comprobante_impreso boolean := false;   -- 0071
  v_es_reservacion boolean;                 -- 0073
  v_lugar          text;                    -- 0079
BEGIN
  IF p_contacto_telefono IS NULL OR btrim(p_contacto_telefono) = '' THEN
    RAISE EXCEPTION 'el teléfono de contacto es obligatorio (S11)';
  END IF;

  -- 0079 (L1): lugar de paso en texto libre, recortado; vacío = sube en origen.
  v_lugar := NULLIF(btrim(p_lugar_abordaje), '');
  IF char_length(v_lugar) > 80 THEN
    RAISE EXCEPTION 'el lugar de abordaje admite hasta 80 caracteres';
  END IF;

  SELECT s.estado, s.mapa_snapshot INTO v_estado_salida, v_mapa
    FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF NOT core.salida_vendible(v_estado_salida, p_origen_orden) THEN   -- 0082
    RAISE EXCEPTION 'la salida % está % : no se puede vender ni reservar', p_salida_id, v_estado_salida;
  END IF;

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

  v_degradado := core.sync_degradado(p_sucursal_venta_id, p_ahora);

  IF p_pago IS NOT NULL THEN
    v_metodo   := p_pago->>'metodo';
    v_monto    := (p_pago->>'monto')::numeric;
    v_es_abono := COALESCE((p_pago->>'es_abono')::boolean, false);
    IF v_metodo NOT IN ('efectivo', 'transferencia', 'corresponsal', 'conductor') THEN
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

    -- 0079 (L4): el conductor cobra al abordar; el sistema lo toma por efectivo
    -- de quien reserva, siempre por el total y solo con lugar de paso.
    IF v_metodo = 'conductor' THEN
      IF v_lugar IS NULL THEN
        RAISE EXCEPTION 'el cobro por conductor solo aplica cuando el pasajero aborda en un lugar de paso';
      END IF;
      IF v_es_abono OR v_monto <> v_importe_total THEN
        RAISE EXCEPTION 'el cobro por conductor cubre el total de la venta, sin abonos parciales';
      END IF;
    END IF;

    v_corte_id := COALESCE((p_pago->>'corte_caja_id')::uuid,
                           core.corte_abierto(p_sucursal_venta_id));
    v_pagado := CASE WHEN v_metodo IN ('efectivo', 'corresponsal', 'conductor') THEN v_monto ELSE 0 END;

    v_efectivo_recibido := NULLIF(p_pago->>'efectivo_recibido', '')::numeric;
    IF v_efectivo_recibido IS NOT NULL THEN
      IF v_metodo <> 'efectivo' THEN
        RAISE EXCEPTION 'el efectivo recibido solo aplica a un pago en efectivo (método %)', v_metodo;
      END IF;
      IF v_efectivo_recibido < v_monto THEN
        RAISE EXCEPTION 'el efectivo recibido (%) no cubre el monto a cobrar (%)',
          v_efectivo_recibido, v_monto;
      END IF;
      v_efectivo_cambio := v_efectivo_recibido - v_monto;
    END IF;

    v_transfer_finalizada := (v_metodo = 'transferencia' AND NOT v_es_abono
                              AND v_monto >= v_importe_total);
  END IF;

  -- 0079 (L4/L5): con lugar de paso no hay intermedios — pago completo en
  -- taquilla o cobro por conductor. Así nunca queda saldo (D9/S8 no aplican).
  IF v_lugar IS NOT NULL
     AND (p_pago IS NULL OR v_es_abono OR v_monto < v_importe_total) THEN
    RAISE EXCEPTION 'una venta con lugar de paso se paga completa en taquilla o la cobra el conductor';
  END IF;

  v_saldo     := v_importe_total - v_pagado;
  v_liquidada := v_saldo <= 0;
  v_prioridad := CASE WHEN v_liquidada THEN 3
                      WHEN v_pagado > 0 OR v_transfer_finalizada THEN 2
                      ELSE 1 END;
  v_estado_final := CASE WHEN v_liquidada THEN 'liquidada'
                         WHEN v_transfer_finalizada THEN 'finalizada_transferencia'
                         ELSE 'pendiente' END;

  -- 0073: "reservación" ya no es una intención declarada al inicio del wizard,
  -- es lo que resultó del pago real al registrar la venta — lo contrario de
  -- quedar cobrada por completo (liquidada o transferencia íntegra finalizada).
  -- Un abono parcial y un "sin pago" caen igual del lado `true`.
  -- 0079: el cobro por conductor es una reserva telefónica aunque quede saldada.
  v_es_reservacion := NOT (v_liquidada OR v_transfer_finalizada)
                      OR v_metodo IS NOT DISTINCT FROM 'conductor';

  INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, cliente_id, contacto_telefono,
                          es_reservacion, salida_id, parada_origen_orden, parada_destino_orden,
                          importe_total, estado, lugar_abordaje)
  VALUES (core.uuid_v7(), p_sucursal_venta_id, p_usuario_id, p_cliente_id, p_contacto_telefono,
          v_es_reservacion, p_salida_id, p_origen_orden, p_destino_orden,
          v_importe_total, v_estado_final, v_lugar)
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
    ELSIF (NOT p_con_conexion OR v_degradado)
          AND NOT core.asiento_en_cupo(p_salida_id, v_asiento, p_origen_orden, p_destino_orden,
                                       p_sucursal_venta_id, p_ahora) THEN
      IF NOT p_con_conexion THEN
        RAISE EXCEPTION 'sin conexión, el asiento % no está en el cupo vigente de la sucursal %',
          v_asiento, p_sucursal_venta_id;
      ELSE
        RAISE EXCEPTION 'la terminal lleva demasiado tiempo sin sincronizar: hasta ponerse al día solo puede vender los asientos de su cupo (el % no está); evita sobreventa entre sucursales',
          v_asiento;
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
                           metodo, monto, es_abono, verificado, referencia_transferencia,
                           efectivo_recibido, efectivo_cambio, pagado_en)
    VALUES (core.uuid_v7(), v_venta_id, v_sucursal_cobro, v_corte_id, p_usuario_id,
            v_metodo, v_monto, v_es_abono, v_metodo IN ('efectivo', 'corresponsal', 'conductor'),
            CASE WHEN v_metodo = 'transferencia' THEN p_pago->>'referencia' END,
            v_efectivo_recibido, v_efectivo_cambio, p_ahora);
  END IF;

  -- 0065: una venta liquidada O finalizada por transferencia imprime su boleto.
  -- 0079 (MOD-5): el cobro por conductor queda saldado pero NO imprime: el
  -- pasajero no está en taquilla; su comprobante es el manifiesto.
  IF v_metodo IS NOT DISTINCT FROM 'conductor' THEN
    NULL;
  ELSIF v_liquidada OR v_transfer_finalizada THEN
    v_print_jobs := core.encolar_impresion_venta(v_venta_id);
  -- 0071: un abono que deja la venta pendiente imprime el comprobante, nunca el
  -- boleto (regla PO Ses. 71: "no debe imprimir los boletos, pero sí un
  -- comprobante de pago").
  ELSIF v_es_abono THEN
    PERFORM core.encolar_comprobante_reserva(v_venta_id, p_sucursal_venta_id);
    v_comprobante_impreso := true;
  END IF;

  RETURN QUERY SELECT
    v_venta_id, v_estado_final,
    v_importe_total, v_pagado, v_saldo, v_boletos, v_print_jobs,
    (v_liquidada OR v_transfer_finalizada) AND v_metodo IS DISTINCT FROM 'conductor',  -- 0079
    v_comprobante_impreso;
END $function$;

-- 2. `core.adquirir_lease` (0063 + candado 0082)
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
  IF NOT core.salida_vendible(v_estado_salida, p_desde) THEN   -- 0082
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

  -- §3.3: un lease es "venta con conexión fuera del cupo propio". Si el nodo
  -- lleva demasiado sin sincronizar, no se concede fuera de cupo: el arbitraje
  -- sería a ciegas y podría sobrevender.
  IF core.sync_degradado(p_sucursal_id, p_ahora)
     AND NOT core.asiento_en_cupo(p_salida_id, p_asiento_num, p_desde, p_hasta, p_sucursal_id, p_ahora)
  THEN
    RAISE EXCEPTION 'la terminal lleva demasiado tiempo sin sincronizar: hasta ponerse al día solo puede vender los asientos de su cupo (evita sobreventa entre sucursales)';
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

-- 3. `core.vender_asiento_extra` (0075 + candado 0082)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.vender_asiento_extra(
  p_salida_id          uuid,
  p_sucursal_venta_id  uuid,
  p_usuario_id         uuid,
  p_contacto_telefono  text,
  p_origen_orden       integer,
  p_destino_orden      integer,
  p_nombre             text,
  p_metodo             text,               -- 'efectivo' | 'transferencia', siempre de contado
  p_efectivo_recibido  numeric DEFAULT NULL,
  p_referencia         text    DEFAULT NULL,
  p_corte_caja_id      uuid    DEFAULT NULL,
  p_ahora              timestamptz DEFAULT now()
)
RETURNS TABLE (
  venta_id     uuid,
  boleto_id    uuid,
  folio        char(6),
  asiento_num  smallint,
  importe      numeric,
  estado_venta text,
  print_jobs   integer
)
LANGUAGE plpgsql AS $$
DECLARE
  v_estado_salida  text;
  v_mapa           jsonb;
  v_n_paradas      integer;
  v_ruta_id        uuid;
  v_max_mapa       smallint;
  v_extra_vendidos integer;
  v_asiento        smallint;
  v_tramo          int4range;
  v_tramo_ocup     int4range;
  v_tarifa         numeric;
  v_folio          char(6);
  v_venta_id       uuid;
  v_boleto_id      uuid;
  v_corte_id       uuid;
  v_efectivo_cambio numeric;
  v_estado_final   text;
  v_print_jobs     integer := 0;
BEGIN
  IF p_contacto_telefono IS NULL OR btrim(p_contacto_telefono) = '' THEN
    RAISE EXCEPTION 'el teléfono de contacto es obligatorio (S11)';
  END IF;
  IF p_nombre IS NULL OR btrim(p_nombre) = '' THEN
    RAISE EXCEPTION 'falta el nombre del pasajero';
  END IF;
  IF p_metodo NOT IN ('efectivo', 'transferencia') THEN
    RAISE EXCEPTION 'un asiento extra solo se cobra en efectivo o transferencia, de contado (método %)', p_metodo;
  END IF;

  SELECT s.estado, s.mapa_snapshot INTO v_estado_salida, v_mapa
    FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF NOT core.salida_vendible(v_estado_salida, p_origen_orden) THEN   -- 0082
    RAISE EXCEPTION 'la salida % está % : no se puede vender', p_salida_id, v_estado_salida;
  END IF;

  PERFORM core.liberar_reservas_caducas(p_salida_id, p_ahora);

  SELECT count(*)::int INTO v_n_paradas FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF p_origen_orden < 0 OR p_destino_orden <= p_origen_orden OR p_destino_orden > v_n_paradas - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_origen_orden, p_destino_orden, p_salida_id, v_n_paradas;
  END IF;
  v_tramo      := int4range(p_origen_orden, p_destino_orden);
  v_tramo_ocup := core.tramo_ocupacion(p_salida_id, p_origen_orden, p_destino_orden);

  SELECT h.ruta_id INTO v_ruta_id
    FROM core.salida sa JOIN core.horario h ON h.id = sa.horario_id
   WHERE sa.id = p_salida_id;

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

  -- A propósito SIN guard de `cierre_venta_en`: el asiento extra se decide
  -- justo antes de que la unidad salga, casi siempre después del cierre
  -- normal de venta — es precisamente el caso que ese cierre no contempla.

  IF NOT EXISTS (
    SELECT 1 FROM core.usuario u
     WHERE u.id = p_usuario_id AND u.activo
       AND u.effective_from <= p_ahora
       AND (u.effective_until IS NULL OR u.effective_until > p_ahora)
  ) THEN
    RAISE EXCEPTION 'el usuario % no existe o no está vigente', p_usuario_id;
  END IF;

  -- Máximo 2 asientos extra por salida: correlativos después del último
  -- asiento vendible del mapa. El mapa NO se toca — esto es solo un conteo
  -- sobre los boletos ya emitidos de esta salida.
  SELECT max((a->>'num')::smallint) INTO v_max_mapa
    FROM jsonb_array_elements(v_mapa->'asientos') a
   WHERE COALESCE((a->>'vendible')::boolean, true);
  IF v_max_mapa IS NULL THEN
    RAISE EXCEPTION 'la salida % no tiene un mapa de asientos válido', p_salida_id;
  END IF;

  SELECT count(*)::int INTO v_extra_vendidos
    FROM core.boleto b
   WHERE b.salida_id = p_salida_id AND b.estado <> 'cancelado' AND b.asiento_num > v_max_mapa;
  IF v_extra_vendidos >= 2 THEN
    RAISE EXCEPTION 'la salida % ya vendió sus 2 asientos extra', p_salida_id;
  END IF;
  v_asiento := v_max_mapa + v_extra_vendidos + 1;

  SELECT t.importe INTO v_tarifa
    FROM core.v_tarifa_vigente t
   WHERE t.ruta_id = v_ruta_id
     AND t.parada_origen_orden = p_origen_orden
     AND t.parada_destino_orden = p_destino_orden
     AND t.categoria_pasajero = 'general'
   ORDER BY t.effective_from DESC LIMIT 1;
  IF v_tarifa IS NULL THEN
    RAISE EXCEPTION 'no hay tarifa vigente para el tramo [%,%) (ruta %)',
      p_origen_orden, p_destino_orden, v_ruta_id;
  END IF;

  v_corte_id := COALESCE(p_corte_caja_id, core.corte_abierto(p_sucursal_venta_id));

  IF p_metodo = 'efectivo' THEN
    IF p_efectivo_recibido IS NULL OR p_efectivo_recibido < v_tarifa THEN
      RAISE EXCEPTION 'el efectivo recibido (%) no cubre la tarifa (%)', p_efectivo_recibido, v_tarifa;
    END IF;
    v_efectivo_cambio := p_efectivo_recibido - v_tarifa;
    v_estado_final := 'liquidada';
  ELSE
    v_estado_final := 'finalizada_transferencia';
  END IF;

  INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, contacto_telefono,
                          es_reservacion, salida_id, parada_origen_orden, parada_destino_orden,
                          importe_total, estado)
  VALUES (core.uuid_v7(), p_sucursal_venta_id, p_usuario_id, p_contacto_telefono,
          false, p_salida_id, p_origen_orden, p_destino_orden, v_tarifa, v_estado_final)
  RETURNING id INTO v_venta_id;

  v_folio := core.siguiente_folio(p_sucursal_venta_id);
  INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, tramos_ocupacion,
                           pasajero_nombre, importe, categoria_pasajero, estado)
  VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_id, v_asiento, v_tramo, v_tramo_ocup,
          p_nombre, v_tarifa, 'general', 'emitido')
  RETURNING id INTO v_boleto_id;

  BEGIN
    INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, tramos_ocupacion, boleto_id,
                                        estado, sucursal_id, emitido_en, prioridad)
    VALUES (core.uuid_v7(), p_salida_id, v_asiento, v_tramo, v_tramo_ocup, v_boleto_id,
            'firme', p_sucursal_venta_id, p_ahora, 3);
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'el asiento extra % ya está vendido en un tramo que solapa', v_asiento;
  END;

  INSERT INTO core.pago (id, venta_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                         metodo, monto, es_abono, verificado, referencia_transferencia,
                         efectivo_recibido, efectivo_cambio, pagado_en)
  VALUES (core.uuid_v7(), v_venta_id, p_sucursal_venta_id, v_corte_id, p_usuario_id,
          p_metodo, v_tarifa, false, p_metodo = 'efectivo',
          CASE WHEN p_metodo = 'transferencia' THEN p_referencia END,
          p_efectivo_recibido, v_efectivo_cambio, p_ahora);

  v_print_jobs := core.encolar_impresion_venta(v_venta_id);

  venta_id := v_venta_id; boleto_id := v_boleto_id; folio := v_folio;
  asiento_num := v_asiento; importe := v_tarifa; estado_venta := v_estado_final;
  print_jobs := v_print_jobs;
  RETURN NEXT;
END $$;

-- 4. `core.buscar_salidas` (0068 + candado 0082)
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
  salida_id            uuid,
  horario_id           uuid,
  fecha_operacion      date,
  hora_salida_origen   timestamptz,
  hora_llegada_destino timestamptz,
  origen_orden         smallint,
  destino_orden        smallint,
  estado               text,
  cierre_venta_en      timestamptz,
  importe              numeric,
  asientos_ofrecibles  smallint[],
  disponibles          integer,
  seleccionable        boolean,
  ruta_nombre          text,
  origen_nombre        text,
  destino_nombre       text,
  escalas              text[],
  tarifas              jsonb,
  mapa                 jsonb,
  unidad_nombre        text,
  unidad_numero_economico text
)
LANGUAGE sql STABLE AS $$
  SELECT s.id,
         s.horario_id,
         s.fecha_operacion,
         spo.hora_paso_programada,
         spd.hora_paso_programada,
         spo.orden,
         spd.orden,
         s.estado,
         spo.cierre_venta_en,
         t.importe,
         ofr.asientos,
         cardinality(ofr.asientos),
         core.salida_vendible(s.estado, spo.orden)   -- 0082
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
         ), ARRAY[]::text[]),
         COALESCE((
           SELECT jsonb_object_agg(x.categoria_pasajero, x.importe)
             FROM (
               SELECT DISTINCT ON (t2.categoria_pasajero)
                      t2.categoria_pasajero, t2.importe
                 FROM core.v_tarifa_vigente t2
                WHERE t2.ruta_id = h.ruta_id
                  AND t2.parada_origen_orden = spo.orden
                  AND t2.parada_destino_orden = spd.orden
                ORDER BY t2.categoria_pasajero, t2.effective_from DESC
             ) x
         ), '{}'::jsonb),
         s.mapa_snapshot,
         tu.nombre,
         un.numero_economico
    FROM core.salida s
    JOIN core.salida_parada spo
      ON spo.salida_id = s.id AND spo.punto_id = p_origen
    JOIN core.salida_parada spd
      ON spd.salida_id = s.id AND spd.punto_id = p_destino
    JOIN core.horario h ON h.id = s.horario_id
    JOIN core.ruta    r ON r.id = h.ruta_id
    JOIN core.ruta_parada rpo
      ON rpo.ruta_id = h.ruta_id AND rpo.punto_id = p_origen
     AND rpo.permite_ascenso AND rpo.activo
    JOIN core.punto_ruta puo ON puo.id = p_origen
    JOIN core.punto_ruta pud ON pud.id = p_destino
    JOIN core.tipo_unidad tu ON tu.id = s.tipo_unidad_id
    LEFT JOIN core.unidad un ON un.id = s.unidad_id
    LEFT JOIN core.v_tarifa_vigente t
      ON t.ruta_id = h.ruta_id
     AND t.parada_origen_orden = spo.orden
     AND t.parada_destino_orden = spd.orden
     AND t.categoria_pasajero = 'general'
    CROSS JOIN LATERAL (
      SELECT core.asientos_ofrecibles(
        s.id, spo.orden, spd.orden, p_sucursal_vendedora, p_con_conexion, p_ahora
      ) AS asientos
    ) ofr
   WHERE s.activo
     AND h.activo
     AND r.activo
     AND s.fecha_operacion = p_fecha
     AND core.salida_vendible(s.estado, spo.orden)   -- 0082
     AND spo.orden < spd.orden
   ORDER BY spo.hora_paso_programada, r.nombre
$$;
