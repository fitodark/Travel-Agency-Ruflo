-- =============================================================================
-- 0013 · Identidad uuid para core.parametro.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §2.1
--
-- CORRIGE UN DEFECTO INTRODUCIDO POR LA 0012.
-- Esa migración le puso a `core.parametro` el trigger de publicación hacia los
-- nodos, pero la tabla tiene clave primaria natural (`clave` text) y ninguna
-- columna `id`. Toda la maquinaria de sincronización asume `id uuid`:
--
--   sync.trg_cambio_log  publica NEW.id  -> cualquier INSERT/UPDATE falla
--   sync.ingest_fila     resuelve ON CONFLICT (id)
--   bootstrap            ordena por t.id
--
-- Es el mismo caso de `core.rol_permiso`, que la 0012 sí resolvió. Se aplica la
-- misma solución por la misma razón: el `id` se DERIVA de la clave natural en
-- vez de generarse al azar, porque la semilla ya corrió por separado en la base
-- local y en Supabase, y un identificador aleatorio le habría dado ids distintos
-- a la misma fila lógica en cada lado.
--
-- No se cambia la clave primaria: `clave` sigue siendo la identidad del dominio.
-- El `id` es identidad de replicación, que es otra cosa.
-- =============================================================================

ALTER TABLE core.parametro
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE core.parametro
   SET id = md5('core.parametro:' || clave)::uuid
 WHERE id IS NULL;

ALTER TABLE core.parametro
  ALTER COLUMN id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'core.parametro'::regclass
       AND conname  = 'parametro_id_key'
  ) THEN
    ALTER TABLE core.parametro ADD CONSTRAINT parametro_id_key UNIQUE (id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION core.trg_parametro_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := md5('core.parametro:' || NEW.clave)::uuid;
  END IF;
  RETURN NEW;
END $$;

-- BEFORE, y por tanto antes que `trg_cambio_log` (que es AFTER): cuando la
-- publicación lee NEW.id, el valor ya está puesto.
CREATE OR REPLACE TRIGGER trg_parametro_id
  BEFORE INSERT OR UPDATE ON core.parametro
  FOR EACH ROW EXECUTE FUNCTION core.trg_parametro_id();


-- -----------------------------------------------------------------------------
-- Guarda contra la repetición de este defecto.
-- -----------------------------------------------------------------------------
-- Dos veces en dos migraciones se publicó hacia los nodos una tabla que no podía
-- replicarse. La tercera vez debe fallar al aplicar la migración, no en
-- producción cuando un administrador guarde un parámetro.
CREATE OR REPLACE FUNCTION sync.publicar_a_nodos(p_tabla regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE format('%I.%I', c.table_schema, c.table_name)::regclass = p_tabla
       AND c.column_name = 'id'
       AND c.data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION
      'No se puede publicar % a los nodos: le falta una columna id uuid. '
      'La replicación identifica filas por id, no por clave natural. '
      'Agrega un id derivado de la clave natural (ver migración 0013).', p_tabla;
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE TRIGGER trg_cambio_log AFTER INSERT OR UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION sync.trg_cambio_log()', p_tabla);
END $$;

COMMENT ON FUNCTION sync.publicar_a_nodos(regclass) IS
  'Publica una tabla de clase A hacia los nodos. Exige columna id uuid. Blueprint §3.2.';
