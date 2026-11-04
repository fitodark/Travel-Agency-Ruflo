-- =============================================================================
-- 0087 · Paquetería: mover un envío a otra salida y cancelarlo.
--        docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P10, P11), Fase F.
--
-- REGLAS (PO)
--   * MOVER (P10): si no cupo o se descompuso la unidad, el envío pasa a otra
--     salida — antes de que salga (estado `registrado`). La nueva salida debe
--     pasar por SU terminal de origen y por SU destino, en ese orden, seguir
--     recibiendo envíos en el origen y no haber cerrado (5 min, como al
--     registrar). Los tickets impresos llevan la salida anterior: se reimprime
--     todo (recibo + tickets) en automático.
--   * CANCELAR (P11): antes de la salida (estado `registrado`). El reembolso
--     SOLO existe para lo cobrado en EFECTIVO: egreso 'devolucion' en el corte
--     abierto de la sucursal que cobró. Un envío pagado por TRANSFERENCIA no se
--     cancela desde el sistema (el PO limitó el reembolso a efectivo): se
--     rechaza con un mensaje claro en vez de cancelar sin devolver. Un envío
--     por cobrar (sin cobro) se cancela sin movimiento de dinero.
--
-- Las dos las hace la terminal de ORIGEN (dueña del envío, clase B): mover
-- actualiza su fila; los hechos quedan como `evento_envio` ('movido' /
-- 'cancelado'), que la réplica lleva al destino.
--
-- Requiere 0086.
-- =============================================================================


-- 1. Mover a otra salida
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.mover_envio(
  p_envio_id        uuid,
  p_salida_nueva_id uuid,
  p_sucursal_id     uuid,
  p_usuario_id      uuid,
  p_ahora           timestamptz DEFAULT now()
)
RETURNS TABLE (envio_id uuid, salida_id uuid, print_jobs integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_e          core.envio%ROWTYPE;
  v_estado     text;
  v_est_salida text;
  v_o_orden    integer;
  v_o_hora     timestamptz;
  v_d_orden    integer;
  v_cierre_min integer;
  v_pj         integer;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.mover_envio no se ejecuta durante la replicación';
  END IF;

  SELECT * INTO v_e FROM core.envio WHERE id = p_envio_id AND activo FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el envío % no existe', p_envio_id;
  END IF;
  IF v_e.sucursal_origen_id <> p_sucursal_id THEN
    RAISE EXCEPTION 'solo la sucursal de origen del envío puede moverlo';
  END IF;
  SELECT es.estado INTO v_estado FROM core.v_envio_estado es WHERE es.envio_id = p_envio_id;
  IF v_estado <> 'registrado' THEN
    RAISE EXCEPTION 'el envío ya está %: solo se mueve antes de salir', v_estado;
  END IF;
  IF p_salida_nueva_id = v_e.salida_id THEN
    RAISE EXCEPTION 'el envío ya va en esa salida';
  END IF;

  SELECT s.estado INTO v_est_salida FROM core.salida s WHERE s.id = p_salida_nueva_id AND s.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_nueva_id;
  END IF;

  SELECT sp.orden, sp.hora_paso_programada INTO v_o_orden, v_o_hora
    FROM core.salida_parada sp JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_nueva_id AND pr.sucursal_id = v_e.sucursal_origen_id
     AND pr.tipo = 'terminal'
   ORDER BY sp.orden LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la nueva salida no pasa por la terminal de origen del envío';
  END IF;
  SELECT sp.orden INTO v_d_orden
    FROM core.salida_parada sp JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_nueva_id AND pr.sucursal_id = v_e.sucursal_destino_id
     AND pr.tipo = 'terminal' AND sp.orden > v_o_orden
   ORDER BY sp.orden LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la nueva salida no llega al destino del envío después de su origen';
  END IF;
  IF NOT core.salida_vendible(v_est_salida, v_o_orden) THEN
    RAISE EXCEPTION 'la salida % está % : ya no recibe envíos aquí', p_salida_nueva_id, v_est_salida;
  END IF;

  v_cierre_min := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_cierre_paqueteria' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1), 5);
  IF v_o_hora IS NOT NULL AND v_o_hora - make_interval(mins => v_cierre_min) <= p_ahora THEN
    RAISE EXCEPTION 'el registro de envíos para la nueva salida cerró % minutos antes de su paso (%)',
      v_cierre_min, v_o_hora;
  END IF;

  UPDATE core.envio
     SET salida_id = p_salida_nueva_id,
         parada_origen_orden = v_o_orden,
         parada_destino_orden = v_d_orden
   WHERE id = p_envio_id;

  INSERT INTO core.evento_envio (envio_id, tipo, sucursal_id, usuario_id, detalle, ocurrido_en)
  VALUES (p_envio_id, 'movido', p_sucursal_id, p_usuario_id,
          jsonb_build_object('salida_anterior', v_e.salida_id, 'salida_nueva', p_salida_nueva_id),
          p_ahora);

  -- Lo que no se imprimió de la salida vieja ya no sirve; lo impreso se rehace.
  UPDATE core.print_job
     SET activo = false, desactivado_motivo = 'envío movido de salida'
   WHERE print_job.envio_id = p_envio_id AND estado = 'pendiente' AND activo;
  v_pj := core.reimprimir_envio(p_envio_id, p_sucursal_id, 'todo', 'cambio de salida');

  RETURN QUERY SELECT p_envio_id, p_salida_nueva_id, v_pj;
END $$;

COMMENT ON FUNCTION core.mover_envio(uuid, uuid, uuid, uuid, timestamptz) IS
  'P10. Mueve un envío aún no despachado a otra salida que pase por su origen y su destino; reimprime recibo y tickets. Solo la terminal de origen. 0087.';


-- 2. Cancelar (reembolso solo efectivo)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.cancelar_envio(
  p_envio_id    uuid,
  p_sucursal_id uuid,
  p_usuario_id  uuid,
  p_motivo      text,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS TABLE (envio_id uuid, reembolso numeric)
LANGUAGE plpgsql AS $$
DECLARE
  v_e        core.envio%ROWTYPE;
  v_estado   text;
  v_corte    uuid;
  v_total    numeric := 0;
  v_p        record;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.cancelar_envio no se ejecuta durante la replicación';
  END IF;
  IF btrim(COALESCE(p_motivo, '')) = '' THEN
    RAISE EXCEPTION 'la cancelación necesita un motivo';
  END IF;

  SELECT * INTO v_e FROM core.envio WHERE id = p_envio_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el envío % no existe', p_envio_id;
  END IF;
  IF v_e.sucursal_origen_id <> p_sucursal_id THEN
    RAISE EXCEPTION 'solo la sucursal de origen del envío puede cancelarlo';
  END IF;
  SELECT es.estado INTO v_estado FROM core.v_envio_estado es WHERE es.envio_id = p_envio_id;
  IF v_estado <> 'registrado' THEN
    RAISE EXCEPTION 'el envío ya está %: solo se cancela antes de salir', v_estado;
  END IF;

  -- P11: el reembolso existe solo para efectivo.
  IF EXISTS (SELECT 1 FROM core.pago_envio
              WHERE pago_envio.envio_id = p_envio_id AND activo AND metodo = 'transferencia') THEN
    RAISE EXCEPTION 'el envío se pagó por transferencia: el reembolso desde el sistema solo aplica a pagos en efectivo';
  END IF;

  FOR v_p IN
    SELECT p.id, p.monto, p.sucursal_cobro_id
      FROM core.pago_envio p
     WHERE p.envio_id = p_envio_id AND p.activo AND p.metodo = 'efectivo'
  LOOP
    v_corte := core.corte_abierto(v_p.sucursal_cobro_id);
    IF v_corte IS NULL THEN
      RAISE EXCEPTION 'abre un corte de caja para registrar el reembolso de $%', v_p.monto;
    END IF;
    INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, origen_id,
                                      descripcion, monto, usuario_id, registrado_en)
    VALUES (v_corte, 'egreso', 'devolucion', v_p.id,
            format('Reembolso envío %s', v_e.folio), v_p.monto, p_usuario_id, p_ahora);
    v_total := v_total + v_p.monto;
  END LOOP;

  INSERT INTO core.evento_envio (envio_id, tipo, sucursal_id, usuario_id, detalle, ocurrido_en)
  VALUES (p_envio_id, 'cancelado', p_sucursal_id, p_usuario_id,
          jsonb_build_object('motivo', btrim(p_motivo), 'reembolso', v_total),
          p_ahora);

  UPDATE core.print_job
     SET activo = false, desactivado_motivo = 'envío cancelado'
   WHERE print_job.envio_id = p_envio_id AND estado = 'pendiente' AND activo;

  RETURN QUERY SELECT p_envio_id, v_total;
END $$;

COMMENT ON FUNCTION core.cancelar_envio(uuid, uuid, uuid, text, timestamptz) IS
  'P11. Cancela un envío aún no despachado. Reembolso solo de lo cobrado en efectivo (egreso en el corte abierto de quien cobró); pagado por transferencia ⇒ se rechaza. Solo la terminal de origen. 0087.';
