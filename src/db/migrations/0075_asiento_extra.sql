-- =============================================================================
-- 0075 · Hasta 2 asientos extra por salida, sin tocar el mapa. Regla de QA
--        (Ses. 76): una unidad de 18 plazas puede llevar 1 o 2 pasajeros de
--        pie/extra cuando el cupo normal ya se agotó y la demanda lo pide —
--        se ve en vivo, minutos antes de que la unidad salga, nunca antes.
--
-- QUÉ RESUELVE. `core.registrar_venta` valida el asiento contra
-- `mapa_snapshot->'asientos'`: hoy es literalmente imposible vender un
-- asiento que no esté en el mapa. La unidad sigue siendo de 18 (el mapa NUNCA
-- cambia — ni `mapa_snapshot` ni `core.tipo_unidad`), pero la salida puede
-- autorizar hasta 2 boletos "extra" numerados 19 y 20 (o los que sigan al
-- último asiento vendible del mapa, si no fuera Sprinter-18).
--
-- POR QUÉ FUNCIÓN APARTE, NO TOCAR `registrar_venta`. `core.asiento_ocupacion.
-- asiento_num` no tiene ninguna atadura de esquema al mapa (ni FK, ni CHECK) —
-- es dato libre. Meter el caso extra dentro de `registrar_venta` (multi-
-- pasajero, lease, cupo offline, categorías, cierre de venta) hubiera sido
-- cirugía de alto riesgo sobre la función más probada del sistema para un
-- flujo que además tiene reglas DISTINTAS: sin `cierre_venta_en` (es
-- justo lo contrario — pasa después del cierre normal), sin lease ni cupo
-- offline (siempre con conexión: el extra no participa de ningún bloque
-- del mapa, así que ninguna sucursal remota puede tenerlo en su cupo), un
-- solo pasajero, categoría siempre `general`, pago siempre de contado
-- (efectivo o transferencia íntegra, nunca abono/corresponsal/reservación).
-- `core.vender_asiento_extra` es una función chica, autocontenida, que
-- reutiliza los mismos helpers (`siguiente_folio`, `tramo_ocupacion`,
-- `v_tarifa_vigente`, `encolar_impresion_venta`, `corte_abierto`) sin tocar
-- la ruta de venta normal.
--
-- EL CONTEO DE "YA VENDIDOS 2" NO NECESITA TABLA NI COLUMNA NUEVA: se cuenta
-- de los boletos ya emitidos de esa salida con `asiento_num` por encima del
-- máximo del mapa. El propio dato es el contador.
--
-- SIN VENTANA DE TIEMPO NI PERMISO ESPECIAL (confirmado con QA): el botón
-- puede usarse en cualquier momento mientras la salida siga `programada`,
-- incluso después de imprimir el manifiesto (QA: "puede pasar que un
-- pasajero llegue justo cuando ya se imprimió" — se resuelve regenerando el
-- manifiesto a mano, no automáticamente). Es criterio del vendedor decidir
-- si la unidad en la puerta puede llevar al 19/20, no algo que el sistema
-- intente adivinar. Mismo permiso que una venta normal (`venta.crear`),
-- filtrado por la API — igual que `mover_unidad`/`cambiar_conductor`, sin
-- guard de `rol_permiso` aquí.
-- =============================================================================

CREATE FUNCTION core.vender_asiento_extra(
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
  IF v_estado_salida <> 'programada' THEN
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

COMMENT ON FUNCTION core.vender_asiento_extra(uuid, uuid, uuid, text, integer, integer, text, text, numeric, text, uuid, timestamptz) IS
  'Vende hasta 2 asientos "extra" (numerados después del último del mapa) para una salida ya con cupo lleno, sin tocar mapa_snapshot ni tipo_unidad. Un pasajero, categoría general, pago de contado (efectivo/transferencia). Sin cierre_venta_en ni cupo offline: siempre con conexión. 0075.';
