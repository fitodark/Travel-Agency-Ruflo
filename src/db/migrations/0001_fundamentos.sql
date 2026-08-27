-- =============================================================================
-- 0001 · Fundamentos: esquemas, extensiones, identidad, reloj híbrido,
--        columnas estándar de auditoría/sync y outbox genérico.
--
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §2 y §3
--
-- Esta migración se aplica IDÉNTICA en el nodo local y en Supabase. Esa es la
-- razón de usar PostgreSQL local y no SQLite: un solo dialecto, una sola
-- migración, y las mismas garantías (EXCLUDE, rangos, columnas generadas).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_bytes, para uuidv7
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- REQUERIDO por la invariante de asiento
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS sync;
CREATE SCHEMA IF NOT EXISTS auth_local;
CREATE SCHEMA IF NOT EXISTS api;   -- solo se puebla en la nube (contrato externo)

COMMENT ON SCHEMA core       IS 'Entidades del dominio. Replicado local <-> nube.';
COMMENT ON SCHEMA sync       IS 'Outbox, cursores, lotes, excepciones, checksums.';
COMMENT ON SCHEMA auth_local IS 'Credenciales y sesiones locales. Auth offline.';
COMMENT ON SCHEMA api        IS 'Vistas versionadas de solo lectura para el sistema externo.';


-- -----------------------------------------------------------------------------
-- Identidad: UUID v7 generado localmente.
-- Ordenable por tiempo (locality en índices) y sin coordinación (funciona
-- offline). PostgreSQL 16 no lo trae nativo; se implementa aquí.
-- PROHIBIDO usar serial/identity como PK de dominio: obliga a coordinar con la
-- nube y rompe el driver D1 (operación sin internet).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_ms    bigint;
  v_bytes bytea;
BEGIN
  v_ms    := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  v_bytes := gen_random_bytes(16);
  -- 48 bits de timestamp en milisegundos
  v_bytes := overlay(v_bytes PLACING substring(int8send(v_ms) FROM 3 FOR 6) FROM 1 FOR 6);
  v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15)  | 112);  -- versión 7
  v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63)  | 128);  -- variante RFC
  RETURN encode(v_bytes, 'hex')::uuid;
END $$;


-- -----------------------------------------------------------------------------
-- Reloj híbrido (HLC). Da un orden total determinista
-- (hlc_ts, hlc_cnt, origen) que todas las réplicas calculan igual, sin depender
-- de que los relojes de pared coincidan.
-- Se usa para ORDEN, nunca para permisos ni expiraciones.
-- -----------------------------------------------------------------------------
CREATE TABLE sync.hlc_estado (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ultimo_ts timestamptz NOT NULL DEFAULT '-infinity',
  ultimo_cnt integer NOT NULL DEFAULT 0
);
INSERT INTO sync.hlc_estado DEFAULT VALUES ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION sync.hlc_siguiente(OUT o_ts timestamptz, OUT o_cnt integer)
LANGUAGE plpgsql AS $$
DECLARE v_ahora timestamptz := clock_timestamp();
BEGIN
  UPDATE sync.hlc_estado
     SET ultimo_ts  = GREATEST(ultimo_ts, v_ahora),
         ultimo_cnt = CASE WHEN GREATEST(ultimo_ts, v_ahora) = ultimo_ts
                           THEN ultimo_cnt + 1 ELSE 0 END
   WHERE singleton
   RETURNING ultimo_ts, ultimo_cnt INTO o_ts, o_cnt;
END $$;

-- Al recibir un lote remoto se avanza el reloj local al máximo observado.
CREATE OR REPLACE FUNCTION sync.hlc_observar(p_ts timestamptz, p_cnt integer)
RETURNS void LANGUAGE sql AS $$
  UPDATE sync.hlc_estado
     SET ultimo_ts  = GREATEST(ultimo_ts, p_ts),
         ultimo_cnt = CASE WHEN p_ts > ultimo_ts THEN p_cnt
                           WHEN p_ts = ultimo_ts THEN GREATEST(ultimo_cnt, p_cnt)
                           ELSE ultimo_cnt END
   WHERE singleton;
$$;


-- -----------------------------------------------------------------------------
-- Identidad del nodo. Cada instalación sabe qué sucursal es y qué versión corre.
-- La versión es crítica bajo el delta D-8: nodos N y N-1 conviven por días.
-- -----------------------------------------------------------------------------
CREATE TABLE sync.nodo (
  singleton      boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sucursal_id    uuid,
  es_nube        boolean NOT NULL DEFAULT false,
  version_esquema text,
  version_binario text,
  instalado_en   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sync.nodo DEFAULT VALUES ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION sync.sucursal_local() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT sucursal_id FROM sync.nodo WHERE singleton $$;


-- -----------------------------------------------------------------------------
-- Columnas estándar de auditoría y sync.
-- El borrado lógico universal (columna `activo`) cumple simultáneamente el
-- requisito de auditoría del cliente Y elimina la necesidad de una tabla de
-- tombstones: un borrado es un UPDATE que se replica como cualquier otro.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.trg_columnas_estandar() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_ts timestamptz; v_cnt integer;
BEGIN
  SELECT o_ts, o_cnt INTO v_ts, v_cnt FROM sync.hlc_siguiente();

  IF TG_OP = 'INSERT' THEN
    NEW.creado_en     := COALESCE(NEW.creado_en, now());
    NEW.modificado_en := NEW.creado_en;
    NEW.version       := 1;
    NEW.sync_sucursal_id := COALESCE(NEW.sync_sucursal_id, sync.sucursal_local());
  ELSE
    NEW.modificado_en := now();
    NEW.version       := OLD.version + 1;
    NEW.creado_en     := OLD.creado_en;
    NEW.sync_sucursal_id := OLD.sync_sucursal_id;
    -- Baja lógica: se sella el momento y el motivo (auditoría del administrador)
    IF OLD.activo AND NOT NEW.activo THEN
      NEW.desactivado_en := COALESCE(NEW.desactivado_en, now());
    END IF;
  END IF;

  NEW.hlc_ts  := v_ts;
  NEW.hlc_cnt := v_cnt;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION core.aplicar_estandar(p_tabla regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($f$
    ALTER TABLE %1$s
      ADD COLUMN IF NOT EXISTS activo             boolean     NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS creado_en          timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS creado_por         uuid,
      ADD COLUMN IF NOT EXISTS modificado_en      timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS modificado_por     uuid,
      ADD COLUMN IF NOT EXISTS desactivado_en     timestamptz,
      ADD COLUMN IF NOT EXISTS desactivado_por    uuid,
      ADD COLUMN IF NOT EXISTS desactivado_motivo text,
      ADD COLUMN IF NOT EXISTS sync_sucursal_id   uuid,
      ADD COLUMN IF NOT EXISTS hlc_ts             timestamptz NOT NULL DEFAULT '-infinity',
      ADD COLUMN IF NOT EXISTS hlc_cnt            integer     NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS version            integer     NOT NULL DEFAULT 1
  $f$, p_tabla);

  EXECUTE format(
    'CREATE OR REPLACE TRIGGER trg_estandar BEFORE INSERT OR UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION core.trg_columnas_estandar()', p_tabla);
END $$;


-- -----------------------------------------------------------------------------
-- Outbox: append-only, en orden de `seq` (bigserial LOCAL — aquí sí es correcto,
-- nunca sale del nodo). El orden preserva la causalidad intra-sucursal: el corte
-- de caja se envía antes que sus movimientos.
-- -----------------------------------------------------------------------------
CREATE TABLE sync.outbox (
  seq          bigserial PRIMARY KEY,
  tabla        text        NOT NULL,
  fila_id      uuid        NOT NULL,
  payload      jsonb       NOT NULL,
  hlc_ts       timestamptz NOT NULL,
  hlc_cnt      integer     NOT NULL,
  lote_id      uuid,
  estado       text        NOT NULL DEFAULT 'pendiente'
               CHECK (estado IN ('pendiente','enviado','confirmado','rechazado')),
  intentos     integer     NOT NULL DEFAULT 0,
  ultimo_error text,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pendiente_idx ON sync.outbox (estado, seq)
  WHERE estado <> 'confirmado';

CREATE OR REPLACE FUNCTION sync.trg_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- La nube no genera outbox: es el destino, no un origen.
  IF (SELECT es_nube FROM sync.nodo WHERE singleton) THEN RETURN NEW; END IF;
  INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, NEW.id, to_jsonb(NEW),
          NEW.hlc_ts, NEW.hlc_cnt);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION core.aplicar_outbox(p_tabla regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER trg_outbox AFTER INSERT OR UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION sync.trg_outbox()', p_tabla);
END $$;

-- Atajo: columnas estándar + outbox en un paso.
CREATE OR REPLACE FUNCTION core.registrar_entidad(p_tabla regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM core.aplicar_estandar(p_tabla);
  PERFORM core.aplicar_outbox(p_tabla);
END $$;
