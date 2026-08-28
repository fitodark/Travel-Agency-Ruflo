-- =============================================================================
-- 0027 · Captura de abordaje y marcado de "en ruta" (F7, slice 2).
-- Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §5
--                  docs/architecture/04-riesgos-roadmap.md §3 (F7)
--
-- El checklist es manual (lápiz) y luego se captura. Corregir un abordaje mal
-- capturado es INSERTAR otro hecho que anula al anterior, nunca un UPDATE: así
-- dos sucursales jamás compiten por la fila (clase C, append-only).
--
-- Al marcar la salida "en ruta" se registra el conductor, la hora del sistema y
-- el estado. Desde ese momento no se puede vender ni reservar — y eso ya lo
-- respetan `core.registrar_venta`, `core.buscar_salidas` y `core.adquirir_lease`,
-- que exigen `estado = 'programada'`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Registra un abordaje (o un "no se presentó", `p_abordo = false`).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.registrar_abordaje(
  p_boleto_id   uuid,
  p_abordo      boolean,
  p_usuario_id  uuid,
  p_sucursal_id uuid,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_salida_id uuid; v_estado text; v_id uuid;
BEGIN
  SELECT b.salida_id, b.estado INTO v_salida_id, v_estado
    FROM core.boleto b WHERE b.id = p_boleto_id AND b.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el boleto % no existe', p_boleto_id;
  END IF;
  IF v_estado = 'cancelado' THEN
    RAISE EXCEPTION 'el boleto % está cancelado', p_boleto_id;
  END IF;

  INSERT INTO core.evento_abordaje (boleto_id, salida_id, abordo, registrado_por,
                                    sucursal_id, registrado_en)
  VALUES (p_boleto_id, v_salida_id, p_abordo, p_usuario_id, p_sucursal_id, p_ahora)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

COMMENT ON FUNCTION core.registrar_abordaje(uuid, boolean, uuid, uuid, timestamptz) IS
  'Captura un abordaje (o no-presentación). Clase C append-only. Blueprint 02b §5.';


-- -----------------------------------------------------------------------------
-- Corrige un abordaje: NUEVO hecho que anula el anterior. El último no anulado
-- manda (`core.v_boleto_abordaje`).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.corregir_abordaje(
  p_evento_id   uuid,
  p_abordo      boolean,
  p_usuario_id  uuid,
  p_sucursal_id uuid,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_prev record; v_id uuid;
BEGIN
  SELECT e.boleto_id, e.salida_id INTO v_prev
    FROM core.evento_abordaje e WHERE e.id = p_evento_id AND e.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el evento de abordaje % no existe', p_evento_id;
  END IF;

  INSERT INTO core.evento_abordaje (boleto_id, salida_id, abordo, registrado_por,
                                    sucursal_id, registrado_en, anula_evento_id)
  VALUES (v_prev.boleto_id, v_prev.salida_id, p_abordo, p_usuario_id, p_sucursal_id,
          p_ahora, p_evento_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

COMMENT ON FUNCTION core.corregir_abordaje(uuid, boolean, uuid, uuid, timestamptz) IS
  'Corrige un abordaje insertando un hecho que anula al anterior. Nunca un UPDATE.';


-- -----------------------------------------------------------------------------
-- Marca la salida "en ruta": conductor, hora del sistema, estado. Bloquea la
-- venta desde este instante.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.marcar_en_ruta(
  p_salida_id     uuid,
  p_usuario_id    uuid,
  p_conductor_id  uuid        DEFAULT NULL,
  p_ahora         timestamptz DEFAULT now()
)
RETURNS TABLE (salida_id uuid, estado text, salida_real_en timestamptz)
LANGUAGE plpgsql AS $$
DECLARE v_estado text; v_nombre text;
BEGIN
  SELECT s.estado INTO v_estado FROM core.salida s WHERE s.id = p_salida_id AND s.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado <> 'programada' THEN
    RAISE EXCEPTION 'la salida % está % : no se puede marcar en ruta', p_salida_id, v_estado;
  END IF;

  IF p_conductor_id IS NOT NULL THEN
    SELECT c.nombre INTO v_nombre FROM core.conductor c WHERE c.id = p_conductor_id AND c.activo;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'el conductor % no existe', p_conductor_id;
    END IF;
  END IF;

  INSERT INTO core.evento_salida (salida_id, tipo, ocurrido_en, registrado_por)
  VALUES (p_salida_id, 'en_ruta', p_ahora, p_usuario_id);

  UPDATE core.salida
     SET estado         = 'en_ruta',
         salida_real_en  = p_ahora,
         conductor_id    = COALESCE(p_conductor_id, conductor_id),
         conductor_nombre_snapshot = COALESCE(v_nombre, conductor_nombre_snapshot)
   WHERE id = p_salida_id;

  RETURN QUERY SELECT p_salida_id, 'en_ruta'::text, p_ahora;
END $$;

COMMENT ON FUNCTION core.marcar_en_ruta(uuid, uuid, uuid, timestamptz) IS
  'Marca una salida en ruta (conductor + hora del sistema). Bloquea la venta. F7.';


-- -----------------------------------------------------------------------------
-- Cierra el viaje.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.finalizar_salida(
  p_salida_id  uuid,
  p_usuario_id uuid,
  p_ahora      timestamptz DEFAULT now()
)
RETURNS TABLE (salida_id uuid, estado text)
LANGUAGE plpgsql AS $$
DECLARE v_estado text;
BEGIN
  SELECT s.estado INTO v_estado FROM core.salida s WHERE s.id = p_salida_id AND s.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado <> 'en_ruta' THEN
    RAISE EXCEPTION 'la salida % está % : solo se finaliza una que esté en ruta', p_salida_id, v_estado;
  END IF;

  INSERT INTO core.evento_salida (salida_id, tipo, ocurrido_en, registrado_por)
  VALUES (p_salida_id, 'finalizada', p_ahora, p_usuario_id);

  UPDATE core.salida SET estado = 'finalizada' WHERE id = p_salida_id;
  RETURN QUERY SELECT p_salida_id, 'finalizada'::text;
END $$;

COMMENT ON FUNCTION core.finalizar_salida(uuid, uuid, timestamptz) IS
  'Cierra un viaje en ruta. F7.';


-- -----------------------------------------------------------------------------
-- Checklist de abordaje de una salida: por boleto vivo, el último estado
-- capturado (abordó / no se presentó / pendiente).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_checklist_abordaje AS
SELECT b.salida_id,
       b.id            AS boleto_id,
       b.folio,
       b.asiento_num,
       b.pasajero_nombre,
       b.tramos,
       (b.estado = 'conflicto_sobreventa') AS conflicto,
       CASE
         WHEN ab.abordo IS TRUE  THEN 'abordo'
         WHEN ab.abordo IS FALSE THEN 'no_presento'
         ELSE 'pendiente'
       END AS estado_abordaje,
       ab.registrado_en AS capturado_en
  FROM core.boleto b
  LEFT JOIN core.v_boleto_abordaje ab ON ab.boleto_id = b.id
 WHERE b.activo AND b.estado <> 'cancelado';

COMMENT ON VIEW core.v_checklist_abordaje IS
  'Checklist de abordaje por salida: el último hecho no anulado por boleto. F7.';
