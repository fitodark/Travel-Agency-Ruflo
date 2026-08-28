-- =============================================================================
-- 0034 · auth_local.credencial se replica como clase A (nube → nodo).
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.2
--                  docs/architecture/04-riesgos-roadmap.md §F2b (slice 1)
--
-- El blueprint es explícito: "El hash Argon2id se calcula EN LA NUBE al crear o
-- cambiar la contraseña y se replica a los nodos como cualquier dato de clase A.
-- El nodo nunca ve la contraseña en claro salvo en el instante del login."
--
-- Pero el cableado nunca se hizo. `auth_local.credencial` no tenía columnas de
-- sync, ni trigger de publicación, ni pasaba por `sync.es_tabla_ingerible` (que
-- solo admitía el esquema `core`). Consecuencia real: una terminal reinstalada
-- se queda SIN NINGUNA contraseña, y un cambio de contraseña hecho en la nube no
-- llega jamás. Este es el hueco de cableado de F2b, slice 1.
--
-- Mismo patrón que `core.rol_permiso` en 0012: la tabla no tiene columna `id`
-- (su PK es `usuario_id`), así que se le añade un `id uuid` DERIVADO. Aquí la
-- derivación es la identidad: la relación con `core.usuario` es 1:1 y
-- `usuario_id` ya es un uuid compartido entre la nube y los nodos, así que la
-- misma fila lógica converge al mismo `id` en los dos lados sin re-sembrar.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1 · Columna `id` (= usuario_id). La maquinaria de sync identifica filas por
--     `id`: `sync.ingest_fila` resuelve `ON CONFLICT (id)` y `sync.trg_cambio_log`
--     publica `NEW.id`.
-- -----------------------------------------------------------------------------
ALTER TABLE auth_local.credencial
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE auth_local.credencial SET id = usuario_id WHERE id IS NULL;

ALTER TABLE auth_local.credencial
  ALTER COLUMN id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'auth_local.credencial'::regclass
       AND conname  = 'credencial_id_key'
  ) THEN
    ALTER TABLE auth_local.credencial ADD CONSTRAINT credencial_id_key UNIQUE (id);
  END IF;
END $$;

-- Mantiene la derivación para filas nuevas. Una credencial creada en la nube
-- llega a los nodos con el mismo `id` que tendría si se sembrara ahí.
CREATE OR REPLACE FUNCTION auth_local.trg_credencial_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := NEW.usuario_id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_credencial_id
  BEFORE INSERT OR UPDATE ON auth_local.credencial
  FOR EACH ROW EXECUTE FUNCTION auth_local.trg_credencial_id();


-- -----------------------------------------------------------------------------
-- 2 · Columnas estándar (HLC, versión, auditoría, `activo`) + triggers estándar
--     y de outbox. Igual que cualquier tabla de `core` de clase A. El trigger de
--     outbox queda inerte por `sync.es_tabla_config` (0032): esta tabla solo
--     BAJA, nunca sube.
-- -----------------------------------------------------------------------------
SELECT core.registrar_entidad('auth_local.credencial'::regclass);


-- -----------------------------------------------------------------------------
-- 3 · La ingesta admitía SOLO el esquema `core`. Se amplía a `auth_local`.
--     El filtro estructural (las 4 columnas de sync) se mantiene intacto: de
--     `auth_local` solo `credencial` las tiene, así que en la práctica esto
--     habilita esa tabla y nada más — `sesion`, `intento` y `revocacion_hotp`
--     siguen fuera de la ingesta.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.es_tabla_ingerible(p_tabla text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT count(*) = 4
    FROM information_schema.columns c
   WHERE c.table_schema = split_part(p_tabla, '.', 1)
     AND c.table_name   = split_part(p_tabla, '.', 2)
     AND c.table_schema IN ('core', 'auth_local')
     AND c.column_name IN ('sync_sucursal_id', 'hlc_ts', 'hlc_cnt', 'version');
$$;

COMMENT ON FUNCTION sync.es_tabla_ingerible(text) IS
  'true si la tabla puede recibir filas replicadas: esquema core o auth_local, '
  'con las 4 columnas de sync. Lista derivada de la estructura, no escrita a mano.';


-- -----------------------------------------------------------------------------
-- 4 · Publicación hacia los nodos. A partir de aquí un INSERT/UPDATE de
--     credencial EN LA NUBE entra en `sync.cambio_log` y baja en el próximo pull.
--     `sync.es_tabla_config` la reconoce sola por la presencia del trigger.
-- -----------------------------------------------------------------------------
SELECT sync.publicar_a_nodos('auth_local.credencial'::regclass);
