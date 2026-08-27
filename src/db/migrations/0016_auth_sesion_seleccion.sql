-- =============================================================================
-- 0016 · La sesión puede existir antes de elegir sucursal.
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.3
--
-- El flujo de login valida credenciales y DESPUÉS el usuario elige sucursal
-- ("se elige sucursal al entrar"). `auth_local.sesion` nació con
-- `sucursal_id NOT NULL`, lo que obligaba a conocer la sucursal antes de tener
-- sesión — imposible cuando el usuario tiene más de una y todavía no eligió.
--
-- Se relaja: una sesión recién abierta puede no tener sucursal, pero entonces
-- NO puede operar. La API lo exige y aquí queda además como invariante de datos:
-- `sucursal_id` y `sucursal_elegida_en` van juntos o no van.
-- =============================================================================

ALTER TABLE auth_local.sesion
  ALTER COLUMN sucursal_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS sucursal_elegida_en timestamptz;

ALTER TABLE auth_local.sesion
  ADD CONSTRAINT sesion_sucursal_coherente
  CHECK ((sucursal_id IS NULL) = (sucursal_elegida_en IS NULL));
