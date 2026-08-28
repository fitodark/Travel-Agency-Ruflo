-- =============================================================================
-- 0024 · Ciclo de vida del corte de caja (F6, slice 1).
-- Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
--                  docs/architecture/04-riesgos-roadmap.md §3 (F6)
--
-- El esquema ya existe (0006): `core.corte_caja`, el índice único parcial
-- `corte_unico_abierto_idx` (un solo corte abierto por sucursal, garantizado por
-- la BASE DE DATOS, no por la aplicación), y la vista `core.v_corte_saldo`
-- (0009), que solo suma movimientos activos.
--
-- Aquí va la lógica de abrir y cerrar. El cierre calcula el saldo desde los
-- movimientos y lo guarda junto al que el usuario declara físicamente — el
-- requisito es entregar "lo que se vendió en el día (entradas y salidas)" y que
-- el administrador pueda ver la diferencia.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Abre un corte. Al abrir "únicamente se pide el saldo inicial que corresponde
-- al efectivo que deberá tener la sucursal en caja para dar cambio".
-- Si ya hay uno abierto, el índice único lo rechaza: se traduce a un mensaje
-- claro, pero la garantía es de la BD.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.abrir_corte(
  p_sucursal_id    uuid,
  p_usuario_id     uuid,
  p_saldo_inicial  numeric,
  p_ahora          timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_saldo_inicial IS NULL OR p_saldo_inicial < 0 THEN
    RAISE EXCEPTION 'el saldo inicial no puede ser negativo';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.usuario u
     WHERE u.id = p_usuario_id AND u.activo
       AND u.effective_from <= p_ahora
       AND (u.effective_until IS NULL OR u.effective_until > p_ahora)
  ) THEN
    RAISE EXCEPTION 'el usuario % no existe o no está vigente', p_usuario_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.sucursal WHERE id = p_sucursal_id AND activo) THEN
    RAISE EXCEPTION 'la sucursal % no existe', p_sucursal_id;
  END IF;

  BEGIN
    INSERT INTO core.corte_caja (sucursal_id, usuario_apertura_id, saldo_inicial,
                                 abierto_en, estado)
    VALUES (p_sucursal_id, p_usuario_id, p_saldo_inicial, p_ahora, 'abierto')
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ya existe un corte de caja abierto en la sucursal %', p_sucursal_id;
  END;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION core.abrir_corte(uuid, uuid, numeric, timestamptz) IS
  'Abre un corte de caja con su saldo inicial. Un solo corte abierto por sucursal (constraint).';


-- -----------------------------------------------------------------------------
-- Cierra el corte de turno. Devuelve el desglose y la diferencia entre lo
-- declarado (contado físicamente) y lo calculado (derivado de los movimientos).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.cerrar_corte(
  p_corte_id           uuid,
  p_usuario_cierre_id  uuid,
  p_saldo_declarado    numeric,
  p_ahora              timestamptz DEFAULT now()
)
RETURNS TABLE (
  saldo_inicial    numeric,
  ingresos         numeric,
  egresos          numeric,
  saldo_calculado  numeric,
  saldo_declarado  numeric,
  diferencia       numeric
)
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
  v_sal    record;
BEGIN
  IF p_saldo_declarado IS NULL OR p_saldo_declarado < 0 THEN
    RAISE EXCEPTION 'el saldo declarado no puede ser negativo';
  END IF;

  SELECT c.estado INTO v_estado
    FROM core.corte_caja c WHERE c.id = p_corte_id AND c.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el corte de caja % no existe', p_corte_id;
  END IF;
  IF v_estado = 'cerrado' THEN
    RAISE EXCEPTION 'el corte de caja % ya está cerrado', p_corte_id;
  END IF;

  SELECT s.saldo_inicial, s.ingresos, s.egresos, s.saldo_calculado
    INTO v_sal
    FROM core.v_corte_saldo s WHERE s.corte_caja_id = p_corte_id;

  UPDATE core.corte_caja
     SET estado                = 'cerrado',
         cerrado_en            = p_ahora,
         usuario_cierre_id     = p_usuario_cierre_id,
         saldo_final_declarado = p_saldo_declarado,
         saldo_final_calculado = v_sal.saldo_calculado
   WHERE id = p_corte_id;

  RETURN QUERY SELECT
    v_sal.saldo_inicial, v_sal.ingresos, v_sal.egresos, v_sal.saldo_calculado,
    p_saldo_declarado, p_saldo_declarado - v_sal.saldo_calculado;
END $$;

COMMENT ON FUNCTION core.cerrar_corte(uuid, uuid, numeric, timestamptz) IS
  'Cierra el corte de turno; guarda saldo declarado vs. calculado y devuelve la diferencia.';
