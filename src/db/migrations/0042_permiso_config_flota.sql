-- =============================================================================
-- 0042 · Permiso `config.flota` + acceso del rol de consola a la flota.
-- Blueprint v0.2 · docs/architecture/02-modelo-datos.md §3-4 (flota, D-7)
--                  docs/architecture/03-auth-impresion-config.md §1.4 (RLS / P6)
--
-- El CRUD de `core.unidad` y `core.conductor` (catálogos de flota, clase A) se
-- suma a la sección Administración de la SPA. Necesita:
--   1. Un permiso propio para gatearlo en el nav y en `exige()`.
--   2. Que `donaji_consola` (0037) pueda ESCRIBIR esas dos tablas — hasta ahora
--      solo tenía SELECT amplio de `core` y write de la lista de config de F2b.
--
-- `core.tipo_unidad` NO se suma a la escritura: el mapa de asientos declarativo
-- se sigue sembrando por SQL (`src/db/seed/0001`), no se edita desde la SPA.
-- =============================================================================

INSERT INTO core.rol_permiso (rol, permiso) VALUES
  ('administrador', 'config.flota')
ON CONFLICT DO NOTHING;

-- El rol acotado de la consola (0037) ya lee todo `core`; le falta escribir la
-- flota. `donaji_consola` existe desde 0037 en todos los entornos.
GRANT INSERT, UPDATE ON core.unidad, core.conductor TO donaji_consola;
