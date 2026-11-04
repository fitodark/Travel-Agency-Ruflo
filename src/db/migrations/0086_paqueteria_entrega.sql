-- =============================================================================
-- 0086 · Paquetería: en ruta, recepción en destino, entrega y cobro por cobrar.
--        docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P8, P9), Fase E.
--
-- REGLAS (PO)
--   * `en_ruta`: cuando el envío sale de su terminal de origen. Para el origen
--     de la salida es automático al "Marcar en ruta"; una terminal intermedia
--     (que no marca la salida) despacha sus envíos con su propia acción.
--   * `en_sucursal`: lo registra la terminal DESTINO al recibir el paquete;
--     queda disponible para recoger (con su cobro pendiente si es por cobrar).
--   * `entregado`: solo al DESTINATARIO registrado. El vendedor verifica su
--     NOMBRE COMPLETO contra la credencial de elector; NUNCA se captura el
--     número de la credencial (dato personal sensible). Si es por cobrar, se
--     cobra completo ahí, en el corte del destino, en efectivo o transferencia
--     (la transferencia no detiene la entrega: queda por confirmar).
--
-- Todo se escribe como `core.evento_envio` / `core.pago_envio` (clase C): el
-- destino nunca toca la fila del envío (clase B del origen), así que origen y
-- destino no chocan al sincronizar. La réplica de bajada (0083/0084) lleva
-- cada evento a la otra terminal.
--
-- CAMBIOS
--   1. `core.despachar_envios(salida, sucursal, usuario)`.
--   2. `core.marcar_en_ruta` despacha los envíos del origen (CREATE OR
--      REPLACE, misma firma; idéntica a 0074 salvo « 0086 »).
--   3. `core.recibir_envio(envio, sucursal, usuario)`.
--   4. `core.entregar_envio(envio, sucursal, usuario, nombre_verificado, pago)`.
--
-- Requiere 0084/0085.
-- =============================================================================


-- 1. Despachar: los envíos que salen de ESTA terminal pasan a en ruta
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.despachar_envios(
  p_salida_id   uuid,
  p_sucursal_id uuid,
  p_usuario_id  uuid,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  INSERT INTO core.evento_envio (envio_id, tipo, sucursal_id, usuario_id, ocurrido_en)
  SELECT e.id, 'en_ruta', p_sucursal_id, p_usuario_id, p_ahora
    FROM core.envio e
    JOIN core.v_envio_estado es ON es.envio_id = e.id
   WHERE e.salida_id = p_salida_id
     AND e.sucursal_origen_id = p_sucursal_id
     AND e.activo
     AND es.estado = 'registrado';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

COMMENT ON FUNCTION core.despachar_envios(uuid, uuid, uuid, timestamptz) IS
  'P8. Pasa a en_ruta los envíos registrados de la salida que salen de esa terminal. Lo llama marcar_en_ruta para el origen; las intermedias, a mano. 0086.';


-- 2. `core.marcar_en_ruta` — despacha los envíos del origen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.marcar_en_ruta(
  p_salida_id     uuid,
  p_usuario_id    uuid,
  p_ahora         timestamptz DEFAULT now()
)
RETURNS TABLE (salida_id uuid, estado text, salida_real_en timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
  v_origen uuid;   -- 0086
BEGIN
  SELECT s.estado INTO v_estado FROM core.salida s WHERE s.id = p_salida_id AND s.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado <> 'programada' THEN
    RAISE EXCEPTION 'la salida % está % : no se puede marcar en ruta', p_salida_id, v_estado;
  END IF;

  INSERT INTO core.evento_salida (salida_id, tipo, ocurrido_en, registrado_por)
  VALUES (p_salida_id, 'en_ruta', p_ahora, p_usuario_id);

  UPDATE core.salida
     SET estado         = 'en_ruta',
         salida_real_en  = p_ahora
   WHERE id = p_salida_id;

  -- 0086 (P8): los paquetes que salen del origen van en ruta con la unidad.
  SELECT pr.sucursal_id INTO v_origen
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id AND sp.orden = 0;
  IF v_origen IS NOT NULL THEN
    PERFORM core.despachar_envios(p_salida_id, v_origen, p_usuario_id, p_ahora);
  END IF;

  RETURN QUERY SELECT p_salida_id, 'en_ruta'::text, p_ahora;
END $$;

COMMENT ON FUNCTION core.marcar_en_ruta(uuid, uuid, timestamptz) IS
  'Marca una salida en ruta (hora del sistema). Bloquea la venta en el origen. Despacha los envíos del origen (0086). El conductor se asigna aparte (0074). F7.';


-- 3. Recibir en destino
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.recibir_envio(
  p_envio_id    uuid,
  p_sucursal_id uuid,
  p_usuario_id  uuid,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS TABLE (envio_id uuid, estado text, estado_pago text, por_cobrar numeric)
LANGUAGE plpgsql AS $$
DECLARE
  v_destino uuid;
  v_estado  text;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.recibir_envio no se ejecuta durante la replicación';
  END IF;

  SELECT e.sucursal_destino_id, es.estado INTO v_destino, v_estado
    FROM core.envio e JOIN core.v_envio_estado es ON es.envio_id = e.id
   WHERE e.id = p_envio_id AND e.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el envío % no existe', p_envio_id;
  END IF;
  IF v_destino <> p_sucursal_id THEN
    RAISE EXCEPTION 'solo la sucursal destino del envío puede recibirlo';
  END IF;
  -- Desde `registrado` también: si el origen no lo despachó, el paquete igual
  -- llegó físicamente y es el destino quien lo tiene en la mano.
  IF v_estado NOT IN ('registrado', 'en_ruta') THEN
    RAISE EXCEPTION 'el envío ya está %: no se puede recibir', v_estado;
  END IF;

  INSERT INTO core.evento_envio (envio_id, tipo, sucursal_id, usuario_id, ocurrido_en)
  VALUES (p_envio_id, 'en_sucursal', p_sucursal_id, p_usuario_id, p_ahora);

  RETURN QUERY SELECT es.envio_id, es.estado, es.estado_pago, es.por_cobrar
                 FROM core.v_envio_estado es WHERE es.envio_id = p_envio_id;
END $$;

COMMENT ON FUNCTION core.recibir_envio(uuid, uuid, uuid, timestamptz) IS
  'P8. La terminal destino registra que el paquete llegó (en_sucursal): queda disponible para recoger. 0086.';


-- 4. Entregar (y cobrar si es por cobrar)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.entregar_envio(
  p_envio_id          uuid,
  p_sucursal_id       uuid,
  p_usuario_id        uuid,
  p_nombre_verificado boolean,
  p_pago              jsonb       DEFAULT NULL,   -- {metodo, efectivo_recibido?, referencia?, corte_caja_id?}
  p_ahora             timestamptz DEFAULT now()
)
RETURNS TABLE (envio_id uuid, estado text, estado_pago text, pago_envio_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_e        core.envio%ROWTYPE;
  v_estado   text;
  v_pendiente numeric;
  v_metodo   text;
  v_recibido numeric;
  v_corte    uuid;
  v_pago     uuid;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.entregar_envio no se ejecuta durante la replicación';
  END IF;

  SELECT * INTO v_e FROM core.envio WHERE id = p_envio_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el envío % no existe', p_envio_id;
  END IF;
  IF v_e.sucursal_destino_id <> p_sucursal_id THEN
    RAISE EXCEPTION 'solo la sucursal destino del envío puede entregarlo';
  END IF;

  SELECT es.estado, es.por_cobrar INTO v_estado, v_pendiente
    FROM core.v_envio_estado es WHERE es.envio_id = p_envio_id;
  IF v_estado <> 'en_sucursal' THEN
    RAISE EXCEPTION 'el envío está %: primero regístralo como recibido en sucursal', v_estado;
  END IF;

  -- P9: solo al destinatario, verificado contra su credencial de elector. El
  -- sistema registra QUE se verificó, nunca el número de la credencial.
  IF NOT COALESCE(p_nombre_verificado, false) THEN
    RAISE EXCEPTION 'verifica que el nombre completo de la credencial de elector coincida con el destinatario (%)',
      v_e.destinatario_nombre;
  END IF;

  -- Cobro en destino: completo, sin intermedios (P3).
  IF v_pendiente > 0 THEN
    IF p_pago IS NULL THEN
      RAISE EXCEPTION 'el envío es por cobrar: cobra $% antes de entregarlo', v_pendiente;
    END IF;
    v_metodo := p_pago->>'metodo';
    IF v_metodo NOT IN ('efectivo', 'transferencia') THEN
      RAISE EXCEPTION 'método de pago inválido para paquetería: % (efectivo | transferencia)', v_metodo;
    END IF;
    v_recibido := NULLIF(p_pago->>'efectivo_recibido', '')::numeric;
    IF v_recibido IS NOT NULL AND (v_metodo <> 'efectivo' OR v_recibido < v_pendiente) THEN
      RAISE EXCEPTION 'el efectivo recibido (%) no cubre el monto por cobrar (%)', v_recibido, v_pendiente;
    END IF;
    v_corte := COALESCE((p_pago->>'corte_caja_id')::uuid, core.corte_abierto(p_sucursal_id));
    IF v_corte IS NULL THEN
      RAISE EXCEPTION 'abre un corte de caja para cobrar el envío';
    END IF;

    INSERT INTO core.pago_envio (envio_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                                 metodo, monto, verificado, referencia_transferencia,
                                 efectivo_recibido, efectivo_cambio, pagado_en)
    VALUES (p_envio_id, p_sucursal_id, v_corte, p_usuario_id,
            v_metodo, v_pendiente, v_metodo = 'efectivo',
            CASE WHEN v_metodo = 'transferencia' THEN NULLIF(p_pago->>'referencia', '') END,
            v_recibido, v_recibido - v_pendiente, p_ahora)
    RETURNING id INTO v_pago;
  ELSIF p_pago IS NOT NULL THEN
    RAISE EXCEPTION 'el envío ya está pagado: no hay nada que cobrar';
  END IF;

  INSERT INTO core.evento_envio (envio_id, tipo, sucursal_id, usuario_id, detalle, ocurrido_en)
  VALUES (p_envio_id, 'entregado', p_sucursal_id, p_usuario_id,
          jsonb_build_object('entregado_a', v_e.destinatario_nombre,
                             'verificado_contra', 'credencial_elector'),
          p_ahora);

  RETURN QUERY SELECT es.envio_id, es.estado, es.estado_pago, v_pago
                 FROM core.v_envio_estado es WHERE es.envio_id = p_envio_id;
END $$;

COMMENT ON FUNCTION core.entregar_envio(uuid, uuid, uuid, boolean, jsonb, timestamptz) IS
  'P9. Entrega al destinatario (nombre verificado contra la credencial; nunca se guarda su número). Por cobrar ⇒ cobro completo en el corte del destino (transferencia queda por confirmar). 0086.';
