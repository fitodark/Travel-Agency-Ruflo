-- =============================================================================
-- 0083 · Réplica de bajada de datos transaccionales (nube → terminales).
--        docs/architecture/06-lugar-paso-paqueteria.md §2 (Fase B2)
--        docs/architecture/01-sincronizacion.md §3.2
--
-- QUÉ RESUELVE. Hasta hoy la nube solo bajaba CONFIGURACIÓN (clase A,
-- `trg_cambio_log`). Lo transaccional (venta, boleto, pago) subía de cada
-- terminal a la nube y ahí se quedaba: ninguna otra terminal lo veía. En una
-- base compartida no se nota; con una base por terminal rompe:
--   * el manifiesto de Acatlán no trae a quien Huajuapan le vendió por
--     teléfono subiendo en Acatlán (L8), ni al revés;
--   * el origen no encuentra por folio una reserva hecha en otra sucursal para
--     cobrarla (C5);
--   * (paquetería, Fase E) el destino no vería el envío que registró el origen.
-- Era la decisión abierta "replicación hacia las sucursales" del historial;
-- el PO eligió réplica de bajada (2026-11-03) para que todo funcione SIN
-- internet en el momento de usarlo.
--
-- CÓMO
--   1. `sync.cambio_log.destinatarios uuid[]`: NULL = todos los nodos (la
--      configuración, como siempre); con valor = solo esas sucursales.
--   2. `sync.trg_bajada` (solo actúa en la nube): publica cada INSERT/UPDATE
--      de las tablas transaccionales — TAMBIÉN las que llegan replicadas de una
--      terminal, que es justo el caso — dirigido a `sync.destinatarios_bajada`:
--        venta / boleto / pago  → terminales con sucursal de su salida;
--        cliente / corte_caja   → todas las sucursales con sistema (son padres
--                                 por FK de venta y pago; pocas filas);
--      menos la sucursal que la escribió (`sync_sucursal_id`): no se la
--      devuelve a su dueña. Nombre distinto de `trg_cambio_log` a propósito:
--      `sync.es_tabla_config` sigue viéndolas como NO-config y siguen subiendo.
--   3. `sync.trg_outbox` recupera la guarda `sync.replicando()` que puso 0014 y
--      0032 perdió al reescribirlo: sin ella, lo que baja volvería a subir.
--   4. Relleno inicial (solo en la nube): publica lo ya existente de las
--      salidas de ayer en adelante.
--   El pull (`src/sync/pull.ts`) filtra por `destinatarios` con la sucursal
--   del nodo, y tolera una nube sin esta columna.
--
-- FUERA DE ALCANCE (a propósito)
--   * `core.asiento_ocupacion` (clase D) NO baja: la disponibilidad entre
--     terminales la siguen cuidando cupos + leases + arbitraje (01b). Bajarla
--     metería el EXCLUDE en el pull y su arbitraje; no hace falta para
--     manifiestos ni cobros.
--   * `movimiento_caja` y `print_job`: son de la caja/impresora de cada nodo.
--
-- EFECTOS EN EL NODO QUE RECIBE. `sync.ingest_fila` aplica con
-- `donaji.replicando = on`: no reescribe HLC/dueño (0014), no encola outbox
-- (este parche) y `trg_pago_a_ingreso` no crea movimientos de caja (guarda
-- propia). El nodo tendrá cortes/ventas de otras sucursales en solo lectura:
-- toda pantalla operativa ya filtra por la sucursal de la sesión.
--
-- DEPLOY. Aplicar PRIMERO a la nube y después a las terminales. Un nodo con
-- código nuevo contra una nube vieja sigue funcionando (el pull detecta la
-- columna). Requiere 0082.
-- =============================================================================


-- 1. Destinatarios en el log de bajada
-- ---------------------------------------------------------------------------
ALTER TABLE sync.cambio_log ADD COLUMN IF NOT EXISTS destinatarios uuid[];

COMMENT ON COLUMN sync.cambio_log.destinatarios IS
  'NULL = baja a todos los nodos (configuración). Con valor = solo a esas sucursales (réplica transaccional, 0083).';


-- 2. ¿A quién le baja cada fila?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.sucursales_de_salida(p_salida_id uuid)
RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT pr.sucursal_id), '{}')
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id
     AND pr.sucursal_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION sync.sucursales_con_sistema()
RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(id), '{}') FROM core.sucursal WHERE activo AND NOT sin_sistema
$$;

-- Punto de extensión: la paquetería (0084+) agrega aquí sus tablas.
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
    ELSE '{}'::uuid[]
  END;
  -- A la dueña no se le devuelve su propia fila.
  RETURN array_remove(COALESCE(v_dest, '{}'), (p_fila->>'sync_sucursal_id')::uuid);
END $$;

COMMENT ON FUNCTION sync.destinatarios_bajada(text, jsonb) IS
  'Sucursales a las que baja una fila transaccional (0083): las terminales de su salida (venta/boleto/pago) o todas con sistema (cliente/corte_caja), menos la que la escribió.';


-- 3. Trigger de publicación transaccional (solo en la nube)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.trg_bajada() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_fila jsonb;
  v_dest uuid[];
BEGIN
  IF NOT (sync.forzar_nube() OR (SELECT es_nube FROM sync.nodo WHERE singleton)) THEN
    RETURN NEW;
  END IF;

  -- A diferencia de `trg_cambio_log`, aquí NO se salta lo replicado: una venta
  -- que llega de Huajuapan es exactamente lo que Acatlán necesita recibir.
  v_fila := to_jsonb(NEW);
  v_dest := sync.destinatarios_bajada(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_fila);
  IF cardinality(v_dest) = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO sync.cambio_log (tabla, fila_id, payload, destinatarios)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, NEW.id, v_fila, v_dest);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sync.bajar_a_terminales(p_tabla regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER trg_bajada AFTER INSERT OR UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION sync.trg_bajada()', p_tabla);
END $$;

COMMENT ON FUNCTION sync.bajar_a_terminales(regclass) IS
  'Pone trg_bajada: la nube publica la tabla transaccional hacia las terminales que la necesitan (0083).';

SELECT sync.bajar_a_terminales(t) FROM unnest(ARRAY[
  'core.cliente', 'core.corte_caja', 'core.venta', 'core.boleto', 'core.pago'
]::regclass[]) AS t;


-- 4. Outbox: lo que baja no vuelve a subir (guarda de 0014 que 0032 perdió)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.trg_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- La nube no genera outbox: es el destino, no un origen.
  IF (SELECT es_nube FROM sync.nodo WHERE singleton) THEN RETURN NEW; END IF;

  -- Lo que acaba de BAJAR no vuelve a SUBIR (0014). Con la réplica de bajada
  -- (0083) esto ya no es solo la configuración: son ventas de otras terminales.
  IF sync.replicando() THEN RETURN NEW; END IF;

  -- La configuración es autoritativa en la nube y solo BAJA (0032).
  IF sync.es_tabla_config(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME) THEN
    RETURN NEW;
  END IF;

  INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, NEW.id, to_jsonb(NEW),
          NEW.hlc_ts, NEW.hlc_cnt);
  RETURN NEW;
END $$;


-- 5. Relleno inicial (solo en la nube): lo vigente de ayer en adelante.
--    En orden de dependencia: cliente y corte antes que venta y pago.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT es_nube FROM sync.nodo WHERE singleton) THEN
    RETURN;
  END IF;

  INSERT INTO sync.cambio_log (tabla, fila_id, payload, destinatarios)
  SELECT 'core.cliente', c.id, to_jsonb(c), d.dest
    FROM core.cliente c
    CROSS JOIN LATERAL (SELECT sync.destinatarios_bajada('core.cliente', to_jsonb(c)) AS dest) d
   WHERE c.id IN (SELECT v.cliente_id FROM core.venta v JOIN core.salida s ON s.id = v.salida_id
                   WHERE s.fecha_operacion >= current_date - 1)
     AND cardinality(d.dest) > 0;

  INSERT INTO sync.cambio_log (tabla, fila_id, payload, destinatarios)
  SELECT 'core.corte_caja', cc.id, to_jsonb(cc), d.dest
    FROM core.corte_caja cc
    CROSS JOIN LATERAL (SELECT sync.destinatarios_bajada('core.corte_caja', to_jsonb(cc)) AS dest) d
   WHERE cc.id IN (SELECT p.corte_caja_id FROM core.pago p
                     JOIN core.venta v ON v.id = p.venta_id
                     JOIN core.salida s ON s.id = v.salida_id
                    WHERE s.fecha_operacion >= current_date - 1)
     AND cardinality(d.dest) > 0;

  INSERT INTO sync.cambio_log (tabla, fila_id, payload, destinatarios)
  SELECT 'core.venta', v.id, to_jsonb(v), d.dest
    FROM core.venta v JOIN core.salida s ON s.id = v.salida_id
    CROSS JOIN LATERAL (SELECT sync.destinatarios_bajada('core.venta', to_jsonb(v)) AS dest) d
   WHERE s.fecha_operacion >= current_date - 1 AND cardinality(d.dest) > 0
   ORDER BY v.creado_en;

  INSERT INTO sync.cambio_log (tabla, fila_id, payload, destinatarios)
  SELECT 'core.boleto', b.id, to_jsonb(b), d.dest
    FROM core.boleto b JOIN core.salida s ON s.id = b.salida_id
    CROSS JOIN LATERAL (SELECT sync.destinatarios_bajada('core.boleto', to_jsonb(b)) AS dest) d
   WHERE s.fecha_operacion >= current_date - 1 AND cardinality(d.dest) > 0
   ORDER BY b.creado_en;

  INSERT INTO sync.cambio_log (tabla, fila_id, payload, destinatarios)
  SELECT 'core.pago', p.id, to_jsonb(p), d.dest
    FROM core.pago p
    JOIN core.venta v ON v.id = p.venta_id
    JOIN core.salida s ON s.id = v.salida_id
    CROSS JOIN LATERAL (SELECT sync.destinatarios_bajada('core.pago', to_jsonb(p)) AS dest) d
   WHERE s.fecha_operacion >= current_date - 1 AND cardinality(d.dest) > 0
   ORDER BY p.creado_en;
END $$;
