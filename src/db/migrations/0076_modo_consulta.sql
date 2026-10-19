-- =============================================================================
-- 0076 · Modo consulta: administrador/gerente pueden entrar sin sucursal activa.
--
-- QA (Ses. 77): un administrador o gerente puede estar presente en una
-- sucursal y necesitar revisar reportes, el corte de OTRA sucursal, o dar de
-- alta un dato en Administración, sin que eso implique "operar" esa sucursal
-- (vender, abrir/cerrar corte). Hoy `auth_local.sesion.sucursal_id = NULL`
-- solo significa "sesión incompleta, el login la rechaza en cualquier
-- pantalla" (migr. 0016). Se necesita un segundo significado: "sin sucursal,
-- a propósito, en modo consulta" — solo para esos dos roles.
--
-- `modo_consulta` es una bandera de SESIÓN (`auth_local.sesion`), no de
-- usuario: no se replica (la tabla es local, igual que el resto de la
-- sesión) y se apaga sola en cuanto la sesión elige una sucursal real
-- (`core.seleccionar_sucursal` en TS, no SQL — ver `src/auth/sesion.ts`).
--
-- Reportes (Tablero): `dashboard.ver`/`auditoria.ver` eran exclusivos de
-- `administrador`. Se amplía SOLO `dashboard.ver` a `gerente` (ventas,
-- ingresos de caja, ventas-vs-caja, cortes) — `auditoria.ver` (gastos, salud
-- del nodo, excepciones, registros inactivos) se queda exclusiva de
-- administrador por ser información más sensible y no pedida en esta regla.
-- Administración (`/admin/*`, incl. alta de usuarios) tampoco se toca: sigue
-- exclusiva de `administrador` (gate de ROL en código, no de permiso).
-- =============================================================================

ALTER TABLE auth_local.sesion
  ADD COLUMN IF NOT EXISTS modo_consulta boolean NOT NULL DEFAULT false;

-- Coherente con 0016: una sesión en modo consulta tampoco tiene sucursal.
ALTER TABLE auth_local.sesion
  ADD CONSTRAINT sesion_consulta_sin_sucursal
  CHECK (NOT modo_consulta OR sucursal_id IS NULL);

DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);
  INSERT INTO core.rol_permiso (rol, permiso) VALUES
    ('gerente', 'dashboard.ver')
  ON CONFLICT DO NOTHING;
  PERFORM set_config('donaji.replicando', 'off', true);
END $$;
