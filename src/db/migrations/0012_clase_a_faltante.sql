-- =============================================================================
-- 0012 · Completa la clase A: `parametro` y `rol_permiso` no bajaban a los nodos.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §1 (tabla de clases)
--
-- DEFECTO QUE CORRIGE:
-- El blueprint declara clase A a "sucursal, usuario, rol, permiso, conductor,
-- unidad, tipo_unidad, ruta, horario, tarifa, config_impresora, config_ticket,
-- parametro". Pero `sync.publicar_a_nodos` (migración 0008) omitió DOS de ellas:
--
--   core.parametro    — tenía columnas de sync pero no el trigger de publicación.
--   core.rol_permiso  — no tenía ni columnas ni trigger.
--
-- Consecuencia real: un nodo nuevo nunca recibiría la matriz de permisos ni los
-- parámetros del sistema. El blueprint (03 §1.4) es explícito en que el RBAC debe
-- funcionar "con la matriz de permisos como dato replicado, no como `if` en el
-- código" — precisamente para poder ajustar permisos sin desplegar. Sin esta
-- corrección, esa promesa no se cumple y la autorización offline queda sin base.
--
-- Es el mismo hueco que apareció con `core.tipo_unidad` en la PoC de F0: el
-- catálogo existía en la nube pero nunca entraba al log de cambios.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. core.parametro — solo le faltaba el trigger de publicación.
-- -----------------------------------------------------------------------------
SELECT sync.publicar_a_nodos('core.parametro'::regclass);


-- -----------------------------------------------------------------------------
-- 2. core.rol_permiso — necesita identidad antes de poder replicarse.
-- -----------------------------------------------------------------------------
--
-- La tabla tiene clave primaria compuesta (rol, permiso) y ninguna columna `id`,
-- pero toda la maquinaria de sync la exige: `sync.ingest_fila` resuelve con
-- `ON CONFLICT (id)` y `sync.trg_cambio_log` publica `NEW.id`.
--
-- El `id` se deriva DETERMINÍSTICAMENTE del par natural en vez de generarse al
-- azar. La razón es concreta: la semilla 0002 ya corrió por separado en la base
-- local y en Supabase, así que un `id` aleatorio le habría dado identificadores
-- distintos a la misma fila lógica en cada lado. Al replicar, la nube habría
-- intentado insertar `('vendedor','venta.crear')` con un `id` nuevo sobre una
-- fila que ya existe con otro, y habría chocado contra la clave compuesta en
-- todas las terminales a la vez.
--
-- Con `md5(rol || ':' || permiso)::uuid`, las 42 filas sembradas de forma
-- independiente convergen al mismo identificador sin necesidad de re-sembrar.
ALTER TABLE core.rol_permiso
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE core.rol_permiso
   SET id = md5('core.rol_permiso:' || rol || ':' || permiso)::uuid
 WHERE id IS NULL;

ALTER TABLE core.rol_permiso
  ALTER COLUMN id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'core.rol_permiso'::regclass
       AND conname  = 'rol_permiso_id_key'
  ) THEN
    ALTER TABLE core.rol_permiso ADD CONSTRAINT rol_permiso_id_key UNIQUE (id);
  END IF;
END $$;

-- Mantiene la derivación para filas nuevas. Un permiso dado de alta en la nube
-- llega a los nodos con el mismo `id` que tendría si se hubiera sembrado ahí.
CREATE OR REPLACE FUNCTION core.trg_rol_permiso_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := md5('core.rol_permiso:' || NEW.rol || ':' || NEW.permiso)::uuid;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_rol_permiso_id
  BEFORE INSERT OR UPDATE ON core.rol_permiso
  FOR EACH ROW EXECUTE FUNCTION core.trg_rol_permiso_id();

-- Columnas estándar (incluye HLC y auditoría) y publicación hacia los nodos.
SELECT core.aplicar_estandar('core.rol_permiso'::regclass);
SELECT sync.publicar_a_nodos('core.rol_permiso'::regclass);


-- -----------------------------------------------------------------------------
-- 3. core.folio_secuencia NO se replica, y es correcto.
-- -----------------------------------------------------------------------------
-- Es el contador local de folios de cada sucursal. Replicarlo sería un error
-- grave: dos nodos con el mismo contador emitirían el mismo folio de 6
-- caracteres, que es exactamente lo que el particionamiento por prefijo de
-- sucursal existe para impedir. Se deja fuera de la sincronización a propósito y
-- se documenta aquí para que nadie lo "corrija" más adelante.
COMMENT ON TABLE core.folio_secuencia IS
  'Contador local de folios por sucursal. NO se replica: cada nodo lleva el suyo '
  'y el prefijo de sucursal garantiza que no colisionen. Ver blueprint §02.';
