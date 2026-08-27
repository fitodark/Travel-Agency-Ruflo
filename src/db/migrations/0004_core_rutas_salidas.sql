-- =============================================================================
-- 0004 · Rutas, horarios, salidas materializadas y cupos offline.
--
-- Tres niveles deliberadamente separados:
--   ruta    = plantilla geográfica (qué sucursales toca y en qué orden)
--   horario = plantilla temporal   (a qué hora, qué días, qué conductor)
--   salida  = INSTANCIA concreta   (el viaje del 14 de marzo a las 07:00)
--
-- Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5 y §6
-- =============================================================================

CREATE TABLE core.ruta (
  id                  uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  nombre              text NOT NULL,
  sucursal_origen_id  uuid NOT NULL REFERENCES core.sucursal(id),
  sucursal_destino_id uuid NOT NULL REFERENCES core.sucursal(id)
);
SELECT core.registrar_entidad('core.ruta');


-- Req: "las sucursales origen y destino pueden hacer paradas en sucursales
-- intermedias". El `orden` es el índice de tramo: un boleto de la parada i a la
-- j ocupa int4range(i, j).
CREATE TABLE core.ruta_parada (
  id          uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  ruta_id     uuid NOT NULL REFERENCES core.ruta(id),
  sucursal_id uuid NOT NULL REFERENCES core.sucursal(id),
  orden       smallint NOT NULL CHECK (orden >= 0),
  -- Proporción sugerida para el reparto de cupos offline. Se recalcula de noche
  -- según demanda histórica.
  peso_cupo   numeric(5,4) NOT NULL DEFAULT 0 CHECK (peso_cupo BETWEEN 0 AND 1),
  UNIQUE (ruta_id, orden),
  UNIQUE (ruta_id, sucursal_id)
);
SELECT core.registrar_entidad('core.ruta_parada');


CREATE TABLE core.horario (
  id             uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  ruta_id        uuid NOT NULL REFERENCES core.ruta(id),
  hora_salida    time NOT NULL,                 -- de la parada 0
  dias_semana    smallint[] NOT NULL CHECK (array_length(dias_semana,1) BETWEEN 1 AND 7),
  conductor_id   uuid REFERENCES core.conductor(id),  -- D-7: de aquí sale el tipo
  unidad_id      uuid REFERENCES core.unidad(id),     -- opcional en el horario
  vigente_desde  date,
  vigente_hasta  date,
  effective_from timestamptz NOT NULL DEFAULT now(),  -- ventana de madrugada
  effective_until timestamptz
);
SELECT core.registrar_entidad('core.horario');

-- Req: "considerar que dichas terminales intermedias también cuentan con un
-- horario", por lo que la hora de paso se define por parada, no solo la salida.
CREATE TABLE core.horario_parada (
  id             uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  horario_id     uuid NOT NULL REFERENCES core.horario(id),
  ruta_parada_id uuid NOT NULL REFERENCES core.ruta_parada(id),
  orden          smallint NOT NULL,
  hora_paso      time NOT NULL,
  UNIQUE (horario_id, orden)
);
SELECT core.registrar_entidad('core.horario_parada');


CREATE TABLE core.tarifa (
  id                  uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  ruta_id             uuid NOT NULL REFERENCES core.ruta(id),
  parada_origen_orden  smallint NOT NULL,
  parada_destino_orden smallint NOT NULL,
  importe             numeric(12,2) NOT NULL CHECK (importe >= 0),
  effective_from      timestamptz NOT NULL DEFAULT now(),
  effective_until     timestamptz,
  CHECK (parada_origen_orden < parada_destino_orden)
);
SELECT core.registrar_entidad('core.tarifa');


-- =============================================================================
-- SALIDA · la entidad central de la operación.
--
-- D-7, corrección crítica: el mapa de asientos se CONGELA por snapshot al
-- materializar la salida. NO se resuelve en vivo por la cadena
-- salida -> conductor -> unidad -> tipo_unidad -> mapa.
--
-- Razón: el cambio de conductor es un evento COTIDIANO (enfermedad, cambio de
-- turno). Si arrastrara el mapa, un relevo rutinario podría invalidar asientos
-- ya vendidos e impresos en OTRAS sucursales, que ni siquiera pueden consultarlo
-- si están offline. El snapshot desacopla el evento operativo diario del
-- invariante de datos.
-- =============================================================================
CREATE TABLE core.salida (
  id              uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  horario_id      uuid NOT NULL REFERENCES core.horario(id),
  fecha_operacion date NOT NULL,
  -- Snapshot congelado
  tipo_unidad_id  uuid NOT NULL REFERENCES core.tipo_unidad(id),
  mapa_snapshot   jsonb NOT NULL,
  -- Datos operativos, mutables
  unidad_id       uuid REFERENCES core.unidad(id),
  conductor_id    uuid REFERENCES core.conductor(id),
  conductor_nombre_snapshot text,   -- el manifiesto ya impreso no debe cambiar
  estado          text NOT NULL DEFAULT 'programada'
                  CHECK (estado IN ('programada','en_ruta','finalizada','cancelada')),
  salida_real_en  timestamptz,      -- currentDateTime al marcar "en ruta"
  UNIQUE (horario_id, fecha_operacion)
);
SELECT core.registrar_entidad('core.salida');

CREATE INDEX salida_fecha_idx ON core.salida (fecha_operacion, estado) WHERE activo;


CREATE TABLE core.salida_parada (
  id                   uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  salida_id            uuid NOT NULL REFERENCES core.salida(id),
  sucursal_id          uuid NOT NULL REFERENCES core.sucursal(id),
  orden                smallint NOT NULL CHECK (orden >= 0),
  hora_paso_programada timestamptz NOT NULL,
  -- SUPUESTO S4: cierre de venta a T-15 min. Parametrizable.
  cierre_venta_en      timestamptz NOT NULL,
  UNIQUE (salida_id, orden)
);
SELECT core.registrar_entidad('core.salida_parada');

CREATE INDEX salida_parada_busqueda_idx
  ON core.salida_parada (sucursal_id, hora_paso_programada);


-- =============================================================================
-- CUPO OFFLINE · el mecanismo que hace imposible la sobreventa estando offline.
--
-- Se reparten BLOQUES CONTIGUOS COMPLETOS (filas o banca), nunca asientos
-- sueltos de filas distintas (D-6). Si a una sucursal intermedia se le asignaran
-- p.ej. {3, 9, 16}, una pareja quedaría separada en filas distintas aunque la
-- unidad fuera casi vacía, y el cliente lo leería como un defecto del sistema.
--
-- Los conjuntos de asientos de sucursales distintas son DISJUNTOS: por eso, sin
-- conexión, la sobreventa no es "improbable" sino imposible.
-- Ver docs/architecture/01b-consistencia-asientos.md §3
-- =============================================================================
CREATE TABLE core.cupo_offline (
  id            uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  salida_id     uuid NOT NULL REFERENCES core.salida(id),
  sucursal_id   uuid NOT NULL REFERENCES core.sucursal(id),
  asientos      smallint[] NOT NULL CHECK (array_length(asientos,1) > 0),
  bloques       text[]     NOT NULL,   -- trazabilidad del reparto
  tramos        int4range  NOT NULL,   -- desde qué parada puede vender
  vigente_desde timestamptz NOT NULL,
  -- SUPUESTO S5: devolución automática al pool a T-4 h. La expiración es una
  -- FUNCIÓN DEL TIEMPO, no un mensaje: la sucursal dueña y la nube llegan a la
  -- misma conclusión sin comunicarse, igual que un lease de DHCP.
  vigente_hasta timestamptz NOT NULL,
  UNIQUE (salida_id, sucursal_id)
);
SELECT core.registrar_entidad('core.cupo_offline');

CREATE INDEX cupo_offline_busqueda_idx ON core.cupo_offline (salida_id, sucursal_id);


-- =============================================================================
-- Auditoría del cambio de conductor (clase C: append-only).
-- Ver la regla completa en docs/architecture/02-modelo-datos.md §5.3:
--   caso 1 compatible        -> libre, no toca mapa ni cupos
--   caso 2 incompatible      -> gerente/admin, exige conexión, encola reasignación
--   caso 3 sin boletos       -> libre, re-materializa mapa y cupos
--   caso 4 en_ruta/finalizada-> prohibido
-- =============================================================================
CREATE TABLE core.cambio_conductor (
  id                      uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  salida_id               uuid NOT NULL REFERENCES core.salida(id),
  conductor_anterior_id   uuid REFERENCES core.conductor(id),
  conductor_nuevo_id      uuid NOT NULL REFERENCES core.conductor(id),
  tipo_unidad_anterior_id uuid REFERENCES core.tipo_unidad(id),
  tipo_unidad_nuevo_id    uuid REFERENCES core.tipo_unidad(id),
  caso                    smallint NOT NULL CHECK (caso BETWEEN 1 AND 4),
  requirio_autorizacion   boolean  NOT NULL DEFAULT false,
  autorizado_por          uuid REFERENCES core.usuario(id),
  boletos_afectados       smallint NOT NULL DEFAULT 0,
  motivo                  text,
  estado                  text NOT NULL DEFAULT 'aplicado'
                          CHECK (estado IN ('aplicado','pendiente','rechazado')),
  aplicado_en             timestamptz
);
SELECT core.registrar_entidad('core.cambio_conductor');


-- Vistas de vigencia (nadie lee las tablas base directamente)
CREATE VIEW core.v_horario_vigente AS
SELECT * FROM core.horario
 WHERE activo AND effective_from <= now()
   AND (effective_until IS NULL OR effective_until > now());

CREATE VIEW core.v_tarifa_vigente AS
SELECT * FROM core.tarifa
 WHERE activo AND effective_from <= now()
   AND (effective_until IS NULL OR effective_until > now());
