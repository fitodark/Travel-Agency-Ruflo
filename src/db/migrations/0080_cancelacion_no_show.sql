-- =============================================================================
-- 0080 · Cancelación por no-show de una venta con lugar de paso.
--        docs/architecture/06-lugar-paso-paqueteria.md §1.1 (L7), Fase A.
--
-- REGLA (PO, 2026-11-03). Si el pasajero que reservó con lugar de paso no se
-- presenta, el conductor avisa a la sucursal de origen, que cancela la reserva
-- para liberar el asiento — aun con la unidad EN RUTA, para que alguien pueda
-- abordar en la siguiente terminal autorizada.
--
-- CAMBIO. `core.cancelar_boleto` (CREATE OR REPLACE, misma firma): la ventana
-- D9 ("hasta 1 h antes de la salida") NO aplica a una venta con
-- `lugar_abordaje`; en su lugar se exige que la salida no esté finalizada ni
-- cancelada. El resto es idéntico a 0061. El reembolso sale solo: el pago
-- `conductor` (0079) está verificado, así que la rama existente registra la
-- DEVOLUCIÓN (egreso) en el corte abierto de la sucursal que cobró — el corte
-- original, posiblemente ya cerrado, no se toca. La caja vuelve a cuadrar:
-- el conductor nunca cobró ese dinero.
--
-- DEPLOY. CREATE OR REPLACE de 1 función; requiere 0079.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.cancelar_boleto(
  p_boleto_id   uuid,
  p_usuario_id  uuid,
  p_sucursal_id uuid,
  p_motivo      text        DEFAULT NULL,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS TABLE (
  venta_id             uuid,
  venta_cancelada      boolean,
  reembolso_id         uuid,
  reembolso_monto      numeric,
  reembolso_pendiente_en text
)
LANGUAGE plpgsql AS $function$
DECLARE
  v_b               core.boleto%ROWTYPE;
  v_venta_id        uuid;
  v_hora_salida     timestamptz;
  v_pagado          numeric;
  v_ya_reembolsado  numeric;
  v_reembolso       numeric := 0;
  v_pago_id         uuid;
  v_sucursal_cobro  uuid;
  v_cobro_nombre    text;
  v_cobro_sin_sis   boolean;
  v_corte_id        uuid;
  v_reembolso_id    uuid;
  v_pendiente_en    text;
  v_venta_cancel    boolean := false;
  v_lugar_paso      boolean;   -- 0080
  v_estado_salida   text;      -- 0080
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.cancelar_boleto no se ejecuta durante la replicación';
  END IF;

  SELECT * INTO v_b FROM core.boleto WHERE id = p_boleto_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el boleto % no existe', p_boleto_id;
  END IF;
  IF v_b.estado = 'cancelado' THEN
    RAISE EXCEPTION 'el boleto % ya está cancelado', p_boleto_id;
  END IF;
  v_venta_id := v_b.venta_id;

  SELECT v.lugar_abordaje IS NOT NULL, s.estado INTO v_lugar_paso, v_estado_salida
    FROM core.venta v JOIN core.salida s ON s.id = v.salida_id
   WHERE v.id = v_venta_id;

  -- Ventana D9: hasta 1 h antes de la salida del origen (orden 0).
  SELECT spo.hora_paso_programada INTO v_hora_salida
    FROM core.salida_parada spo
   WHERE spo.salida_id = v_b.salida_id AND spo.orden = 0;
  IF v_lugar_paso THEN
    -- 0080 (L7): no-show en lugar de paso — se cancela aun en ruta.
    IF v_estado_salida IN ('finalizada', 'cancelada') THEN
      RAISE EXCEPTION 'la salida ya está %: no se puede cancelar la reserva', v_estado_salida;
    END IF;
  ELSIF v_hora_salida IS NOT NULL AND v_hora_salida - interval '1 hour' <= p_ahora THEN
    RAISE EXCEPTION 'no se puede cancelar a menos de 1 h de la salida (%). Contacta a administración.',
      v_hora_salida;
  END IF;

  SELECT COALESCE(vs.pagado, 0) INTO v_pagado
    FROM core.v_venta_saldo vs WHERE vs.venta_id = v_venta_id;

  -- F6-D3: lo ya reembolsado a los pagos de ESTA venta (otros boletos ya
  -- cancelados). El pago es append-only y no se reduce; sin este tope, cada
  -- boleto de una venta con abono parcial devolvería LEAST(importe, pagado).
  SELECT COALESCE(SUM(mc.monto), 0) INTO v_ya_reembolsado
    FROM core.movimiento_caja mc
    JOIN core.pago p2 ON p2.id = mc.origen_id
   WHERE mc.origen_tipo = 'devolucion' AND mc.activo
     AND p2.venta_id = v_venta_id;

  v_reembolso := GREATEST(0, LEAST(v_b.importe, v_pagado - v_ya_reembolsado));

  IF v_reembolso > 0 THEN
    SELECT p.id, p.sucursal_cobro_id, sc.nombre, sc.sin_sistema
      INTO v_pago_id, v_sucursal_cobro, v_cobro_nombre, v_cobro_sin_sis
      FROM core.pago p
      JOIN core.sucursal sc ON sc.id = p.sucursal_cobro_id
     WHERE p.venta_id = v_venta_id AND p.activo
       AND (p.metodo = 'efectivo' OR p.verificado)
     ORDER BY p.pagado_en DESC
     LIMIT 1;

    IF v_cobro_sin_sis THEN
      -- N-13: el efectivo se quedó en la sucursal sin sistema. La cancelación
      -- procede; el reembolso se hace a mano allá (conciliación manual).
      v_pendiente_en := v_cobro_nombre;
    ELSE
      v_corte_id := core.corte_abierto(v_sucursal_cobro);
      IF v_corte_id IS NULL THEN
        RAISE EXCEPTION 'el reembolso de $% lo registra "%" (donde se cobró) con su corte de caja abierto',
          v_reembolso, v_cobro_nombre;
      END IF;
      INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, origen_id,
                                        descripcion, monto, usuario_id, registrado_en)
      VALUES (v_corte_id, 'egreso', 'devolucion', v_pago_id,
              format(CASE WHEN v_lugar_paso THEN 'No-show lugar de paso, boleto %s' ELSE 'Reembolso boleto %s' END, v_b.folio), v_reembolso, p_usuario_id, p_ahora)
      RETURNING id INTO v_reembolso_id;
    END IF;
  END IF;

  UPDATE core.asiento_ocupacion
     SET estado = 'liberado', desactivado_motivo = 'boleto cancelado (D9)'
   WHERE boleto_id = p_boleto_id AND estado IN ('firme', 'conflicto');

  UPDATE core.boleto SET estado = 'cancelado' WHERE id = p_boleto_id;

  IF NOT EXISTS (
    SELECT 1 FROM core.boleto b2
     WHERE b2.venta_id = v_venta_id AND b2.activo AND b2.estado <> 'cancelado'
  ) THEN
    UPDATE core.venta SET estado = 'cancelada' WHERE id = v_venta_id;
    v_venta_cancel := true;
  END IF;

  INSERT INTO core.nota_auditoria (id, entidad, entidad_id, tipo, detalle,
                                   usuario_id, sucursal_id, ocurrido_en)
  VALUES (core.uuid_v7(), 'core.boleto', p_boleto_id, 'cancelacion',
          jsonb_strip_nulls(jsonb_build_object(
            'motivo', p_motivo,
            'reembolso_id', v_reembolso_id,
            'reembolso_monto', CASE WHEN v_reembolso > 0 THEN v_reembolso END,
            'reembolso_pendiente_en', v_pendiente_en,
            'sucursal_cobro_id', v_sucursal_cobro)),
          p_usuario_id, p_sucursal_id, p_ahora);

  venta_id               := v_venta_id;
  venta_cancelada        := v_venta_cancel;
  reembolso_id           := v_reembolso_id;
  reembolso_monto        := CASE WHEN v_reembolso > 0 THEN v_reembolso END;
  reembolso_pendiente_en := v_pendiente_en;
  RETURN NEXT;
END $function$;

COMMENT ON FUNCTION core.cancelar_boleto(uuid, uuid, uuid, text, timestamptz) IS
  'D9/N-13. Cancela un boleto/reserva hasta 1 h antes de la salida: libera el asiento y cancela boleto+venta. El reembolso solo existe en la sucursal de cobro y se acota a lo aún no devuelto de la venta (F6-D3); sin sistema (corresponsal) ⇒ sin movimiento (`reembolso_pendiente_en`). Venta con lugar de paso: sin ventana de 1 h, se cancela aun en ruta (no-show, L7) mientras la salida no esté finalizada/cancelada (0080). 05 §4 · 06 §1.1.';
