-- =============================================================================
-- 0005 · Clientes, ventas, boletos, ocupación de asientos y pagos.
--
-- Contiene la invariante más importante del sistema: la restricción de exclusión
-- que hace físicamente imposible vender dos veces el mismo asiento en tramos que
-- se solapan.
--
-- Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §2
--                  docs/architecture/02b-modelo-transaccional.md §2
-- =============================================================================

CREATE TABLE core.cliente (
  id                   uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  nombre               text NOT NULL,
  telefono             text,
  email                citext,
  telefono_normalizado text GENERATED ALWAYS AS
                       (regexp_replace(COALESCE(telefono,''), '\D', '', 'g')) STORED,
  sucursal_registro_id uuid REFERENCES core.sucursal(id)
);
SELECT core.registrar_entidad('core.cliente');

-- Dos sucursales pueden registrar al mismo cliente. NO se fusionan
-- automáticamente: se genera un reporte de posibles duplicados. Fusionar mal es
-- peor que duplicar.
CREATE INDEX cliente_telefono_idx ON core.cliente (telefono_normalizado) WHERE activo;


-- =============================================================================
-- VENTA · el requerimiento no la nombra, pero el flujo de 6 pasos la implica:
-- una operación produce N boletos, un importe total y un método de pago.
--
-- Reservación y venta NO son entidades distintas. El requerimiento describe esa
-- confusión explícitamente ("una reservación que se paga al momento ya es una
-- venta en sí"). Se resuelve con dos atributos ortogonales:
--   es_reservacion   = CÓMO SE ORIGINÓ (inmutable, para reportes)
--   saldo_pendiente  = ESTADO ECONÓMICO (derivado de core.pago)
-- Así, "las reservaciones no generan ticket" se vuelve "se imprime cuando el
-- saldo llega a cero", sin importar cómo se originó.
-- =============================================================================
CREATE TABLE core.venta (
  id                   uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  sucursal_venta_id    uuid NOT NULL REFERENCES core.sucursal(id),
  usuario_id           uuid NOT NULL REFERENCES core.usuario(id),
  cliente_id           uuid REFERENCES core.cliente(id),
  -- SUPUESTO S11: obligatorio en TODAS las ventas, no solo en reservaciones.
  -- Sin un teléfono de contacto, la reasignación automática por conflicto de
  -- asiento (01b §7) no es operable: no habría a quién avisar.
  contacto_telefono    text NOT NULL,
  es_reservacion       boolean NOT NULL DEFAULT false,
  salida_id            uuid NOT NULL REFERENCES core.salida(id),
  parada_origen_orden  smallint NOT NULL,
  parada_destino_orden smallint NOT NULL,
  importe_total        numeric(12,2) NOT NULL CHECK (importe_total >= 0),
  estado               text NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('pendiente','liquidada','cancelada','conflicto')),
  CHECK (parada_origen_orden < parada_destino_orden)
  -- NO existe columna 'pagado': se deriva de la suma de core.pago.
);
SELECT core.registrar_entidad('core.venta');

CREATE INDEX venta_salida_idx ON core.venta (salida_id) WHERE activo;


CREATE TABLE core.boleto (
  id              uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  venta_id        uuid NOT NULL REFERENCES core.venta(id),
  -- Folio de 6 caracteres particionado por sucursal (ver 0006). El folio
  -- identifica LA VENTA, no el asiento: por eso un boleto puede cambiar de
  -- asiento conservando su folio, lo que convierte una sobreventa detectada
  -- tarde en un problema reversible.
  folio           char(6) NOT NULL UNIQUE,
  salida_id       uuid NOT NULL REFERENCES core.salida(id),
  asiento_num     smallint NOT NULL,
  tramos          int4range NOT NULL,
  pasajero_nombre text NOT NULL,          -- paso 4 del flujo
  importe         numeric(12,2) NOT NULL CHECK (importe >= 0),
  estado          text NOT NULL DEFAULT 'emitido'
                  CHECK (estado IN ('emitido','conflicto_sobreventa','reasignado','cancelado')),
  impreso_en      timestamptz,            -- pesa en la prioridad de arbitraje
  reimpresiones   smallint NOT NULL DEFAULT 0
);
SELECT core.registrar_entidad('core.boleto');

CREATE INDEX boleto_folio_idx  ON core.boleto (folio);   -- se dicta por teléfono
CREATE INDEX boleto_salida_idx ON core.boleto (salida_id) WHERE activo;


-- =============================================================================
-- ASIENTO_OCUPACION · LA INVARIANTE.
--
-- La restricción de exclusión es la última línea de defensa y es absoluta: la
-- base de datos físicamente no puede aceptar dos ocupaciones firmes del mismo
-- asiento en tramos que se solapan. Existe idéntica en el nodo local y en la
-- nube.
--
-- Dos boletos SÍ pueden compartir asiento si sus rangos de tramo no se solapan:
-- alguien baja en la parada 2 y otro sube ahí mismo al mismo asiento.
--
-- Requiere btree_gist (para uuid y smallint con opclase gist). Confirmado
-- disponible: el proyecto de Supabase es del proveedor (P6).
-- =============================================================================
CREATE TABLE core.asiento_ocupacion (
  id          uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  salida_id   uuid NOT NULL REFERENCES core.salida(id),
  asiento_num smallint NOT NULL,
  tramos      int4range NOT NULL,
  boleto_id   uuid NOT NULL REFERENCES core.boleto(id),
  estado      text NOT NULL DEFAULT 'firme'
              CHECK (estado IN ('firme','conflicto','liberado')),
  sucursal_id uuid NOT NULL REFERENCES core.sucursal(id),
  emitido_en  timestamptz NOT NULL,   -- reloj local de quien emitió
  -- Prioridad de arbitraje (SUPUESTO S2). Determinista y reproducible en ambos
  -- lados. Se calcula, NUNCA se decide por orden de llegada a la nube: eso
  -- premiaría a la sucursal con mejor internet y castigaría justo a la que el
  -- sistema promete proteger.
  prioridad   integer NOT NULL DEFAULT 0,

  EXCLUDE USING gist (
    salida_id   WITH =,
    asiento_num WITH =,
    tramos      WITH &&
  ) WHERE (estado = 'firme')
);
SELECT core.registrar_entidad('core.asiento_ocupacion');

CREATE INDEX ocupacion_salida_idx
  ON core.asiento_ocupacion (salida_id) WHERE estado = 'firme';


-- =============================================================================
-- LEASE · flexibilidad cuando SÍ hay conexión.
-- Permite vender un asiento fuera del cupo propio. La misma constraint de
-- exclusión protege contra ocupaciones firmes y contra otros leases vivos.
--
-- Propiedad clave: si el internet se cae DESPUÉS de conceder el lease, la venta
-- se completa igual. El nodo lo tiene guardado y es válido hasta expirar.
-- =============================================================================
CREATE TABLE core.asiento_lease (
  id          uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  salida_id   uuid NOT NULL REFERENCES core.salida(id),
  asiento_num smallint NOT NULL,
  tramos      int4range NOT NULL,
  sucursal_id uuid NOT NULL REFERENCES core.sucursal(id),
  otorgado_en timestamptz NOT NULL DEFAULT now(),
  expira_en   timestamptz NOT NULL,
  consumido_por_boleto_id uuid REFERENCES core.boleto(id),
  liberado_en timestamptz,

  -- Un lease vivo bloquea el asiento igual que una ocupación firme
  EXCLUDE USING gist (
    salida_id   WITH =,
    asiento_num WITH =,
    tramos      WITH &&
  ) WHERE (consumido_por_boleto_id IS NULL AND liberado_en IS NULL)
);
SELECT core.registrar_entidad('core.asiento_lease');

CREATE INDEX lease_vivo_idx ON core.asiento_lease (salida_id, expira_en)
  WHERE consumido_por_boleto_id IS NULL AND liberado_en IS NULL;


-- =============================================================================
-- PAGO · clase C (append-only). Resuelve el requisito más peligroso del
-- requerimiento: "la reservación puede pagarse en la terminal destino, y este
-- ingreso sumará al corte de la sucursal donde está siendo registrado".
--
-- Eso son DOS ESCRITORES sobre la misma venta. Se elimina el conflicto haciendo
-- que el estado económico no sea un campo mutable de la venta, sino la suma de
-- hechos append-only, cada uno propiedad de la sucursal que cobró.
--
-- CONTRADICCIÓN C5, consecuencia registrada: sucursal_cobro_id != la sucursal
-- de la venta ni la del viaje. Los reportes "ventas de la sucursal" y "corte de
-- caja de la sucursal" NO cuadran entre sí, y no deben cuadrar.
-- =============================================================================
CREATE TABLE core.pago (
  id                       uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  venta_id                 uuid NOT NULL REFERENCES core.venta(id),
  sucursal_cobro_id        uuid NOT NULL REFERENCES core.sucursal(id),
  corte_caja_id            uuid NOT NULL,   -- FK añadida en 0006
  usuario_id               uuid NOT NULL REFERENCES core.usuario(id),
  metodo                   text NOT NULL CHECK (metodo IN ('efectivo','transferencia')),
  monto                    numeric(12,2) NOT NULL CHECK (monto > 0),
  es_abono                 boolean NOT NULL DEFAULT false,
  -- Req. paso 6: "la venta por transferencia debe ser verificada posteriormente
  -- por el usuario que realizó dicha venta y en ese momento sumar al corte".
  -- El movimiento_caja SOLO se crea al verificar: el corte refleja únicamente
  -- dinero confirmado.
  verificado               boolean NOT NULL DEFAULT false,
  verificado_por           uuid REFERENCES core.usuario(id),
  verificado_en            timestamptz,
  referencia_transferencia text,
  pagado_en                timestamptz NOT NULL DEFAULT now(),
  CHECK (metodo = 'efectivo' OR NOT verificado OR verificado_por IS NOT NULL)
);
SELECT core.registrar_entidad('core.pago');

CREATE INDEX pago_venta_idx  ON core.pago (venta_id) WHERE activo;
CREATE INDEX pago_cobro_idx  ON core.pago (sucursal_cobro_id, pagado_en);
