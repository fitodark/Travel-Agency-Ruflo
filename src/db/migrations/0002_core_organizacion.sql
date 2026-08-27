-- =============================================================================
-- 0002 · Organización: agencia, sucursales, roles, usuarios.
-- Clase A (configuración): flujo nube -> sucursal. El nodo nunca las escribe,
-- así que no pueden generar conflicto.
-- Blueprint v0.2 · docs/architecture/02-modelo-datos.md §7
-- =============================================================================

CREATE TABLE core.agencia (
  id     uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  nombre text NOT NULL,
  rfc    text
);
SELECT core.registrar_entidad('core.agencia');


-- El `codigo` de 1 carácter es el prefijo del folio de 6 caracteres. Su alfabeto
-- (base32 sin I, L, O, U) impone un techo de 32 sucursales: documentado aquí y
-- no escondido en el código. Ver 02b-modelo-transaccional.md §1.
CREATE TABLE core.sucursal (
  id                 uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  agencia_id         uuid NOT NULL REFERENCES core.agencia(id),
  nombre             text NOT NULL,
  direccion_completa text NOT NULL,   -- se imprime en el ticket
  telefono_principal text NOT NULL,   -- se imprime en el ticket
  codigo             char(1) NOT NULL UNIQUE
                     CHECK (codigo ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]$'),
  zona_horaria       text NOT NULL DEFAULT 'America/Mexico_City',
  effective_from     timestamptz NOT NULL DEFAULT now(),
  effective_until    timestamptz
);
SELECT core.registrar_entidad('core.sucursal');


-- Matriz de permisos como DATO replicado, no como `if` en el código: permite
-- ajustar permisos sin desplegar, lo cual importa especialmente bajo D-8, donde
-- desplegar significa que un humano visite 4 terminales por TeamViewer.
CREATE TABLE core.rol_permiso (
  rol     text NOT NULL CHECK (rol IN ('administrador','gerente','vendedor')),
  permiso text NOT NULL,
  PRIMARY KEY (rol, permiso)
);


CREATE TABLE core.usuario (
  id       uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  nombre   text   NOT NULL,
  email    citext NOT NULL UNIQUE,
  rol      text   NOT NULL CHECK (rol IN ('administrador','gerente','vendedor')),
  telefono text,
  sueldo   numeric(12,2),   -- req: reportes de gastos. VACÍO V4: no genera
                            -- movimientos de caja automáticos.
  -- Alta y baja diferidas: la ventana de madrugada se implementa como DATO con
  -- fecha de vigencia, no como un comando remoto que exige estar conectado a las
  -- 3 a.m. Ver 03-auth-impresion-config.md §3.
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz
);
SELECT core.registrar_entidad('core.usuario');


-- Req: "los usuarios solo podrán ingresar si tienen una sucursal activa".
CREATE TABLE core.usuario_sucursal (
  id              uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  usuario_id      uuid NOT NULL REFERENCES core.usuario(id),
  sucursal_id     uuid NOT NULL REFERENCES core.sucursal(id),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  UNIQUE (usuario_id, sucursal_id)
);
SELECT core.registrar_entidad('core.usuario_sucursal');


-- -----------------------------------------------------------------------------
-- Vistas de vigencia. NADIE lee las tablas base directamente: todo el sistema
-- consume las vistas v_*_vigente, y así la ventana de configuración se aplica
-- sola con el reloj local del nodo, sin necesidad de red.
-- -----------------------------------------------------------------------------
CREATE VIEW core.v_sucursal_vigente AS
SELECT * FROM core.sucursal
 WHERE activo AND effective_from <= now()
   AND (effective_until IS NULL OR effective_until > now());

CREATE VIEW core.v_usuario_vigente AS
SELECT * FROM core.usuario
 WHERE activo AND effective_from <= now()
   AND (effective_until IS NULL OR effective_until > now());

CREATE VIEW core.v_usuario_sucursal_vigente AS
SELECT * FROM core.usuario_sucursal
 WHERE activo AND effective_from <= now()
   AND (effective_until IS NULL OR effective_until > now());
