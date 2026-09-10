-- =============================================================================
-- 0059 · Cancelación de boleto / reserva con reembolso (D9). Fase 6c-1 de
--        "paradas autorizadas". docs/architecture/05-...md §2 (D9, D10) / §4.
--
-- QUÉ TRAE. Acción explícita para cancelar un boleto (o una reserva) hasta 1 h
-- antes de la salida del origen: libera el asiento y, si la venta tenía un pago
-- confirmado en efectivo o transferencia verificada, registra un movimiento de
-- **reembolso** (egreso, `origen_tipo='devolucion'`) en el corte abierto de la
-- sucursal que cancela.
--
-- ALCANCE 6c-1 (desbloqueado):
--   * pago `efectivo` / `transferencia` verificada  → reembolso en el corte.
--   * pago `transferencia` sin verificar / sin pago → solo libera el asiento.
--   * pago `corresponsal`                           → `RAISE` (pendiente N-13:
--     el efectivo se quedó en la corresponsal, el cliente decide cómo se
--     devuelve y qué rol autoriza).
--
-- FUERA (6c-2, bloqueado por N-14): reubicación de un boleto huérfano (cancelar +
-- reemitir con traspaso de saldo vs reembolso+cobro).
--
-- D10 (manifiesto con transferencia sin validar) YA está resuelto desde 5a-2:
-- `core.datos_manifiesto` marca `estatus_pago='pendiente'` y no bloquea.
--
-- DEPLOY. `INSERT` de un permiso + 1 función nueva. Sin datos que migrar, sin
-- ventana coordinada.
-- =============================================================================


-- 1. Permiso `reserva.cancelar` — por defecto administrador + gerente.
--    (N-13 puede sumar `vendedor`: es un INSERT más.)
-- ---------------------------------------------------------------------------
INSERT INTO core.rol_permiso (rol, permiso) VALUES
  ('administrador', 'reserva.cancelar'),
  ('gerente',       'reserva.cancelar')
ON CONFLICT DO NOTHING;


-- 2. `core.cancelar_boleto` — cancela + libera + reembolsa.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.cancelar_boleto(
  p_boleto_id   uuid,
  p_usuario_id  uuid,
  p_sucursal_id uuid,
  p_motivo      text        DEFAULT NULL,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS TABLE (
  venta_id         uuid,
  venta_cancelada  boolean,
  reembolso_id     uuid,
  reembolso_monto  numeric
)
LANGUAGE plpgsql AS $function$
DECLARE
  v_b            core.boleto%ROWTYPE;
  v_venta_id     uuid;
  v_hora_salida  timestamptz;
  v_pagado       numeric;
  v_pago_id      uuid;
  v_metodo_pago  text;
  v_corte_id     uuid;
  v_reembolso_id uuid;
  v_venta_cancel boolean := false;
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

  -- Pago confirmado de la venta (efectivo desde el inicio, transferencia al verificarse).
  SELECT COALESCE(vs.pagado, 0) INTO v_pagado
    FROM core.v_venta_saldo vs WHERE vs.venta_id = v_venta_id;

  IF v_pagado > 0 THEN
    SELECT p.id, p.metodo INTO v_pago_id, v_metodo_pago
      FROM core.pago p
     WHERE p.venta_id = v_venta_id AND p.activo
       AND (p.metodo = 'efectivo' OR p.verificado)
     ORDER BY p.pagado_en DESC
     LIMIT 1;

    IF v_metodo_pago = 'corresponsal' THEN
      RAISE EXCEPTION 'el pago de esta reserva fue corresponsal: el reembolso se gestiona en la sucursal donde se cobró (N-13, pendiente de definir). Cancela el boleto sin sistema por ahora.';
    END IF;

    -- Reembolso (egreso) en el corte abierto de la sucursal que cancela (D9).
    v_corte_id := core.corte_abierto(p_sucursal_id);
    IF v_corte_id IS NULL THEN
      RAISE EXCEPTION 'no hay corte de caja abierto en la sucursal para registrar el reembolso de $%', v_pagado;
    END IF;

    INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, origen_id,
                                      descripcion, monto, usuario_id, registrado_en)
    VALUES (v_corte_id, 'egreso', 'devolucion', v_pago_id,
            format('Reembolso boleto %s', v_b.folio), v_pagado, p_usuario_id, p_ahora)
    RETURNING id INTO v_reembolso_id;
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
          jsonb_build_object('motivo', p_motivo, 'reembolso_id', v_reembolso_id,
                             'reembolso_monto', CASE WHEN v_reembolso_id IS NOT NULL THEN v_pagado END),
          p_usuario_id, p_sucursal_id, p_ahora);

  venta_id        := v_venta_id;
  venta_cancelada := v_venta_cancel;
  reembolso_id    := v_reembolso_id;
  reembolso_monto := CASE WHEN v_reembolso_id IS NOT NULL THEN v_pagado END;
  RETURN NEXT;
END $function$;

COMMENT ON FUNCTION core.cancelar_boleto(uuid, uuid, uuid, text, timestamptz) IS
  'D9. Cancela un boleto/reserva hasta 1 h antes de la salida: libera el asiento y, si hubo pago confirmado (efectivo/transferencia verificada), registra un reembolso (egreso `devolucion`) en el corte abierto. `corresponsal` → RAISE (N-13). 05 §4.';
