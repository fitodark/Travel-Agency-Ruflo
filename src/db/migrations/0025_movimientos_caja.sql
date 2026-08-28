-- =============================================================================
-- 0025 · Movimientos de caja: el enlace pago → ingreso, egresos y anulación.
-- Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §2.2, §3
--                  docs/architecture/04-riesgos-roadmap.md §3 (F6)
--
-- Cierra el enlace que F4 dejó pendiente: "todas las ventas de boletos se
-- registrarán como movimientos de ingreso y suman al corte de caja activo".
--
--   - Efectivo: el ingreso se crea al registrar el pago.
--   - Transferencia: el ingreso se crea al VERIFICARLA (req. paso 6) — antes no
--     es dinero confirmado y no debe estar en el corte.
--   - El ingreso suma al corte de `pago.corte_caja_id`, que es el de la sucursal
--     que COBRA, no el de la venta (C5: la reservación pagada en destino).
--
-- El requisito activo/inactivo: al "eliminar" un egreso, `activo=false`, el
-- monto regresa al corte (la vista `v_corte_saldo` solo suma activos) y el
-- registro permanece visible para la auditoría del administrador.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pago → movimiento_caja(ingreso). Idempotente por (origen_tipo, origen_id).
-- Guardado con `sync.replicando()`: solo dispara en escrituras locales; en la
-- nube el movimiento llega por ingesta como cualquier hecho de clase C.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.trg_pago_a_ingreso() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF sync.replicando() THEN
    RETURN NEW;
  END IF;

  -- Dinero confirmado: efectivo desde el inicio, transferencia al verificarse.
  IF NEW.activo AND (NEW.metodo = 'efectivo' OR NEW.verificado)
     AND NOT EXISTS (
       SELECT 1 FROM core.movimiento_caja
        WHERE origen_tipo = 'pago_boleto' AND origen_id = NEW.id AND activo
     )
  THEN
    INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, origen_id,
                                      monto, usuario_id, registrado_en)
    VALUES (NEW.corte_caja_id, 'ingreso', 'pago_boleto', NEW.id,
            NEW.monto, NEW.usuario_id,
            COALESCE(NEW.verificado_en, NEW.pagado_en, now()));
  END IF;

  -- Pago dado de baja: su ingreso lo sigue.
  IF TG_OP = 'UPDATE' AND OLD.activo AND NOT NEW.activo THEN
    UPDATE core.movimiento_caja
       SET activo = false, desactivado_motivo = 'pago cancelado'
     WHERE origen_tipo = 'pago_boleto' AND origen_id = NEW.id AND activo;
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_pago_a_ingreso
  AFTER INSERT OR UPDATE ON core.pago
  FOR EACH ROW EXECUTE FUNCTION core.trg_pago_a_ingreso();

COMMENT ON FUNCTION core.trg_pago_a_ingreso() IS
  'Crea el movimiento_caja de ingreso cuando un pago se vuelve dinero confirmado. F6.';


-- -----------------------------------------------------------------------------
-- Egreso por insumo: el requisito pide un campo de texto obligatorio con la
-- descripción del gasto (el usuario resguarda el ticket de compra).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.registrar_egreso(
  p_corte_id     uuid,
  p_usuario_id   uuid,
  p_monto        numeric,
  p_descripcion  text,
  p_ahora        timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_estado text; v_id uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN
    RAISE EXCEPTION 'el monto del egreso debe ser positivo';
  END IF;
  IF p_descripcion IS NULL OR btrim(p_descripcion) = '' THEN
    RAISE EXCEPTION 'el egreso necesita una descripción del gasto';
  END IF;

  SELECT estado INTO v_estado FROM core.corte_caja WHERE id = p_corte_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el corte de caja % no existe', p_corte_id;
  END IF;
  IF v_estado = 'cerrado' THEN
    RAISE EXCEPTION 'el corte de caja % está cerrado', p_corte_id;
  END IF;

  INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, descripcion,
                                    monto, usuario_id, registrado_en)
  VALUES (p_corte_id, 'egreso', 'gasto_insumo', p_descripcion, p_monto, p_usuario_id, p_ahora)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

COMMENT ON FUNCTION core.registrar_egreso(uuid, uuid, numeric, text, timestamptz) IS
  'Registra un egreso por insumo con descripción obligatoria. F6.';


-- -----------------------------------------------------------------------------
-- Anula (baja lógica) un movimiento. El monto regresa al corte por la vista.
-- El registro NO se borra: sigue visible para el administrador
-- (`v_movimiento_auditoria`). Idempotente.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.anular_movimiento(
  p_movimiento_id uuid,
  p_usuario_id    uuid,
  p_motivo        text,
  p_ahora         timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_rec record;
BEGIN
  SELECT m.activo, c.estado AS corte_estado
    INTO v_rec
    FROM core.movimiento_caja m
    JOIN core.corte_caja c ON c.id = m.corte_caja_id
   WHERE m.id = p_movimiento_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el movimiento % no existe', p_movimiento_id;
  END IF;
  IF NOT v_rec.activo THEN
    RETURN false;   -- idempotente
  END IF;
  IF v_rec.corte_estado = 'cerrado' THEN
    RAISE EXCEPTION 'no se puede anular un movimiento de un corte ya cerrado';
  END IF;

  UPDATE core.movimiento_caja
     SET activo = false, desactivado_por = p_usuario_id,
         desactivado_motivo = COALESCE(NULLIF(btrim(p_motivo), ''), 'anulado')
   WHERE id = p_movimiento_id;
  RETURN true;
END $$;

COMMENT ON FUNCTION core.anular_movimiento(uuid, uuid, text, timestamptz) IS
  'Baja lógica de un movimiento: el monto vuelve al corte, el registro queda para auditoría.';
