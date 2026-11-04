-- =============================================================================
-- 0084 · Paquetería: núcleo (envío, pago, eventos de custodia).
--        docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P1..P6, P8), Fase C.
--        docs/architecture/04-riesgos-roadmap.md §1 (costuras E1, E2, E5).
--
-- MODELO
--   * `core.envio` (clase B, dueña = terminal de ORIGEN): un envío = N bultos
--     con UNA descripción, UN importe (> 0) y UN folio, en una salida concreta,
--     de una terminal con sistema a otra posterior en la ruta (P1, P2).
--     Modalidad `pagado` (completo en origen) o `por_cobrar` (completo en
--     destino), sin anticipos (P3).
--   * `core.pago_envio` (clase C): el cobro, en origen o en destino. Efectivo
--     o transferencia; la transferencia NO bloquea: entra `verificado = false`
--     y suma al corte al confirmarse (P4, igual que boletos 0065). Su ingreso
--     es un `movimiento_caja` 'pago_paqueteria' (costura E2, ya en el CHECK).
--   * `core.evento_envio` (clase C, append-only — costura E5): la custodia.
--     Origen y destino escriben eventos, nunca la fila del envío, así que no
--     chocan al sincronizar. El estado se DERIVA (`core.v_envio_estado`) por
--     precedencia, no por reloj: cancelado > entregado > en_sucursal > en_ruta
--     > registrado (P8).
--   * Folio con el MISMO generador que los boletos (`core.siguiente_folio`,
--     costura E1): un folio nunca es a la vez boleto y envío (P5).
--   * Registro hasta N minutos (parámetro `minutos_cierre_paqueteria`, 5)
--     antes de que la salida pase por la terminal de origen (P6). La salida
--     debe ser vendible desde ese origen (`core.salida_vendible`, 0082).
--
-- CORTE. `core.v_corte_saldo` (0065) clasificaba como efectivo todo ingreso
-- que no fuera un `core.pago` de transferencia — un pago de paquetería por
-- transferencia se habría contado como efectivo. Ahora mira también
-- `core.pago_envio`.
--
-- RÉPLICA (0083). Las tres tablas bajan a la terminal de origen y a la de
-- destino del envío (menos a la que escribió): el destino ve el envío para
-- recibirlo, entregarlo y cobrarlo.
--
-- FUERA (fases siguientes): impresión de recibo/tickets (D), en_ruta /
-- en_sucursal / entrega / cobro en destino (E), mover/cancelar y sección del
-- manifiesto, apartado del corte e historial (F), pantallas (G).
--
-- FKs `DEFERRABLE INITIALLY IMMEDIATE` (invariante de 0040). Requiere 0083.
-- =============================================================================


-- 1. Tablas
-- ---------------------------------------------------------------------------
CREATE TABLE core.envio (
  id                    uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  folio                 char(6) NOT NULL UNIQUE,
  salida_id             uuid NOT NULL REFERENCES core.salida(id) DEFERRABLE INITIALLY IMMEDIATE,
  sucursal_origen_id    uuid NOT NULL REFERENCES core.sucursal(id) DEFERRABLE INITIALLY IMMEDIATE,
  sucursal_destino_id   uuid NOT NULL REFERENCES core.sucursal(id) DEFERRABLE INITIALLY IMMEDIATE,
  parada_origen_orden   smallint NOT NULL,
  parada_destino_orden  smallint NOT NULL,
  usuario_id            uuid NOT NULL REFERENCES core.usuario(id) DEFERRABLE INITIALLY IMMEDIATE,
  remitente_nombre      text NOT NULL CHECK (char_length(btrim(remitente_nombre)) BETWEEN 1 AND 120),
  remitente_telefono    text NOT NULL CHECK (char_length(btrim(remitente_telefono)) BETWEEN 1 AND 40),
  destinatario_nombre   text NOT NULL CHECK (char_length(btrim(destinatario_nombre)) BETWEEN 1 AND 120),
  destinatario_telefono text NOT NULL CHECK (char_length(btrim(destinatario_telefono)) BETWEEN 1 AND 40),
  descripcion           text NOT NULL CHECK (char_length(btrim(descripcion)) BETWEEN 1 AND 200),
  bultos                smallint NOT NULL CHECK (bultos BETWEEN 1 AND 99),
  importe               numeric(12,2) NOT NULL CHECK (importe > 0),
  modalidad             text NOT NULL CHECK (modalidad IN ('pagado', 'por_cobrar')),
  registrado_en         timestamptz NOT NULL DEFAULT now(),
  CHECK (parada_origen_orden < parada_destino_orden),
  CHECK (sucursal_origen_id <> sucursal_destino_id)
);
SELECT core.registrar_entidad('core.envio');
CREATE INDEX envio_salida_idx ON core.envio (salida_id) WHERE activo;

COMMENT ON TABLE core.envio IS
  'Paquetería (06 §1.2). Un envío = N bultos, una descripción, un importe y un folio, en una salida, de una terminal con sistema a otra. Clase B: dueña la terminal de origen. 0084.';


CREATE TABLE core.pago_envio (
  id                       uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  envio_id                 uuid NOT NULL REFERENCES core.envio(id) DEFERRABLE INITIALLY IMMEDIATE,
  sucursal_cobro_id        uuid NOT NULL REFERENCES core.sucursal(id) DEFERRABLE INITIALLY IMMEDIATE,
  corte_caja_id            uuid NOT NULL REFERENCES core.corte_caja(id) DEFERRABLE INITIALLY IMMEDIATE,
  usuario_id               uuid NOT NULL REFERENCES core.usuario(id) DEFERRABLE INITIALLY IMMEDIATE,
  metodo                   text NOT NULL CHECK (metodo IN ('efectivo', 'transferencia')),
  monto                    numeric(12,2) NOT NULL CHECK (monto > 0),
  verificado               boolean NOT NULL DEFAULT false,
  verificado_por           uuid REFERENCES core.usuario(id) DEFERRABLE INITIALLY IMMEDIATE,
  verificado_en            timestamptz,
  referencia_transferencia text,
  efectivo_recibido        numeric(12,2),
  efectivo_cambio          numeric(12,2),
  pagado_en                timestamptz NOT NULL DEFAULT now(),
  CHECK (metodo = 'efectivo' OR NOT verificado OR verificado_por IS NOT NULL),
  CHECK (efectivo_recibido IS NULL OR (metodo = 'efectivo' AND efectivo_recibido >= monto))
);
SELECT core.registrar_entidad('core.pago_envio');
CREATE INDEX pago_envio_envio_idx ON core.pago_envio (envio_id) WHERE activo;


CREATE TABLE core.evento_envio (
  id           uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  envio_id     uuid NOT NULL REFERENCES core.envio(id) DEFERRABLE INITIALLY IMMEDIATE,
  tipo         text NOT NULL CHECK (tipo IN
                 ('registrado', 'en_ruta', 'en_sucursal', 'entregado', 'cancelado', 'movido')),
  sucursal_id  uuid NOT NULL REFERENCES core.sucursal(id) DEFERRABLE INITIALLY IMMEDIATE,
  usuario_id   uuid NOT NULL REFERENCES core.usuario(id) DEFERRABLE INITIALLY IMMEDIATE,
  detalle      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ocurrido_en  timestamptz NOT NULL DEFAULT now()
);
SELECT core.registrar_entidad('core.evento_envio');
CREATE INDEX evento_envio_envio_idx ON core.evento_envio (envio_id) WHERE activo;


-- 2. Estado derivado: custodia por precedencia + situación del cobro
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_envio_estado AS
SELECT e.id AS envio_id,
       CASE
         WHEN bool_or(ev.tipo = 'cancelado')   THEN 'cancelado'
         WHEN bool_or(ev.tipo = 'entregado')   THEN 'entregado'
         WHEN bool_or(ev.tipo = 'en_sucursal') THEN 'en_sucursal'
         WHEN bool_or(ev.tipo = 'en_ruta')     THEN 'en_ruta'
         ELSE 'registrado'
       END AS estado,
       COALESCE(pg.cobrado, 0)      AS cobrado,
       COALESCE(pg.por_confirmar, 0) AS por_confirmar,
       GREATEST(e.importe - COALESCE(pg.cobrado, 0) - COALESCE(pg.por_confirmar, 0), 0) AS por_cobrar,
       CASE
         WHEN COALESCE(pg.cobrado, 0) >= e.importe THEN 'pagado'
         WHEN COALESCE(pg.cobrado, 0) + COALESCE(pg.por_confirmar, 0) >= e.importe THEN 'por_confirmar'
         ELSE 'pendiente'
       END AS estado_pago
  FROM core.envio e
  LEFT JOIN core.evento_envio ev ON ev.envio_id = e.id AND ev.activo
  LEFT JOIN LATERAL (
    SELECT SUM(p.monto) FILTER (WHERE p.metodo = 'efectivo' OR p.verificado)       AS cobrado,
           SUM(p.monto) FILTER (WHERE p.metodo = 'transferencia' AND NOT p.verificado) AS por_confirmar
      FROM core.pago_envio p
     WHERE p.envio_id = e.id AND p.activo
  ) pg ON true
 WHERE e.activo
 GROUP BY e.id, e.importe, pg.cobrado, pg.por_confirmar;

COMMENT ON VIEW core.v_envio_estado IS
  'P8. Estado de custodia por PRECEDENCIA de eventos (no por reloj: converge igual en todas las réplicas) + situación del cobro (pagado / por_confirmar / pendiente). 0084.';


-- 3. Ingreso al corte (costura E2)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.trg_pago_envio_a_ingreso()
RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF sync.replicando() THEN
    RETURN NEW;
  END IF;

  -- Efectivo desde el inicio; transferencia al verificarse (P4).
  IF NEW.activo AND (NEW.metodo = 'efectivo' OR NEW.verificado)
     AND NOT EXISTS (
       SELECT 1 FROM core.movimiento_caja
        WHERE origen_tipo = 'pago_paqueteria' AND origen_id = NEW.id AND activo
     )
  THEN
    INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, origen_id,
                                      monto, usuario_id, registrado_en)
    VALUES (NEW.corte_caja_id, 'ingreso', 'pago_paqueteria', NEW.id,
            NEW.monto, NEW.usuario_id,
            COALESCE(NEW.verificado_en, NEW.pagado_en, now()));
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.activo AND NOT NEW.activo THEN
    UPDATE core.movimiento_caja
       SET activo = false, desactivado_motivo = 'pago de paquetería cancelado'
     WHERE origen_tipo = 'pago_paqueteria' AND origen_id = NEW.id AND activo;
  END IF;

  RETURN NEW;
END $function$;

CREATE TRIGGER trg_pago_envio_a_ingreso
  AFTER INSERT OR UPDATE ON core.pago_envio
  FOR EACH ROW EXECUTE FUNCTION core.trg_pago_envio_a_ingreso();


-- 4. `core.v_corte_saldo` — la transferencia de paquetería tampoco es efectivo
--    (misma forma que 0065; solo cambia de dónde sale el método).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_corte_saldo AS
SELECT c.id AS corte_caja_id,
       c.saldo_inicial,
       COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='ingreso'), 0) AS ingresos,
       COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='egreso'),  0) AS egresos,
       c.saldo_inicial
         + COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='ingreso'), 0)
         - COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='egreso'),  0)
         AS saldo_calculado,
       COALESCE(SUM(m.monto) FILTER (
         WHERE m.activo AND m.tipo='ingreso'
           AND COALESCE(p.metodo, pe.metodo, '') <> 'transferencia'), 0) AS ingresos_efectivo,
       COALESCE(SUM(m.monto) FILTER (
         WHERE m.activo AND m.tipo='ingreso'
           AND COALESCE(p.metodo, pe.metodo) = 'transferencia'), 0) AS ingresos_transferencia,
       c.saldo_inicial
         + COALESCE(SUM(m.monto) FILTER (
             WHERE m.activo AND m.tipo='ingreso'
               AND COALESCE(p.metodo, pe.metodo, '') <> 'transferencia'), 0)
         - COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='egreso'), 0)
         AS efectivo_calculado
  FROM core.corte_caja c
  LEFT JOIN core.movimiento_caja m ON m.corte_caja_id = c.id
  LEFT JOIN core.pago p        ON p.id  = m.origen_id AND m.origen_tipo = 'pago_boleto'
  LEFT JOIN core.pago_envio pe ON pe.id = m.origen_id AND m.origen_tipo = 'pago_paqueteria'
 WHERE c.activo
 GROUP BY c.id, c.saldo_inicial;

COMMENT ON VIEW core.v_corte_saldo IS
  'Saldo del corte (solo movimientos activos). `efectivo_calculado` = lo que debe estar en la caja (excluye transferencias de boletos Y de paquetería, 0084); `saldo_calculado` = el total. 0065.';


-- 5. Registrar un envío
-- ---------------------------------------------------------------------------
-- Parámetro clase A, bajo `donaji.replicando` para no sellar HLC/outbox (como 0051).
DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);
  INSERT INTO core.parametro (clave, valor, descripcion) VALUES
    ('minutos_cierre_paqueteria', '5'::jsonb,
     'P6 (06 §1.2): minutos antes del paso por la terminal de origen en que se cierra el registro de envíos.')
  ON CONFLICT (clave) DO NOTHING;
  PERFORM set_config('donaji.replicando', 'off', true);
END $$;

CREATE OR REPLACE FUNCTION core.registrar_envio(
  p_salida_id             uuid,
  p_sucursal_origen_id    uuid,
  p_usuario_id            uuid,
  p_sucursal_destino_id   uuid,
  p_remitente_nombre      text,
  p_remitente_telefono    text,
  p_destinatario_nombre   text,
  p_destinatario_telefono text,
  p_descripcion           text,
  p_bultos                integer,
  p_importe               numeric,
  p_modalidad             text,
  p_pago                  jsonb       DEFAULT NULL,   -- {metodo, efectivo_recibido?, referencia?, corte_caja_id?}
  p_ahora                 timestamptz DEFAULT now()
)
RETURNS TABLE (envio_id uuid, folio text, estado_pago text, pago_envio_id uuid)
LANGUAGE plpgsql AS $function$
DECLARE
  v_estado      text;
  v_o_orden     integer;
  v_o_hora      timestamptz;
  v_d_orden     integer;
  v_cierre_min  integer;
  v_metodo      text;
  v_recibido    numeric;
  v_corte       uuid;
  v_folio       char(6);
  v_envio       uuid;
  v_pago        uuid;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.registrar_envio no se ejecuta durante la replicación';
  END IF;

  IF p_modalidad NOT IN ('pagado', 'por_cobrar') THEN
    RAISE EXCEPTION 'modalidad de envío inválida: % (pagado | por_cobrar)', p_modalidad;
  END IF;
  IF p_importe IS NULL OR p_importe <= 0 THEN
    RAISE EXCEPTION 'el importe del envío debe ser mayor a $0';
  END IF;
  IF p_bultos IS NULL OR p_bultos < 1 OR p_bultos > 99 THEN
    RAISE EXCEPTION 'el número de bultos va de 1 a 99';
  END IF;
  IF btrim(COALESCE(p_remitente_nombre, '')) = '' OR btrim(COALESCE(p_remitente_telefono, '')) = ''
     OR btrim(COALESCE(p_destinatario_nombre, '')) = '' OR btrim(COALESCE(p_destinatario_telefono, '')) = ''
     OR btrim(COALESCE(p_descripcion, '')) = '' THEN
    RAISE EXCEPTION 'faltan datos del envío: remitente, destinatario (nombre y celular) y descripción son obligatorios';
  END IF;

  SELECT s.estado INTO v_estado FROM core.salida s WHERE s.id = p_salida_id AND s.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  -- Origen: la terminal de MI sucursal en esta salida.
  SELECT sp.orden, sp.hora_paso_programada INTO v_o_orden, v_o_hora
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id AND pr.sucursal_id = p_sucursal_origen_id
     AND pr.tipo = 'terminal'
   ORDER BY sp.orden LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no pasa por la terminal de esta sucursal', p_salida_id;
  END IF;

  -- Destino: una terminal con sistema, después del origen (P1).
  SELECT sp.orden INTO v_d_orden
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
    JOIN core.sucursal su   ON su.id = pr.sucursal_id
   WHERE sp.salida_id = p_salida_id AND pr.sucursal_id = p_sucursal_destino_id
     AND pr.tipo = 'terminal' AND NOT su.sin_sistema AND su.activo
     AND sp.orden > v_o_orden
   ORDER BY sp.orden LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el destino debe ser una terminal con sistema posterior al origen en esta salida';
  END IF;

  IF NOT core.salida_vendible(v_estado, v_o_orden) THEN
    RAISE EXCEPTION 'la salida % está % : ya no recibe envíos aquí', p_salida_id, v_estado;
  END IF;

  v_cierre_min := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_cierre_paqueteria' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1), 5);
  IF v_o_hora IS NOT NULL AND v_o_hora - make_interval(mins => v_cierre_min) <= p_ahora THEN
    RAISE EXCEPTION 'el registro de envíos para esta salida cerró % minutos antes de su paso (%)',
      v_cierre_min, v_o_hora;
  END IF;

  -- Cobro (P3): pagado ⇒ completo aquí; por cobrar ⇒ nada aquí.
  IF p_modalidad = 'pagado' THEN
    IF p_pago IS NULL THEN
      RAISE EXCEPTION 'un envío pagado se cobra completo al registrarlo';
    END IF;
    v_metodo := p_pago->>'metodo';
    IF v_metodo NOT IN ('efectivo', 'transferencia') THEN
      RAISE EXCEPTION 'método de pago inválido para paquetería: % (efectivo | transferencia)', v_metodo;
    END IF;
    v_recibido := NULLIF(p_pago->>'efectivo_recibido', '')::numeric;
    IF v_recibido IS NOT NULL AND (v_metodo <> 'efectivo' OR v_recibido < p_importe) THEN
      RAISE EXCEPTION 'el efectivo recibido (%) no cubre el importe (%)', v_recibido, p_importe;
    END IF;
    v_corte := COALESCE((p_pago->>'corte_caja_id')::uuid, core.corte_abierto(p_sucursal_origen_id));
    IF v_corte IS NULL THEN
      RAISE EXCEPTION 'abre un corte de caja para cobrar el envío';
    END IF;
  ELSIF p_pago IS NOT NULL THEN
    RAISE EXCEPTION 'un envío por cobrar se paga completo en el destino, no al registrarlo';
  END IF;

  v_folio := core.siguiente_folio(p_sucursal_origen_id);

  INSERT INTO core.envio (folio, salida_id, sucursal_origen_id, sucursal_destino_id,
                          parada_origen_orden, parada_destino_orden, usuario_id,
                          remitente_nombre, remitente_telefono,
                          destinatario_nombre, destinatario_telefono,
                          descripcion, bultos, importe, modalidad, registrado_en)
  VALUES (v_folio, p_salida_id, p_sucursal_origen_id, p_sucursal_destino_id,
          v_o_orden, v_d_orden, p_usuario_id,
          btrim(p_remitente_nombre), btrim(p_remitente_telefono),
          btrim(p_destinatario_nombre), btrim(p_destinatario_telefono),
          btrim(p_descripcion), p_bultos, p_importe, p_modalidad, p_ahora)
  RETURNING id INTO v_envio;

  INSERT INTO core.evento_envio (envio_id, tipo, sucursal_id, usuario_id, ocurrido_en)
  VALUES (v_envio, 'registrado', p_sucursal_origen_id, p_usuario_id, p_ahora);

  IF p_modalidad = 'pagado' THEN
    INSERT INTO core.pago_envio (envio_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                                 metodo, monto, verificado, referencia_transferencia,
                                 efectivo_recibido, efectivo_cambio, pagado_en)
    VALUES (v_envio, p_sucursal_origen_id, v_corte, p_usuario_id,
            v_metodo, p_importe, v_metodo = 'efectivo',
            CASE WHEN v_metodo = 'transferencia' THEN NULLIF(p_pago->>'referencia', '') END,
            v_recibido, v_recibido - p_importe, p_ahora)
    RETURNING id INTO v_pago;
  END IF;

  RETURN QUERY
    SELECT v_envio, v_folio::text, es.estado_pago, v_pago
      FROM core.v_envio_estado es WHERE es.envio_id = v_envio;
END $function$;

COMMENT ON FUNCTION core.registrar_envio(uuid, uuid, uuid, uuid, text, text, text, text, text, integer, numeric, text, jsonb, timestamptz) IS
  'P1..P6 (06 §1.2). Registra un envío en una salida, de mi terminal a una terminal con sistema posterior; folio compartido con boletos; pagado (completo aquí, efectivo o transferencia por confirmar) o por cobrar (en destino). Hasta minutos_cierre_paqueteria antes del paso. 0084.';


-- 6. Confirmar una transferencia de paquetería (P4) — mismo criterio que 0065
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.verificar_transferencia_envio(
  p_pago_envio_id uuid,
  p_usuario_id    uuid,
  p_ahora         timestamptz DEFAULT now()
)
RETURNS TABLE (envio_id uuid, estado_pago text)
LANGUAGE plpgsql AS $function$
DECLARE
  v_pago core.pago_envio%ROWTYPE;
  v_corte uuid;
BEGIN
  SELECT * INTO v_pago FROM core.pago_envio WHERE id = p_pago_envio_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el pago de envío % no existe', p_pago_envio_id;
  END IF;
  IF v_pago.metodo <> 'transferencia' THEN
    RAISE EXCEPTION 'el pago de envío % no es una transferencia', p_pago_envio_id;
  END IF;
  IF v_pago.verificado THEN
    RAISE EXCEPTION 'el pago de envío % ya estaba verificado', p_pago_envio_id;
  END IF;
  IF v_pago.usuario_id <> p_usuario_id
     AND NOT EXISTS (
       SELECT 1 FROM core.usuario u
        JOIN core.rol_permiso rp ON rp.rol = u.rol
       WHERE u.id = p_usuario_id AND rp.permiso = 'pago.transferencia.confirmar'
     )
  THEN
    RAISE EXCEPTION 'solo quien registró el cobro o un gerente/administrador puede confirmar la transferencia';
  END IF;

  -- Entra al corte abierto AHORA de la sucursal de cobro (0065).
  v_corte := core.corte_abierto(v_pago.sucursal_cobro_id);
  IF v_corte IS NULL THEN
    RAISE EXCEPTION 'abre un corte de caja para confirmar la transferencia';
  END IF;

  UPDATE core.pago_envio
     SET verificado = true, verificado_por = p_usuario_id, verificado_en = p_ahora,
         corte_caja_id = v_corte
   WHERE id = p_pago_envio_id;

  RETURN QUERY SELECT es.envio_id, es.estado_pago
                 FROM core.v_envio_estado es WHERE es.envio_id = v_pago.envio_id;
END $function$;


-- 7. Réplica de bajada (0083): el envío y su historia bajan a origen y destino
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.sucursales_de_envio(p_envio_id uuid)
RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(ARRAY[e.sucursal_origen_id, e.sucursal_destino_id], '{}')
    FROM core.envio e WHERE e.id = p_envio_id
$$;

CREATE OR REPLACE FUNCTION sync.destinatarios_bajada(p_tabla text, p_fila jsonb)
RETURNS uuid[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_dest uuid[];
BEGIN
  v_dest := CASE p_tabla
    WHEN 'core.venta'  THEN sync.sucursales_de_salida((p_fila->>'salida_id')::uuid)
    WHEN 'core.boleto' THEN sync.sucursales_de_salida((p_fila->>'salida_id')::uuid)
    WHEN 'core.pago'   THEN sync.sucursales_de_salida(
                              (SELECT v.salida_id FROM core.venta v
                                WHERE v.id = (p_fila->>'venta_id')::uuid))
    WHEN 'core.cliente'    THEN sync.sucursales_con_sistema()
    WHEN 'core.corte_caja' THEN sync.sucursales_con_sistema()
    -- 0084: paquetería → terminal de origen y de destino del envío.
    WHEN 'core.envio'        THEN ARRAY[(p_fila->>'sucursal_origen_id')::uuid,
                                        (p_fila->>'sucursal_destino_id')::uuid]
    WHEN 'core.pago_envio'   THEN sync.sucursales_de_envio((p_fila->>'envio_id')::uuid)
    WHEN 'core.evento_envio' THEN sync.sucursales_de_envio((p_fila->>'envio_id')::uuid)
    ELSE '{}'::uuid[]
  END;
  RETURN array_remove(COALESCE(v_dest, '{}'), (p_fila->>'sync_sucursal_id')::uuid);
END $$;

SELECT sync.bajar_a_terminales(t) FROM unnest(ARRAY[
  'core.envio', 'core.pago_envio', 'core.evento_envio'
]::regclass[]) AS t;
