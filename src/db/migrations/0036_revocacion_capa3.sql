-- =============================================================================
-- 0036 · Capa 3 de revocación offline: el código fuera de banda aplicado.
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5 (capa 3)
--                  docs/architecture/04-riesgos-roadmap.md §F2b (slice 3)
--
-- El escenario: se despide a un vendedor, la sucursal lleva días sin internet, y
-- la baja de clase A no ha bajado. El administrador genera en la consola un
-- código HOTP de 8 dígitos para (sucursal, usuario, contador) contra la semilla
-- de la sucursal (`auth_local.revocacion_hotp`, ya replicada por 0035), lo DICTA
-- POR TELÉFONO al gerente, y el gerente lo captura en la terminal. El nodo lo
-- valida OFFLINE contra su semilla y bloquea al usuario de inmediato.
--
-- `revocacion_aplicada` es la marca LOCAL de ese bloqueo. NO se replica: es
-- estado del nodo, como `auth_local.sesion`. La baja "de verdad" (clase A) llega
-- por sync cuando la sucursal recupera la red y a partir de ahí bloquea por el
-- camino normal; esta marca es el puente hasta entonces.
-- =============================================================================

CREATE TABLE auth_local.revocacion_aplicada (
  usuario_id  uuid PRIMARY KEY,
  sucursal_id uuid NOT NULL,
  -- Contador HOTP del código que se aceptó. Un código nuevo (contador mayor)
  -- puede reemplazar a este; uno con contador menor o igual es un reintento.
  contador    bigint      NOT NULL,
  aplicado_en timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE auth_local.revocacion_aplicada IS
  'Bloqueo local de un usuario por código de revocación HOTP (03 §1.5, capa 3). No se replica.';


-- Quién puede capturar el código en la terminal. El gerente, que es a quien el
-- administrador se lo dicta; el administrador también, por si está presente.
INSERT INTO core.rol_permiso (rol, permiso) VALUES
  ('gerente',       'usuario.revocar'),
  ('administrador', 'usuario.revocar')
ON CONFLICT (rol, permiso) DO NOTHING;
