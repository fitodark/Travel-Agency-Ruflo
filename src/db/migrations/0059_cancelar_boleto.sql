-- =============================================================================
-- 0059 · Cancelación de boleto / reserva con reembolso (D9). Fase 6c-1 de
--        "paradas autorizadas". docs/architecture/05-...md §2 (D9, D10) / §4.
--
-- QUÉ TRAE. Acción explícita para cancelar un boleto (o una reserva) hasta 1 h
-- antes de la salida del origen: libera el asiento y cancela boleto + venta.
--
-- REEMBOLSO (N-13, respondido por el cliente). El reembolso SOLO existe en la
-- sucursal donde se cobró (`pago.sucursal_cobro_id`):
--   * pago `efectivo` / `transferencia` verificada, cobrado en una sucursal CON
--     sistema → `movimiento_caja` egreso `origen_tipo='devolucion'` en el corte
--     ABIERTO de esa sucursal. Sin corte abierto ahí ⇒ `RAISE` (el reembolso lo
--     registra esa sucursal con su corte abierto).
--   * pago cobrado en una sucursal `sin_sistema` (`corresponsal`, p. ej.
--     Tamazulapan) → NO se registra movimiento: el efectivo nunca entró al
--     sistema. La cancelación PROCEDE (libera el asiento), y el reembolso se hace
--     a mano en esa sucursal (conciliación manual). Se devuelve
--     `reembolso_pendiente_en` con el nombre de la sucursal.
--   * transferencia sin verificar / sin pago → solo libera el asiento.
--
-- FUERA (6c-2): reubicación de un boleto huérfano (N-14, ya respondido).
--
-- D10 (manifiesto con transferencia sin validar) YA está resuelto desde 5a-2.
--
-- DEPLOY. `INSERT` de un permiso + 1 función nueva. Sin datos que migrar, sin
-- ventana coordinada.
-- =============================================================================


-- 1. Permiso `reserva.cancelar` — administrador + gerente.
-- ---------------------------------------------------------------------------
INSERT INTO core.rol_permiso (rol, permiso) VALUES
  ('administrador', 'reserva.cancelar'),
  ('gerente',       'reserva.cancelar')
ON CONFLICT DO NOTHING;


-- 2. `core.cancelar_boleto` — cancela + libera + reembolsa en la sucursal de cobro.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.cancelar_boleto(
  p_boleto_id   uuid,
  p_usuario_id  uuid,
  p_sucursal_id uuid,       -- sucursal desde la que se opera la cancelación
  p_motivo      text        DEFAULT NULL,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS TABLE (
  venta_id             uuid,
  venta_cancelada      boolean,
  reembolso_id         uuid,
  reembolso_monto      numeric,
  -- Sucursal donde el pasajero debe recibir su efectivo a mano (sucursal sin
  -- sistema). NULL si el reembolso se registró en un corte o si no hubo pago.
  reembolso_pendiente_en text
)
LANGUAGE plpgsql AS $function$
DECLARE
  v_b              core.boleto%ROWTYPE;
  v_venta_id       uuid;
  v_hora_salida    timestamptz;
  v_pagado         numeric;
  v_reembolso      numeric := 0;   -- lo que se devuelve por ESTE boleto
  v_pago_id        uuid;
  v_sucursal_cobro uuid;
  v_cobro_nombre   text;
  v_cobro_sin_sis  boolean;
  v_corte_id       uuid;
  v_reembolso_id   uuid;
  v_pendiente_en   text;
  v_venta_cancel   boolean := false;
BEGIN
  SELECT * INTO v_b FROM core.boleto WHERE id = p_boleto_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el boleto % no existe', p_boleto_id;
  END IF;
  IF v_b.estado = 'cancelado' THEN
    RAISE EXCEPTION 'el boleto % ya está cancelado', p_boleto_id;
  END IF;
  v_venta_id := v_b.venta_id;

  -- Ventana D9: hasta 1 h antes de la salida del origen (orden 0).
  SELECT spo.hora_paso_programada INTO v_hora_salida
    FROM core.salida_parada spo
   WHERE spo.salida_id = v_b.salida_id AND spo.orden = 0;
  IF v_hora_salida IS NOT NULL AND v_hora_salida - interval '1 hour' <= p_ahora THEN
    RAISE EXCEPTION 'no se puede cancelar a menos de 1 h de la salida (%). Contacta a administración.',
      v_hora_salida;
  END IF;

  -- Pago confirmado de la venta (efectivo desde el inicio, transferencia al
  -- verificarse, corresponsal desde el inicio).
  SELECT COALESCE(vs.pagado, 0) INTO v_pagado
    FROM core.v_venta_saldo vs WHERE vs.venta_id = v_venta_id;

  -- Lo que se devuelve por este boleto: su importe, acotado a lo realmente
  -- pagado en la venta (una venta multi-boleto refunda cada uno por separado; el
  -- pago restante cubre a los boletos que siguen vivos).
  v_reembolso := LEAST(v_b.importe, v_pagado);

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
      -- El reembolso lo registra la sucursal de cobro, con su corte abierto.
      v_corte_id := core.corte_abierto(v_sucursal_cobro);
      IF v_corte_id IS NULL THEN
        RAISE EXCEPTION 'el reembolso de $% lo registra "%" (donde se cobró) con su corte de caja abierto',
          v_reembolso, v_cobro_nombre;
      END IF;
      INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, origen_id,
                                        descripcion, monto, usuario_id, registrado_en)
      VALUES (v_corte_id, 'egreso', 'devolucion', v_pago_id,
              format('Reembolso boleto %s', v_b.folio), v_reembolso, p_usuario_id, p_ahora)
      RETURNING id INTO v_reembolso_id;
    END IF;
  END IF;

  -- Liberar el asiento + cancelar el boleto.
  UPDATE core.asiento_ocupacion
     SET estado = 'liberado', desactivado_motivo = 'boleto cancelado (D9)'
   WHERE boleto_id = p_boleto_id AND estado IN ('firme', 'conflicto');

  UPDATE core.boleto SET estado = 'cancelado' WHERE id = p_boleto_id;

  -- Cancelar la venta si no le quedan boletos vivos.
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
  'D9/N-13. Cancela un boleto/reserva hasta 1 h antes de la salida: libera el asiento y cancela boleto+venta. El reembolso solo existe en la sucursal de cobro: con sistema ⇒ egreso `devolucion` en su corte abierto; sin sistema (corresponsal) ⇒ sin movimiento, reembolso manual (`reembolso_pendiente_en`). 05 §4.';
