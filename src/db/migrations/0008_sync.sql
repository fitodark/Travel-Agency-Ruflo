-- =============================================================================
-- 0008 · Infraestructura de sincronización: cursores, idempotencia de lotes,
--        log de cambios de la nube, excepciones y checksums.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3, §6, §7
-- =============================================================================

-- Cursor de pull por tabla. Se avanza por `seq` de sync.cambio_log, NUNCA por
-- modificado_en: filas escritas dentro de una transacción larga pueden hacerse
-- visibles fuera de orden de timestamp, y un cursor por tiempo las perdería en
-- silencio. La pérdida silenciosa es el peor modo de falla de un sistema de sync.
CREATE TABLE sync.cursor (
  tabla       text PRIMARY KEY,
  ultimo_seq  bigint NOT NULL DEFAULT 0,
  ultimo_pull timestamptz
);


-- Idempotencia del push: si un lote ya se procesó, se devuelve el mismo ACK sin
-- reprocesar. Junto con el reenvío del outbox, esto da
-- "at-least-once + idempotente = efectivamente-una-vez".
CREATE TABLE sync.lote_recibido (
  lote_id        uuid PRIMARY KEY,
  sucursal_id    uuid NOT NULL,
  version_nodo   text,          -- D-8: qué versión mandó el lote
  filas          integer NOT NULL,
  ack            jsonb   NOT NULL,
  recibido_en    timestamptz NOT NULL DEFAULT now()
);


-- Log de cambios de la NUBE, consumido por el pull de los nodos.
CREATE TABLE sync.cambio_log (
  seq        bigserial PRIMARY KEY,
  tabla      text  NOT NULL,
  fila_id    uuid  NOT NULL,
  payload    jsonb NOT NULL,
  escrito_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cambio_log_tabla_idx ON sync.cambio_log (tabla, seq);

CREATE OR REPLACE FUNCTION sync.trg_cambio_log() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Solo la nube alimenta el log de bajada.
  IF NOT (SELECT es_nube FROM sync.nodo WHERE singleton) THEN RETURN NEW; END IF;
  INSERT INTO sync.cambio_log (tabla, fila_id, payload)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, NEW.id, to_jsonb(NEW));
  RETURN NEW;
END $$;

-- Se aplica solo a las tablas de clase A (configuración), que bajan de la nube.
CREATE OR REPLACE FUNCTION sync.publicar_a_nodos(p_tabla regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER trg_cambio_log AFTER INSERT OR UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION sync.trg_cambio_log()', p_tabla);
END $$;

SELECT sync.publicar_a_nodos(t) FROM unnest(ARRAY[
  'core.agencia', 'core.sucursal', 'core.usuario', 'core.usuario_sucursal',
  'core.tipo_unidad', 'core.unidad', 'core.conductor',
  'core.ruta', 'core.ruta_parada', 'core.horario', 'core.horario_parada',
  'core.tarifa', 'core.salida', 'core.salida_parada', 'core.cupo_offline',
  'core.config_impresora', 'core.config_ticket'
]::regclass[]) AS t;


-- =============================================================================
-- Cola de excepciones. Se replica a la nube y se muestra en DOS lugares: un
-- badge no ocultable en la caja de la sucursal afectada y el tablero del
-- administrador. Con sucursales a 3-6 h de distancia, una excepción que solo
-- viva en un log es una excepción que nadie va a ver.
-- =============================================================================
CREATE TABLE sync.excepcion (
  id           uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  tipo         text NOT NULL CHECK (tipo IN (
                 'sobreventa','rechazo_ingesta','fk_faltante','deriva_reloj',
                 'folio_duplicado','impresion_fallida','divergencia_checksum',
                 'mapa_incompatible','respaldo_vencido','version_desactualizada')),
  severidad    text NOT NULL CHECK (severidad IN ('critica','alta','media','baja')),
  sucursal_id  uuid NOT NULL,
  entidad      text,
  entidad_id   uuid,
  detalle      jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado       text NOT NULL DEFAULT 'abierta'
               CHECK (estado IN ('abierta','en_proceso','resuelta','descartada')),
  resuelto_por uuid,
  resuelto_en  timestamptz,
  resolucion   text,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX excepcion_abierta_idx ON sync.excepcion (severidad, creado_en)
  WHERE estado = 'abierta';


-- =============================================================================
-- Reconciliación por checksum. Detecta PÉRDIDA SILENCIOSA de datos, que es el
-- modo de falla que nadie nota hasta el cierre de mes — y para entonces la
-- evidencia física (los tickets) ya no existe.
-- =============================================================================
CREATE TABLE sync.checksum_bloque (
  id           uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  sucursal_id  uuid NOT NULL,
  tabla        text NOT NULL,
  dia          date NOT NULL,
  filas        integer NOT NULL,
  hash_local   text,
  hash_nube    text,
  coincide     boolean GENERATED ALWAYS AS
               (hash_local IS NOT NULL AND hash_local = hash_nube) STORED,
  calculado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sucursal_id, tabla, dia)
);

CREATE OR REPLACE FUNCTION sync.calcular_checksum(
  p_tabla regclass, p_sucursal_id uuid, p_dia date)
RETURNS TABLE (filas integer, hash text)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE format($f$
    SELECT count(*)::integer,
           md5(coalesce(string_agg(id::text || ':' || version::text, '|'
                                   ORDER BY id), ''))
      FROM %1$s
     WHERE sync_sucursal_id = %2$L
       AND creado_en >= %3$L::date
       AND creado_en <  %3$L::date + 1
  $f$, p_tabla, p_sucursal_id, p_dia);
END $$;


-- Salud del nodo: la herramienta de diagnóstico remoto. Incluye la versión de
-- esquema y binario porque bajo D-8 conviven nodos N y N-1 durante días, y hay
-- que saber cuál terminal se quedó atrás; y la antigüedad del respaldo porque
-- con una sola PC por sucursal (D-1) el respaldo es la única defensa real.
CREATE TABLE sync.salud (
  sucursal_id           uuid PRIMARY KEY,
  ultima_sync_exitosa   timestamptz,
  outbox_pendiente      integer NOT NULL DEFAULT 0,
  deriva_reloj_seg      integer,
  version_esquema       text,
  version_binario       text,
  ultimo_respaldo_en    timestamptz,
  excepciones_criticas  integer NOT NULL DEFAULT 0,
  reportado_en          timestamptz NOT NULL DEFAULT now()
);
