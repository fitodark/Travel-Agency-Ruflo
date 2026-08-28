-- =============================================================================
-- 0037 · Rol de Postgres para la consola de administración (F2b, deuda de slice 1).
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.4 (RLS / P6)
--
-- Hasta ahora la consola (`src/admin/`) se conectaba con el rol de `DATABASE_URL`
-- —el dueño del esquema—, igual que el tablero. P6 es explícito: la cuenta de
-- Supabase concentra los datos de las 4 sucursales, así que una credencial
-- filtrada no debería poder tocar más de lo necesario.
--
-- `donaji_consola` puede LEER `core` y `sync` (lo mismo que el administrador ve
-- en el tablero) pero solo ESCRIBIR las tablas de configuración clase A y la
-- fontanería de sync que disparan sus triggers. No puede escribir `core.venta`,
-- `core.boleto`, `core.pago` ni ningún dato transaccional.
--
-- Se crea NOLOGIN. El despliegue le da acceso:
--   ALTER ROLE donaji_consola WITH LOGIN PASSWORD '...';
-- y la consola se conecta con `ADMIN_DATABASE_URL` apuntando a ese rol.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donaji_consola') THEN
    CREATE ROLE donaji_consola NOLOGIN;
  END IF;
END $$;

-- Que quien corre la migración (y las pruebas) pueda `SET ROLE donaji_consola`.
GRANT donaji_consola TO CURRENT_USER;

GRANT USAGE ON SCHEMA core, sync, auth_local TO donaji_consola;

-- LECTURA amplia de core: es lo que el administrador ya ve. Incluye las de futuro.
GRANT SELECT ON ALL TABLES IN SCHEMA core TO donaji_consola;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT ON TABLES TO donaji_consola;

-- ESCRITURA: solo configuración clase A.
GRANT INSERT, UPDATE ON
  core.agencia, core.sucursal, core.usuario, core.usuario_sucursal,
  core.rol_permiso, core.config_impresora, core.config_ticket, core.tarifa,
  core.parametro
  TO donaji_consola;

GRANT SELECT, INSERT, UPDATE ON auth_local.credencial, auth_local.revocacion_hotp
  TO donaji_consola;

-- Fontanería que disparan los triggers de una escritura de configuración:
--   trg_columnas_estandar -> sync.hlc_siguiente() -> UPDATE sync.hlc_estado
--   trg_cambio_log        -> INSERT sync.cambio_log,  SELECT sync.nodo
--   trg_secuencia_folio   -> INSERT/UPDATE core.folio_secuencia (al alta de sucursal)
GRANT SELECT, UPDATE ON sync.hlc_estado TO donaji_consola;
GRANT SELECT ON sync.nodo TO donaji_consola;
GRANT SELECT, INSERT ON sync.cambio_log TO donaji_consola;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA sync TO donaji_consola;
GRANT SELECT, INSERT, UPDATE ON core.folio_secuencia TO donaji_consola;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core TO donaji_consola;

GRANT EXECUTE ON FUNCTION
  core.uuid_v7(),
  sync.hlc_siguiente(),
  sync.sucursal_local()
  TO donaji_consola;

COMMENT ON ROLE donaji_consola IS
  'Consola de administración (F2b): lee core/sync, escribe solo configuración clase A. NOLOGIN — el despliegue le pone contraseña.';
