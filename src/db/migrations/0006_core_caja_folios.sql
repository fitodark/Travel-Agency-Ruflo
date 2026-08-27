-- =============================================================================
-- 0006 · Cortes de caja, movimientos y el servicio de folios.
-- Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §1 y §3
-- =============================================================================

CREATE TABLE core.corte_caja (
  id                    uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  sucursal_id           uuid NOT NULL REFERENCES core.sucursal(id),
  usuario_apertura_id   uuid NOT NULL REFERENCES core.usuario(id),
  usuario_cierre_id     uuid REFERENCES core.usuario(id),
  -- Req: al abrir "únicamente se pide el saldo inicial que corresponde al
  -- efectivo que deberá tener la sucursal en caja para dar cambio".
  saldo_inicial         numeric(12,2) NOT NULL CHECK (saldo_inicial >= 0),
  abierto_en            timestamptz NOT NULL DEFAULT now(),
  cerrado_en            timestamptz,
  estado                text NOT NULL DEFAULT 'abierto'
                        CHECK (estado IN ('abierto','cerrado')),
  saldo_final_declarado numeric(12,2),   -- lo que el usuario cuenta físicamente
  saldo_final_calculado numeric(12,2),   -- derivado de los movimientos activos
  CHECK (estado = 'abierto' OR cerrado_en IS NOT NULL)
);
SELECT core.registrar_entidad('core.corte_caja');

-- Req: "durante el día pueden darse de alta varios cortes de caja de la
-- sucursal pero SOLO PUEDE EXISTIR UNO ACTIVO".
-- Se garantiza con una CONSTRAINT de base de datos, no con lógica de
-- aplicación: la lógica se puede saltar, el índice no.
CREATE UNIQUE INDEX corte_unico_abierto_idx
  ON core.corte_caja (sucursal_id)
  WHERE estado = 'abierto' AND activo;


CREATE TABLE core.movimiento_caja (
  id            uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  corte_caja_id uuid NOT NULL REFERENCES core.corte_caja(id),
  tipo          text NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  -- Polimorfismo preparado para la Etapa 2 (punto de extensión E2): el cobro de
  -- paquetería sumará al corte sin tocar este módulo.
  origen_tipo   text NOT NULL CHECK (origen_tipo IN
                  ('pago_boleto','gasto_insumo','devolucion','pago_paqueteria')),
  origen_id     uuid,          -- pago_id, o NULL para un gasto libre
  descripcion   text,          -- req: campo de texto para el gasto del día
  monto         numeric(12,2) NOT NULL CHECK (monto > 0),
  usuario_id    uuid NOT NULL REFERENCES core.usuario(id),
  registrado_en timestamptz NOT NULL DEFAULT now(),
  CHECK (origen_tipo <> 'gasto_insumo' OR descripcion IS NOT NULL)
  -- La columna estándar `activo` implementa el requisito activo/inactivo del
  -- requerimiento: al "eliminar" un egreso, activo=false, el monto regresa al
  -- corte del día y el registro PERMANECE visible para la auditoría del
  -- administrador ("para visualizar posibles malos manejos").
);
SELECT core.registrar_entidad('core.movimiento_caja');

CREATE INDEX movimiento_corte_idx ON core.movimiento_caja (corte_caja_id) WHERE activo;

ALTER TABLE core.pago
  ADD CONSTRAINT pago_corte_fk FOREIGN KEY (corte_caja_id)
  REFERENCES core.corte_caja(id);


-- =============================================================================
-- FOLIOS · 6 caracteres alfanuméricos generados offline sin colisión posible.
--
-- El requerimiento pide "un folio único de 6 dígitos (letras y números)"
-- generado en N sucursales sin conexión. Un folio ALEATORIO colisiona por
-- paradoja del cumpleaños y, estando offline, no hay forma de detectarlo a
-- tiempo. Se elimina el problema por construcción:
--
--   [S][CCCCC]   S = código de sucursal (1 char)
--                C = contador local monotónico en base32 (5 chars)
--
-- Alfabeto base32 SIN I, L, O, U. La razón es operativa y concreta: los folios
-- se dictan por teléfono y se teclean a mano en la terminal destino para
-- liquidar reservaciones. Confundir 0/O o 1/I es constante en operación real.
--
-- Techo: 32 sucursales, 33,554,432 folios por sucursal (~255 años a 360/día).
-- El límite queda documentado aquí, no escondido en el código.
-- =============================================================================
CREATE TABLE core.folio_secuencia (
  sucursal_id uuid PRIMARY KEY REFERENCES core.sucursal(id),
  codigo      char(1) NOT NULL,
  siguiente   bigint  NOT NULL DEFAULT 0
              CHECK (siguiente >= 0 AND siguiente < 33554432)  -- 32^5
);

CREATE OR REPLACE FUNCTION core.base32_donaji(p_valor bigint, p_ancho integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  c_alfabeto constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  -- sin I L O U
  v_out text := '';
  v_n   bigint := p_valor;
BEGIN
  IF p_valor < 0 THEN RAISE EXCEPTION 'valor negativo'; END IF;
  WHILE v_n > 0 LOOP
    v_out := substr(c_alfabeto, (v_n % 32)::int + 1, 1) || v_out;
    v_n := v_n / 32;
  END LOOP;
  RETURN lpad(v_out, p_ancho, '0');
END $$;

-- Atómica: FOR UPDATE serializa a los concurrentes. Con una sola PC por
-- sucursal (D-1) la concurrencia es intra-proceso, pero la garantía se mantiene
-- si algún día hay una segunda caja.
CREATE OR REPLACE FUNCTION core.siguiente_folio(p_sucursal_id uuid)
RETURNS char(6) LANGUAGE plpgsql AS $$
DECLARE v_codigo char(1); v_n bigint;
BEGIN
  UPDATE core.folio_secuencia
     SET siguiente = siguiente + 1
   WHERE sucursal_id = p_sucursal_id
   RETURNING codigo, siguiente - 1 INTO v_codigo, v_n;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no existe secuencia de folios para la sucursal %', p_sucursal_id;
  END IF;

  RETURN v_codigo || core.base32_donaji(v_n, 5);
END $$;

-- Toda sucursal nueva obtiene su secuencia automáticamente: dar de alta una
-- sucursal debe ser configuración, no un procedimiento manual.
CREATE OR REPLACE FUNCTION core.trg_crear_secuencia_folio() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO core.folio_secuencia (sucursal_id, codigo)
  VALUES (NEW.id, NEW.codigo)
  ON CONFLICT (sucursal_id) DO UPDATE SET codigo = EXCLUDED.codigo;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_secuencia_folio AFTER INSERT ON core.sucursal
  FOR EACH ROW EXECUTE FUNCTION core.trg_crear_secuencia_folio();
