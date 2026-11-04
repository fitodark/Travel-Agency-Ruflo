-- =============================================================================
-- 0088 · Paquetería en el manifiesto, en el corte y en el historial.
--        docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P12, P13), Fase F.
--
-- REGLAS (PO)
--   * El manifiesto lleva una SEGUNDA sección con los paquetes que la unidad
--     se lleva al partir: solo folio, descripción, monto (marcando POR COBRAR)
--     y destino. Sin QR ni numeración n/N (esa va en los tickets de los bultos).
--     Cada terminal lista los paquetes que se cargan ahí (mismo criterio por
--     terminal que los pasajeros, 0081).
--   * Los cobros de paquetería se reflejan en el corte como ingresos (ya
--     suman desde 0084) y se distinguen en el corte y en el historial.
--
-- CAMBIOS
--   1. `core.datos_manifiesto` gana la clave `paquetes` (CREATE OR REPLACE,
--      misma firma; idéntica a 0081 salvo « 0088 »).
--   2. `core.trg_pago_envio_a_ingreso` pone una DESCRIPCIÓN al ingreso
--      ("Envío 1A2B3C · 5 cajas de ropa → CDMX"): Caja e Historial ya muestran
--      la descripción del movimiento, así que se distingue sin tocar pantallas.
--      Backfill de los ingresos de paquetería existentes sin descripción.
--   3. `core.movimientos_corte_detalle` (historial) gana `envio` (folio,
--      descripción, destino, destinatario, bultos, modalidad) y toma método y
--      referencia también del pago de paquetería. DROP + CREATE (RETURNS TABLE).
--
-- Requiere 0087.
-- =============================================================================


-- 1. `core.datos_manifiesto` — sección de paquetes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.datos_manifiesto(
  p_salida_id   uuid,
  p_copia       text        DEFAULT 'terminal',
  p_ahora       timestamptz DEFAULT now(),
  p_sucursal_id uuid        DEFAULT NULL     -- 0081: NULL = lista completa
)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sal       record;
  v_paradas   jsonb;
  v_pasajeros jsonb;
  v_terminal  text;
  v_t_orden   integer;
  v_paquetes  jsonb;   -- 0088
BEGIN
  IF p_copia NOT IN ('conductor', 'terminal') THEN
    RAISE EXCEPTION 'copia de manifiesto inválida: %', p_copia;
  END IF;

  SELECT s.id, s.fecha_operacion, s.conductor_nombre_snapshot, s.estado,
         u.numero_economico, tu.clave AS tipo_unidad
    INTO v_sal
    FROM core.salida s
    LEFT JOIN core.unidad u  ON u.id  = s.unidad_id
    JOIN core.tipo_unidad tu ON tu.id = s.tipo_unidad_id
   WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  -- 0081: la terminal cuyo manifiesto es (la primera parada de esa sucursal).
  IF p_sucursal_id IS NOT NULL THEN
    SELECT pr.nombre, sp.orden INTO v_terminal, v_t_orden
      FROM core.salida_parada sp
      JOIN core.punto_ruta pr ON pr.id = sp.punto_id
     WHERE sp.salida_id = p_salida_id AND pr.sucursal_id = p_sucursal_id
     ORDER BY sp.orden LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'la salida % no pasa por la sucursal %', p_salida_id, p_sucursal_id;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'orden', sp.orden, 'punto', pr.nombre, 'tipo', pr.tipo,
           'hora_paso', sp.hora_paso_programada) ORDER BY sp.orden), '[]'::jsonb)
    INTO v_paradas
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id;

  -- Lista única por boleto vivo; con sucursal, solo los que cubre su terminal.
  -- `cobrar` = importe del boleto si la venta se cobra por conductor (0079).
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'folio',          b.folio,
             'asiento',        b.asiento_num,
             'nombre',         b.pasajero_nombre,
             'sube_en',        puo.nombre,
             'sube_en_orden',  spo.orden,
             'baja_en',        pud.nombre,
             'baja_en_orden',  spd.orden,
             'estatus_pago',   CASE WHEN COALESCE(vs.saldo_pendiente, 0) <= 0
                                    THEN 'pagado' ELSE 'pendiente' END,
             'conflicto',      (b.estado = 'conflicto_sobreventa'),
             'lugar_abordaje', v.lugar_abordaje,
             'cobrar',         CASE WHEN EXISTS (
                                 SELECT 1 FROM core.pago p
                                  WHERE p.venta_id = b.venta_id AND p.activo
                                    AND p.metodo = 'conductor')
                               THEN b.importe END
           )
           ORDER BY spo.orden, (v.lugar_abordaje IS NOT NULL), b.asiento_num
         ), '[]'::jsonb)
    INTO v_pasajeros
    FROM core.boleto b
    JOIN core.venta v ON v.id = b.venta_id
    JOIN core.salida_parada spo
      ON spo.salida_id = p_salida_id AND spo.orden = lower(b.tramos)
    JOIN core.punto_ruta puo ON puo.id = spo.punto_id
    JOIN core.salida_parada spd
      ON spd.salida_id = p_salida_id AND spd.orden = upper(b.tramos)
    JOIN core.punto_ruta pud ON pud.id = spd.punto_id
    LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = b.venta_id
   WHERE b.salida_id = p_salida_id
     AND b.activo
     AND b.estado <> 'cancelado'
     AND (p_sucursal_id IS NULL
          OR core.terminal_que_cubre(p_salida_id, lower(b.tramos)) = p_sucursal_id);

  -- 0088 (P12 / REQ-11): los paquetes que la unidad se lleva de ESTA terminal
  -- (con sucursal) o de toda la salida (sin ella). Solo folio, descripción,
  -- monto (marcando POR COBRAR) y destino.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'folio',       e.folio,
           'descripcion', e.descripcion,
           'monto',       e.importe,
           'por_cobrar',  CASE WHEN es.por_cobrar > 0 THEN es.por_cobrar END,
           'destino',     sd.nombre
         ) ORDER BY e.registrado_en), '[]'::jsonb)
    INTO v_paquetes
    FROM core.envio e
    JOIN core.v_envio_estado es ON es.envio_id = e.id
    JOIN core.sucursal sd ON sd.id = e.sucursal_destino_id
   WHERE e.salida_id = p_salida_id AND e.activo
     AND es.estado <> 'cancelado'
     AND (p_sucursal_id IS NULL OR e.sucursal_origen_id = p_sucursal_id);

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'salida_id',       v_sal.id,
    'copia',           p_copia,
    'fecha_operacion', v_sal.fecha_operacion,
    'estado_salida',   v_sal.estado,
    'conductor',       v_sal.conductor_nombre_snapshot,
    'unidad',          v_sal.numero_economico,
    'tipo_unidad',     v_sal.tipo_unidad,
    'generado_en',     p_ahora,
    'terminal',        v_terminal,
    'terminal_orden',  v_t_orden,
    'paradas',         v_paradas,
    'pasajeros',       v_pasajeros,
    'paquetes',        v_paquetes
  ));
END $$;


-- 2. Descripción del ingreso de paquetería
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.descripcion_ingreso_envio(p_pago_envio_id uuid)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format('Envío %s · %s → %s', e.folio, e.descripcion, sd.nombre)
    FROM core.pago_envio p
    JOIN core.envio e     ON e.id  = p.envio_id
    JOIN core.sucursal sd ON sd.id = e.sucursal_destino_id
   WHERE p.id = p_pago_envio_id
$$;

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
                                      descripcion, monto, usuario_id, registrado_en)
    VALUES (NEW.corte_caja_id, 'ingreso', 'pago_paqueteria', NEW.id,
            core.descripcion_ingreso_envio(NEW.id),   -- 0088
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

DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);
  UPDATE core.movimiento_caja m
     SET descripcion = core.descripcion_ingreso_envio(m.origen_id)
   WHERE m.origen_tipo = 'pago_paqueteria' AND m.descripcion IS NULL;
  PERFORM set_config('donaji.replicando', 'off', true);
END $$;


-- 3. Historial: detalle del envío en los movimientos del corte
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.movimientos_corte_detalle(uuid, boolean);

CREATE FUNCTION core.movimientos_corte_detalle(
  p_corte_id          uuid,
  p_incluir_inactivos boolean DEFAULT false
)
RETURNS TABLE (
  id                        uuid,
  corte_caja_id             uuid,
  tipo                      text,
  origen_tipo               text,
  origen_id                 uuid,
  descripcion               text,
  monto                     numeric,
  usuario_id                uuid,
  usuario                   text,
  registrado_en             timestamptz,
  activo                    boolean,
  metodo_pago               text,
  referencia_transferencia  text,
  es_abono                  boolean,
  venta_id                  uuid,
  pasajeros                 jsonb,
  envio                     jsonb      -- 0088
)
LANGUAGE sql STABLE AS $$
  SELECT m.id, m.corte_caja_id, m.tipo, m.origen_tipo, m.origen_id, m.descripcion,
         m.monto, m.usuario_id, u.nombre, m.registrado_en, m.activo,
         COALESCE(p.metodo, pe.metodo),
         COALESCE(p.referencia_transferencia, pe.referencia_transferencia),
         p.es_abono, p.venta_id,
         bb.pasajeros,
         CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
           'folio', e.folio, 'descripcion', e.descripcion, 'destino', sd.nombre,
           'destinatario', e.destinatario_nombre, 'bultos', e.bultos, 'modalidad', e.modalidad)
         END
    FROM core.movimiento_caja m
    JOIN core.usuario u ON u.id = m.usuario_id
    LEFT JOIN core.pago p ON p.id = m.origen_id AND m.origen_tipo = 'pago_boleto'
    -- El pago de paquetería: el ingreso, o el reembolso (devolución) de un envío.
    LEFT JOIN core.pago_envio pe ON pe.id = m.origen_id
                                AND m.origen_tipo IN ('pago_paqueteria', 'devolucion')
    LEFT JOIN core.envio e ON e.id = pe.envio_id
    LEFT JOIN core.sucursal sd ON sd.id = e.sucursal_destino_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'folio', b.folio, 'pasajero', b.pasajero_nombre, 'importe', b.importe
             ) ORDER BY b.creado_en) AS pasajeros
        FROM core.boleto b
       WHERE b.venta_id = p.venta_id AND b.activo
    ) bb ON p.venta_id IS NOT NULL
   WHERE m.corte_caja_id = p_corte_id
     AND (p_incluir_inactivos OR m.activo)
   ORDER BY m.registrado_en, m.id
$$;

COMMENT ON FUNCTION core.movimientos_corte_detalle(uuid, boolean) IS
  'Movimientos de un corte con el detalle de pago (método, referencia, abono), los pasajeros/folios de la venta (boletos, 0077) y el envío (paquetería, 0088), para /historial/:id/movimientos.';
