-- =============================================================================
-- 0089 · Paquetería: pasar UN envío a «en ruta» desde el detalle
--
-- Retro del equipo (4 nov): en Viajes se listan los paquetes que salen en cada
-- viaje y, desde el detalle de un folio, se marca ese envío en ruta al subirlo
-- a la unidad. Hasta aquí solo existía `core.despachar_envios` (0086), que pasa
-- en bloque todos los envíos de una salida.
--
-- Mismas reglas que el despacho en bloque: solo la terminal de origen del
-- envío, solo desde `registrado`, y con la salida todavía viva. Escribe un
-- `core.evento_envio` (clase C, append-only), igual que 0086.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.despachar_envio(
  p_envio_id    uuid,
  p_sucursal_id uuid,
  p_usuario_id  uuid,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS TABLE (envio_id uuid, estado text)
LANGUAGE plpgsql AS $$
DECLARE
  v_origen        uuid;
  v_estado        text;
  v_estado_salida text;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.despachar_envio no se ejecuta durante la replicación';
  END IF;

  SELECT e.sucursal_origen_id, es.estado, s.estado
    INTO v_origen, v_estado, v_estado_salida
    FROM core.envio e
    JOIN core.v_envio_estado es ON es.envio_id = e.id
    JOIN core.salida s          ON s.id = e.salida_id
   WHERE e.id = p_envio_id AND e.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el envío % no existe', p_envio_id;
  END IF;
  IF v_origen <> p_sucursal_id THEN
    RAISE EXCEPTION 'solo la terminal de origen del envío puede marcarlo en ruta';
  END IF;
  IF v_estado <> 'registrado' THEN
    RAISE EXCEPTION 'el envío ya está %: no se puede marcar en ruta', v_estado;
  END IF;
  IF v_estado_salida NOT IN ('programada', 'en_ruta') THEN
    RAISE EXCEPTION 'la salida del envío está %: muévelo a otra salida', v_estado_salida;
  END IF;

  INSERT INTO core.evento_envio (envio_id, tipo, sucursal_id, usuario_id, ocurrido_en)
  VALUES (p_envio_id, 'en_ruta', p_sucursal_id, p_usuario_id, p_ahora);

  RETURN QUERY SELECT es.envio_id, es.estado
                 FROM core.v_envio_estado es WHERE es.envio_id = p_envio_id;
END $$;

COMMENT ON FUNCTION core.despachar_envio(uuid, uuid, uuid, timestamptz) IS
  'P8. Pasa a en_ruta UN envío registrado, desde su terminal de origen (detalle del folio en Viajes). 0089.';
