-- =============================================================================
-- 0035 · auth_local.revocacion_hotp se replica como clase A (nube → nodo).
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5 (capa 3)
--                  docs/architecture/04-riesgos-roadmap.md §F2b (slice 2)
--
-- La capa 3 de revocación offline: el administrador genera un código HOTP para
-- (sucursal, usuario, contador), lo dicta por teléfono al gerente, y el nodo lo
-- valida OFFLINE contra la semilla de su sucursal. Para eso el nodo necesita esa
-- semilla — y la semilla se genera EN LA NUBE al dar de alta la sucursal (F2b
-- slice 2). Así que tiene que bajar replicada, igual que `auth_local.credencial`
-- (0034).
--
-- Nota de seguridad: como toda tabla clase A, la semilla baja a las CUATRO
-- terminales, no solo a la suya. El riesgo es acotado: un código de revocación
-- solo DESACTIVA usuarios (dirección fail-safe), nunca da acceso; y una terminal
-- comprometida ya expone hashes de contraseña, que es peor. El filtrado por
-- sucursal de la clase A sería maquinaria nueva y no la vale este caso.
--
-- Mismo patrón que 0034: `id uuid` = `sucursal_id` (relación 1:1), columnas
-- estándar de sync, y publicación hacia los nodos. `sync.es_tabla_ingerible` ya
-- admite `auth_local` desde 0034.
-- =============================================================================


ALTER TABLE auth_local.revocacion_hotp
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE auth_local.revocacion_hotp SET id = sucursal_id WHERE id IS NULL;

ALTER TABLE auth_local.revocacion_hotp
  ALTER COLUMN id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'auth_local.revocacion_hotp'::regclass
       AND conname  = 'revocacion_hotp_id_key'
  ) THEN
    ALTER TABLE auth_local.revocacion_hotp ADD CONSTRAINT revocacion_hotp_id_key UNIQUE (id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION auth_local.trg_revocacion_hotp_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := NEW.sucursal_id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_revocacion_hotp_id
  BEFORE INSERT OR UPDATE ON auth_local.revocacion_hotp
  FOR EACH ROW EXECUTE FUNCTION auth_local.trg_revocacion_hotp_id();


-- Columnas estándar (HLC, versión, auditoría, `activo`) + triggers. El de outbox
-- queda inerte por `sync.es_tabla_config` (0032): esta tabla solo BAJA.
SELECT core.registrar_entidad('auth_local.revocacion_hotp'::regclass);

SELECT sync.publicar_a_nodos('auth_local.revocacion_hotp'::regclass);
