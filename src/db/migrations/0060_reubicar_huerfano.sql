-- =============================================================================
-- 0060 · Reubicación de un boleto huérfano (N-14). Fase 6c-2 de "paradas
--        autorizadas". docs/architecture/05-...md §2 (D12) / §7.3 (N-14).
--
-- CONTEXTO. Al reemplazar una ruta por vigencia (D5) los boletos vendidos para
-- viajar en/después de la fecha nueva quedan huérfanos (`core.boletos_huerfanos`).
-- El admin concilia con el pasajero por teléfono y lo reubica en la ruta nueva:
-- cancela el boleto viejo y **reemite** uno nuevo en una salida de la ruta nueva.
--
-- N-14 (cliente, 2026-09-09):
--   * huérfano YA PAGADO ⇒ el boleto nuevo se emite al **importe pagado** (se
--     mantiene el precio aunque la tarifa de la ruta nueva difiera); el/los
--     `core.pago` se **traspasan** a la venta nueva — NO se mueve efectivo, no
--     hay reembolso ni cobro de diferencia.
--   * huérfano SIN pagar ⇒ el boleto nuevo se emite a la **tarifa vigente** de la
--     ruta nueva; la venta nueva queda `pendiente` (se cobra con el flujo normal).
--
-- El boleto viejo queda `estado='reasignado'` y su asiento `liberado`; la venta
-- vieja `cancelada` (ya sin pagos ni boletos vivos).
--
-- DEPLOY. 1 función nueva. Sin datos que migrar, sin ventana coordinada.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.reubicar_huerfano(
  p_boleto_viejo_id uuid,
  p_salida_nueva_id uuid,
  p_origen_orden    integer,
  p_destino_orden   integer,
  p_asiento_num     smallint,
  p_usuario_id      uuid,
  p_sucursal_id     uuid,
  p_ahora           timestamptz DEFAULT now()
)
RETURNS TABLE (
  boleto_nuevo_id  uuid,
  folio_nuevo      text,
  venta_nueva_id   uuid,
  importe          numeric,
  precio_mantenido boolean,
  saldo_pendiente  numeric,
  print_jobs       integer
)
LANGUAGE plpgsql AS $function$
DECLARE
  v_bv          core.boleto%ROWTYPE;
  v_vv          core.venta%ROWTYPE;
  v_pagado      numeric;
  v_ruta_nueva  uuid;
  v_n_paradas   integer;
  v_estado_sal  text;
  v_mapa        jsonb;
  v_cierre      timestamptz;
  v_importe     numeric;
  v_mantiene    boolean;
  v_tramo       int4range;
  v_tramo_ocup  int4range;
  v_venta_id    uuid;
  v_boleto_id   uuid;
  v_folio       char(6);
  v_saldo       numeric;
  v_liquidada   boolean;
  v_print_jobs  integer := 0;
BEGIN
  SELECT * INTO v_bv FROM core.boleto WHERE id = p_boleto_viejo_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el boleto huérfano % no existe', p_boleto_viejo_id;
  END IF;
  IF v_bv.estado <> 'emitido' THEN
    RAISE EXCEPTION 'el boleto % está % : solo se reubica un boleto emitido', p_boleto_viejo_id, v_bv.estado;
  END IF;
  SELECT * INTO v_vv FROM core.venta WHERE id = v_bv.venta_id;

  -- Salida destino: programada, con venta abierta en la parada de origen.
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
  IF p_origen_orden < 0 OR p_destino_orden <= p_origen_orden OR p_destino_orden > v_n_paradas - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_origen_orden, p_destino_orden, p_salida_nueva_id, v_n_paradas;
  END IF;

  SELECT h.ruta_id INTO v_ruta_nueva
    FROM core.salida sa JOIN core.horario h ON h.id = sa.horario_id
   WHERE sa.id = p_salida_nueva_id;

  -- El origen debe permitir ascenso (D2).
  IF NOT EXISTS (
    SELECT 1 FROM core.salida_parada sp
      JOIN core.ruta_parada rp ON rp.ruta_id = v_ruta_nueva AND rp.punto_id = sp.punto_id
     WHERE sp.salida_id = p_salida_nueva_id AND sp.orden = p_origen_orden
       AND rp.permite_ascenso AND rp.activo
  ) THEN
    RAISE EXCEPTION 'la parada de origen (orden %) de la salida nueva no permite ascenso', p_origen_orden;
  END IF;

  SELECT sp.cierre_venta_en INTO v_cierre
    FROM core.salida_parada sp
   WHERE sp.salida_id = p_salida_nueva_id AND sp.orden = p_origen_orden;
  IF v_cierre IS NOT NULL AND v_cierre <= p_ahora THEN
    RAISE EXCEPTION 'la venta para la parada % de la salida nueva ya cerró', p_origen_orden;
  END IF;

  -- Asiento vendible.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_mapa->'asientos') a
     WHERE (a->>'num')::smallint = p_asiento_num
       AND COALESCE((a->>'vendible')::boolean, true)
  ) THEN
    RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida nueva', p_asiento_num;
  END IF;

  -- N-14: ¿ya pagó?
  SELECT COALESCE(vs.pagado, 0) INTO v_pagado
    FROM core.v_venta_saldo vs WHERE vs.venta_id = v_vv.id;

  IF v_pagado > 0 THEN
    -- Mantiene el precio pagado.
    v_importe  := v_bv.importe;
    v_mantiene := true;
  ELSE
    -- Tarifa vigente de la ruta nueva para el tramo y categoría.
    SELECT t.importe INTO v_importe
      FROM core.v_tarifa_vigente t
     WHERE t.ruta_id = v_ruta_nueva
       AND t.parada_origen_orden = p_origen_orden
       AND t.parada_destino_orden = p_destino_orden
       AND t.categoria_pasajero = v_bv.categoria_pasajero
     ORDER BY t.effective_from DESC LIMIT 1;
    IF v_importe IS NULL THEN
      RAISE EXCEPTION 'no hay tarifa vigente para el tramo [%,%) categoría % de la ruta nueva',
        p_origen_orden, p_destino_orden, v_bv.categoria_pasajero;
    END IF;
    v_mantiene := false;
  END IF;

  v_tramo      := int4range(p_origen_orden, p_destino_orden);
  v_tramo_ocup := core.tramo_ocupacion(p_salida_nueva_id, p_origen_orden, p_destino_orden);

  -- --- Emitir el boleto nuevo -------------------------------------------
  v_saldo     := v_importe - LEAST(v_pagado, v_importe);
  v_liquidada := v_saldo <= 0;

  INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, cliente_id, contacto_telefono,
                          es_reservacion, salida_id, parada_origen_orden, parada_destino_orden,
                          importe_total, estado)
  VALUES (core.uuid_v7(), p_sucursal_id, p_usuario_id, v_vv.cliente_id, v_vv.contacto_telefono,
          v_vv.es_reservacion, p_salida_nueva_id, p_origen_orden, p_destino_orden,
          v_importe, CASE WHEN v_liquidada THEN 'liquidada' ELSE 'pendiente' END)
  RETURNING id INTO v_venta_id;

  v_folio := core.siguiente_folio(p_sucursal_id);
  INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, tramos_ocupacion,
                           pasajero_nombre, importe, categoria_pasajero, estado)
  VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_nueva_id, p_asiento_num,
          v_tramo, v_tramo_ocup, v_bv.pasajero_nombre, v_importe, v_bv.categoria_pasajero, 'emitido')
  RETURNING id INTO v_boleto_id;

  BEGIN
    INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, tramos_ocupacion,
                                        boleto_id, estado, sucursal_id, emitido_en, prioridad)
    VALUES (core.uuid_v7(), p_salida_nueva_id, p_asiento_num, v_tramo, v_tramo_ocup,
            v_boleto_id, 'firme', p_sucursal_id, p_ahora, CASE WHEN v_liquidada THEN 3 ELSE 1 END);
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'el asiento % ya está ocupado en la salida nueva', p_asiento_num;
  END;

  -- --- Traspasar el pago y cerrar el lado viejo ------------------------
  IF v_pagado > 0 THEN
    UPDATE core.pago SET venta_id = v_venta_id
     WHERE venta_id = v_vv.id AND activo;
  END IF;

  UPDATE core.asiento_ocupacion
     SET estado = 'liberado', desactivado_motivo = 'boleto reubicado (D12/N-14)'
   WHERE boleto_id = p_boleto_viejo_id AND estado IN ('firme', 'conflicto');
  UPDATE core.boleto SET estado = 'reasignado' WHERE id = p_boleto_viejo_id;
  UPDATE core.venta  SET estado = 'cancelada'  WHERE id = v_vv.id;

  INSERT INTO core.nota_auditoria (id, entidad, entidad_id, tipo, detalle,
                                   usuario_id, sucursal_id, ocurrido_en)
  VALUES (core.uuid_v7(), 'core.boleto', p_boleto_viejo_id, 'reubicacion',
          jsonb_build_object('boleto_nuevo_id', v_boleto_id, 'folio_nuevo', v_folio,
                             'salida_nueva_id', p_salida_nueva_id, 'precio_mantenido', v_mantiene,
                             'importe', v_importe),
          p_usuario_id, p_sucursal_id, p_ahora);

  IF v_liquidada THEN
    v_print_jobs := core.encolar_impresion_venta(v_venta_id);
  END IF;

  boleto_nuevo_id  := v_boleto_id;
  folio_nuevo      := v_folio;
  venta_nueva_id   := v_venta_id;
  importe          := v_importe;
  precio_mantenido := v_mantiene;
  saldo_pendiente  := v_saldo;
  print_jobs       := v_print_jobs;
  RETURN NEXT;
END $function$;

COMMENT ON FUNCTION core.reubicar_huerfano(uuid, uuid, integer, integer, smallint, uuid, uuid, timestamptz) IS
  'N-14. Reubica un boleto huérfano en una salida de la ruta nueva: boleto viejo → reasignado + asiento liberado; boleto nuevo al precio pagado (traspasa el pago) o a la tarifa vigente si no había pago. 05 §7.3.';
