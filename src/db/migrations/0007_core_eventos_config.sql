-- =============================================================================
-- 0007 · Eventos operativos (clase C), impresión y configuración.
--
-- Clase C = hechos append-only. Nunca hay UPDATE, así que la unión de hechos de
-- todas las réplicas es conmutativa y converge sin arbitraje. Es el patrón que
-- la Etapa 2 reutilizará para el rastreo de paquetería (extensión E5).
--
-- Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §5 y §6
-- =============================================================================

-- Req §Viajes efectuados: el checklist es manual (lápiz) y luego se captura.
-- Corregir un abordaje mal capturado es INSERTAR otro hecho que anula al
-- anterior, nunca un UPDATE: así dos sucursales jamás compiten por la fila.
CREATE TABLE core.evento_abordaje (
  id              uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  boleto_id       uuid NOT NULL REFERENCES core.boleto(id),
  salida_id       uuid NOT NULL REFERENCES core.salida(id),
  abordo          boolean NOT NULL,   -- false = no se presentó
  registrado_por  uuid NOT NULL REFERENCES core.usuario(id),
  sucursal_id     uuid NOT NULL REFERENCES core.sucursal(id),
  registrado_en   timestamptz NOT NULL DEFAULT now(),
  anula_evento_id uuid REFERENCES core.evento_abordaje(id)
);
SELECT core.registrar_entidad('core.evento_abordaje');
CREATE INDEX abordaje_salida_idx ON core.evento_abordaje (salida_id);


-- Req: al marcar la salida se registra conductor, fecha/hora del sistema y el
-- estado "En camino"/"En ruta". Un estado en ruta bloquea toda venta.
CREATE TABLE core.evento_salida (
  id             uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  salida_id      uuid NOT NULL REFERENCES core.salida(id),
  tipo           text NOT NULL CHECK (tipo IN
                   ('en_ruta','llegada_parada','finalizada','cancelada')),
  parada_orden   smallint,
  ocurrido_en    timestamptz NOT NULL DEFAULT now(),
  registrado_por uuid NOT NULL REFERENCES core.usuario(id)
);
SELECT core.registrar_entidad('core.evento_salida');


CREATE TABLE core.nota_auditoria (
  id          uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  entidad     text NOT NULL,
  entidad_id  uuid NOT NULL,
  tipo        text NOT NULL,   -- reasignacion_por_conflicto | override_asiento |
                               -- reimpresion | importe_sobrescrito |
                               -- cambio_conductor_forzado | abordaje_con_saldo
  detalle     jsonb NOT NULL DEFAULT '{}'::jsonb,
  usuario_id  uuid NOT NULL REFERENCES core.usuario(id),
  sucursal_id uuid NOT NULL REFERENCES core.sucursal(id),
  ocurrido_en timestamptz NOT NULL DEFAULT now()
);
SELECT core.registrar_entidad('core.nota_auditoria');
CREATE INDEX nota_entidad_idx ON core.nota_auditoria (entidad, entidad_id);


-- =============================================================================
-- IMPRESIÓN
--
-- El print_job se crea DENTRO de la misma transacción que la venta: si la venta
-- existe, el job existe; si la transacción falla, no queda un job huérfano
-- imprimiendo un boleto que nunca se vendió.
--
-- Un ticket por pasajero: una venta de 5 boletos crea 5 print_job, no uno con 5
-- cortes. Un fallo aísla un solo boleto y la reimpresión es granular.
-- =============================================================================
CREATE TABLE core.config_impresora (
  id                uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  sucursal_id       uuid NOT NULL REFERENCES core.sucursal(id),
  nombre            text NOT NULL,           -- req: "nombres de las impresoras"
  -- D-4: abstracción de transporte. La impresora Enduro tiene IP fija por su
  -- propia configuración, así que TCP:9100 es el primario; USB es alternativa de
  -- primera clase porque está junto a la PC. Cambiar de transporte es esta fila,
  -- no un redeploy.
  transporte        text NOT NULL DEFAULT 'tcp' CHECK (transporte IN ('tcp','usb')),
  ip                inet,
  puerto            integer DEFAULT 9100,
  usb_nombre_cola   text,
  ancho_mm          smallint NOT NULL DEFAULT 80,    -- Enduro 80 mm confirmado
  ancho_cols        smallint NOT NULL DEFAULT 48,    -- fuente A a 80 mm
  code_page         text NOT NULL DEFAULT 'CP858',   -- acentos y ñ
  soporta_qr_nativo boolean NOT NULL DEFAULT true,   -- GS ( k; si no, raster
  es_predeterminada boolean NOT NULL DEFAULT false,
  CHECK ((transporte = 'tcp' AND ip IS NOT NULL)
      OR (transporte = 'usb' AND usb_nombre_cola IS NOT NULL))
);
SELECT core.registrar_entidad('core.config_impresora');


CREATE TABLE core.print_job (
  id                  uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  sucursal_id         uuid NOT NULL REFERENCES core.sucursal(id),
  impresora_id        uuid REFERENCES core.config_impresora(id),
  template_key        text NOT NULL CHECK (template_key IN
                        ('boleto','manifiesto_conductor','manifiesto_terminal',
                         'corte','etiqueta_paquete')),   -- Etapa 2: extensión E3
  -- Snapshot completo: el ticket impreso no cambia aunque los datos de origen
  -- cambien después.
  datos               jsonb NOT NULL,
  estado              text NOT NULL DEFAULT 'pendiente' CHECK (estado IN
                        ('pendiente','imprimiendo','impreso','fallido','revision_manual')),
  intentos            smallint NOT NULL DEFAULT 0,
  ultimo_error        text,
  es_reimpresion      boolean NOT NULL DEFAULT false,
  motivo_reimpresion  text,
  boleto_id           uuid REFERENCES core.boleto(id),
  impreso_en          timestamptz,
  CHECK (NOT es_reimpresion OR motivo_reimpresion IS NOT NULL)
);
SELECT core.registrar_entidad('core.print_job');

CREATE INDEX print_job_cola_idx ON core.print_job (estado, creado_en)
  WHERE estado IN ('pendiente','imprimiendo');


CREATE TABLE core.config_ticket (
  id                     uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  agencia_id             uuid NOT NULL REFERENCES core.agencia(id),
  logo_url               text,
  telefono_atencion      text,
  leyenda_pie            text,   -- "buen viaje, estamos para servirle"
  credenciales_proveedor text,
  -- Clave del HMAC que firma el texto plano del QR. El requerimiento pide texto
  -- plano y no URL (correcto: no depende de un servidor externo), pero eso lo
  -- hace falsificable con cualquier generador gratuito. El HMAC truncado permite
  -- validar el boleto OFFLINE en la terminal destino sin dejar de ser texto
  -- plano. Propuesta a validar con el cliente; si se rechaza, se omite el campo
  -- sin ningún otro cambio en el diseño.
  hmac_qr_secreto        text,
  effective_from         timestamptz NOT NULL DEFAULT now()
);
SELECT core.registrar_entidad('core.config_ticket');


-- =============================================================================
-- PARÁMETROS · todos los supuestos numéricos del blueprint viven aquí, no en
-- constantes de código. Validar un supuesto con el cliente debe costar una fila,
-- no un despliegue — lo cual importa el doble bajo D-8, donde desplegar
-- significa que un humano visite 4 terminales por TeamViewer de madrugada.
-- =============================================================================
CREATE TABLE core.parametro (
  clave          text PRIMARY KEY,
  valor          jsonb NOT NULL,
  descripcion    text,
  effective_from timestamptz NOT NULL DEFAULT now()
);
SELECT core.aplicar_estandar('core.parametro');
