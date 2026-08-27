# 02b — Modelo Transaccional: Ventas, Caja, Folios y Configuración

> Blueprint v0.2. Continúa [02-modelo-datos.md](02-modelo-datos.md).
> Toda tabla lleva el bloque de auditoría/sync de
> [01-sincronizacion.md §2.3](01-sincronizacion.md).

---

## 1. Folios de 6 caracteres generados offline sin colisión

Requerimiento: *"cada boleto debe generar un folio único de 6 dígitos (letras y números)"*.
Generado en N sucursales sin conexión, un folio **aleatorio** colisiona: con 36⁶ ≈ 2.2×10⁹
y ~130 000 boletos/año (360/día × 4 sucursales), la probabilidad por cumpleaños se vuelve
material a los pocos años — y estando offline no hay forma de detectarla a tiempo.

**Diseño: particionamiento del espacio + contador local, cero aleatoriedad.**

```
  F O L I O  =  [ S ] [ C C C C C ]
                  │      └── contador local en base32, 5 caracteres
                  └───────── código de sucursal, 1 carácter
```

- **Alfabeto**: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — 32 símbolos, **sin `I`, `L`, `O`, `U`**.
  Razón operativa concreta: los folios se dictan por teléfono y se teclean a mano en la
  terminal destino para liquidar reservaciones. Confundir `0`/`O` o `1`/`I` es constante en
  operación real.
- **Carácter 1** = `sucursal.codigo`, asignado al alta. Da hasta **32 sucursales**.
  Suficiente para 4 con margen amplio; el límite queda documentado aquí y no escondido en
  el código.
- **Caracteres 2–6** = contador monotónico local en base32 → **33 554 432 folios por
  sucursal**. A 360 boletos/día son ~255 años.
- `UNIQUE (folio)` en local **y** en la nube. Una violación en la nube es imposible por
  diseño; si ocurre, es señal de un bug o de dos nodos con el mismo `codigo` → excepción
  `folio_duplicado` de severidad crítica.

**Colisión: imposible por construcción, no improbable.** Es la diferencia entre un sistema
que se puede defender ante el cliente y uno que uno espera que aguante.

```sql
core.folio_secuencia (
  sucursal_id uuid PRIMARY KEY,
  codigo      char(1) NOT NULL,
  siguiente   bigint NOT NULL DEFAULT 0,   -- se codifica a base32 de 5 chars
  CHECK (siguiente < 33554432)             -- 32^5
)
-- core.siguiente_folio(sucursal_id) -> char(6)   [FOR UPDATE, atómica]
```

El mismo servicio sirve para el número de control de paquetería en Etapa 2 (punto de
extensión E1).

---

## 2. Venta, boletos y reservaciones

Se introduce la entidad **`venta`**, que el requerimiento no nombra pero que el flujo de 6
pasos implica: una operación produce N boletos, un importe total, un método de pago, y
"un ticket por cada persona".

```sql
core.venta (
  id uuid PK,
  sucursal_venta_id uuid FK NOT NULL,    -- dónde se originó
  usuario_id uuid FK NOT NULL,           -- quién vendió
  cliente_id uuid FK,                    -- opcional
  contacto_telefono text NOT NULL,       -- SUPUESTO S11, obligatorio
  es_reservacion boolean NOT NULL,       -- checkbox del paso 1, INMUTABLE
  salida_id uuid FK NOT NULL,
  parada_origen_orden smallint NOT NULL,
  parada_destino_orden smallint NOT NULL,
  importe_total numeric(12,2) NOT NULL,
  estado text NOT NULL,                  -- pendiente|liquidada|cancelada|conflicto
  CHECK (parada_origen_orden < parada_destino_orden)
  -- NO existe columna 'pagado': se deriva de la suma de core.pago
)

core.boleto (
  id uuid PK,
  venta_id uuid FK NOT NULL,
  folio char(6) NOT NULL UNIQUE,
  salida_id uuid FK NOT NULL,
  asiento_num smallint NOT NULL,
  tramos int4range NOT NULL,
  pasajero_nombre text NOT NULL,         -- paso 4
  importe numeric(12,2) NOT NULL,
  estado text NOT NULL,                  -- emitido|conflicto_sobreventa|reasignado|cancelado
  impreso_en timestamptz,                -- pesa en la prioridad de arbitraje (01b §6)
  reimpresiones smallint NOT NULL DEFAULT 0
)
```

`core.asiento_ocupacion`, `core.cupo_offline` y `core.asiento_lease` están definidas en
[01b-consistencia-asientos.md](01b-consistencia-asientos.md).

### 2.1 Reservación y venta no son entidades distintas

El requerimiento describe una zona confusa: *"aquí puede existir una confusión en la cual
una reservación que se paga en efectivo o transferencia en el momento ya es una venta en
sí"*. Se resuelve con **una sola entidad y dos atributos ortogonales**:

| Atributo | Significado |
|---|---|
| `es_reservacion` (bool, inmutable) | **Cómo se originó.** Para el reporte al administrador ("etiquetar que fue por reservación"). No cambia nunca. |
| `saldo_pendiente` (derivado de `pago`) | **Estado económico actual.** `> 0` = no liquidada. |

Consecuencias que caen solas:

- "Las reservaciones no generan ticket" → se imprime cuando `saldo_pendiente = 0`,
  independientemente de `es_reservacion`.
- "Una reservación pagada al momento ya es una venta" → `es_reservacion=true`,
  `saldo_pendiente=0`, se imprime, y el reporte la sigue contando como reservación.
- "Abono parcial" → `saldo_pendiente > 0`, sin ticket, bloquea abordaje (SUPUESTO S8).

Esto elimina un cambio de estado inter-sucursal que habría sido un conflicto de escritura.

### 2.2 Pagos — clase C, append-only

```sql
core.pago (
  id uuid PK,
  venta_id uuid FK NOT NULL,
  sucursal_cobro_id uuid FK NOT NULL,    -- ≠ sucursal_venta_id (CONTRADICCIÓN C5)
  corte_caja_id uuid FK NOT NULL,        -- a qué corte suma
  usuario_id uuid FK NOT NULL,
  metodo text NOT NULL,                  -- 'efectivo' | 'transferencia'
  monto numeric(12,2) NOT NULL CHECK (monto > 0),
  es_abono boolean NOT NULL,
  verificado boolean NOT NULL DEFAULT false,   -- transferencias, req. paso 6
  verificado_por uuid, verificado_en timestamptz,
  referencia_transferencia text,
  pagado_en timestamptz NOT NULL
)
```

**Nunca se hace `UPDATE` de un pago** salvo la verificación de transferencia, que es
single-writer del mismo usuario que vendió. Cancelar un pago es `activo=false` más un
`movimiento_caja` de egreso; la vista derivada solo suma `activo=true`.

Regla del requerimiento: *"la venta por transferencia debe ser verificada posteriormente
por el usuario que realizó dicha venta y en ese momento sumar al corte de caja"*. Se
implementa así: el pago existe desde el inicio con `verificado=false`, y el
`movimiento_caja` **solo se crea al verificar**. El corte refleja únicamente dinero
confirmado.

### 2.3 Vistas derivadas (no columnas)

```sql
CREATE VIEW core.v_venta_saldo AS
SELECT v.id AS venta_id, v.importe_total,
       COALESCE(SUM(p.monto) FILTER (WHERE p.activo AND p.verificado), 0) AS pagado,
       v.importe_total - COALESCE(SUM(p.monto)
         FILTER (WHERE p.activo AND p.verificado), 0)                     AS saldo_pendiente
FROM core.venta v LEFT JOIN core.pago p ON p.venta_id = v.id
WHERE v.activo GROUP BY v.id, v.importe_total;
```

---

## 3. Corte de caja y movimientos

```sql
core.corte_caja (
  id uuid PK,
  sucursal_id uuid FK NOT NULL,
  usuario_apertura_id uuid FK NOT NULL,
  usuario_cierre_id uuid FK,
  saldo_inicial numeric(12,2) NOT NULL,
  abierto_en timestamptz NOT NULL, cerrado_en timestamptz,
  estado text NOT NULL,                 -- 'abierto' | 'cerrado'
  saldo_final_declarado numeric(12,2),  -- lo que el usuario cuenta físicamente
  saldo_final_calculado numeric(12,2)   -- derivado de movimientos
);
-- "solo puede existir uno activo": garantizado por CONSTRAINT, no por lógica
CREATE UNIQUE INDEX corte_unico_abierto
  ON core.corte_caja (sucursal_id) WHERE estado = 'abierto' AND activo;

core.movimiento_caja (
  id uuid PK,
  corte_caja_id uuid FK NOT NULL,
  tipo text NOT NULL,                   -- 'ingreso' | 'egreso'
  -- polimorfismo preparado para Etapa 2 sin tocar este módulo (extensión E2)
  origen_tipo text NOT NULL,            -- pago_boleto | gasto_insumo |
                                        -- devolucion | pago_paqueteria (Etapa 2)
  origen_id uuid,                       -- pago_id, o NULL para gasto libre
  descripcion text,                     -- req: campo de texto para el gasto
  monto numeric(12,2) NOT NULL CHECK (monto > 0),
  usuario_id uuid FK NOT NULL,
  registrado_en timestamptz NOT NULL
  -- 'activo' implementa el requisito activo/inactivo: al "eliminar", activo=false →
  -- el egreso regresa al corte y el registro permanece para auditoría
)
```

**Visibilidad por rol** (requerimiento explícito):

| Rol | Ve movimientos |
|---|---|
| vendedor | activos de su corte |
| gerente | **solo activos** |
| administrador | **activos e inactivos** (auditoría de posibles malos manejos) |

Dos vistas (`v_movimiento_operativo`, `v_movimiento_auditoria`), verificadas en la API y
adicionalmente con RLS en la nube.

`saldo_final_calculado = saldo_inicial + Σ ingresos activos − Σ egresos activos`.

**Nota derivada de C5**: el corte de una sucursal incluye pagos de ventas originadas en
otras (reservación cobrada en destino). El reporte "ventas de la sucursal" y el reporte
"corte de caja de la sucursal" **no cuadran entre sí y no deben cuadrar**. Se documenta en
el dashboard para que el administrador no lo lea como un error del sistema.

---

## 4. Clientes

```sql
core.cliente (
  id uuid PK,
  nombre text NOT NULL, telefono text, email citext,
  telefono_normalizado text GENERATED ALWAYS AS
    (regexp_replace(COALESCE(telefono,''), '\D', '', 'g')) STORED,
  sucursal_registro_id uuid FK
)
CREATE INDEX ON core.cliente (telefono_normalizado) WHERE activo;
```

Dos sucursales pueden registrar al mismo cliente. **No se fusionan automáticamente**: se
genera un reporte de posibles duplicados para el administrador. Fusionar mal es peor que
duplicar.

---

## 5. Eventos operativos (clase C, append-only)

```sql
core.evento_abordaje (
  id uuid PK, boleto_id uuid FK NOT NULL, salida_id uuid FK NOT NULL,
  abordo boolean NOT NULL,              -- true=abordó, false=no se presentó
  registrado_por uuid FK NOT NULL, sucursal_id uuid FK NOT NULL,
  registrado_en timestamptz NOT NULL,
  anula_evento_id uuid                  -- corrección: nuevo hecho, no UPDATE
)

core.evento_salida (
  id uuid PK, salida_id uuid FK NOT NULL,
  tipo text NOT NULL,                   -- en_ruta | llegada_parada | finalizada
  parada_orden smallint, ocurrido_en timestamptz NOT NULL,
  registrado_por uuid FK NOT NULL
)

core.nota_auditoria (
  id uuid PK, entidad text NOT NULL, entidad_id uuid NOT NULL,
  tipo text NOT NULL,                   -- reasignacion_por_conflicto | override_asiento |
                                        -- reimpresion | importe_sobrescrito | ...
  detalle jsonb NOT NULL,
  usuario_id uuid FK NOT NULL, sucursal_id uuid FK NOT NULL,
  ocurrido_en timestamptz NOT NULL
)
```

El requerimiento pide **dos listas de pasajeros impresas** (conductor y terminal): son el
mismo manifiesto con distinto pie, ver
[03-auth-impresion-config.md §2.5](03-auth-impresion-config.md). El manifiesto de la
terminal marca en negritas los boletos con `estado='conflicto_sobreventa'` — última línea
de defensa de [01b §7](01b-consistencia-asientos.md).

---

## 6. Impresión y configuración

```sql
core.print_job (
  id uuid PK,
  sucursal_id uuid FK, impresora_id uuid FK,
  template_key text NOT NULL,        -- boleto | manifiesto | corte |
                                     -- etiqueta_paquete (Etapa 2, extensión E3)
  datos jsonb NOT NULL,              -- snapshot completo: el ticket no cambia si los
                                     -- datos de origen cambian después
  estado text NOT NULL,              -- pendiente|imprimiendo|impreso|fallido|revision_manual
  intentos smallint NOT NULL DEFAULT 0, ultimo_error text,
  es_reimpresion boolean NOT NULL DEFAULT false, motivo_reimpresion text,
  boleto_id uuid,
  creado_en timestamptz NOT NULL, impreso_en timestamptz
)

core.config_impresora (
  id uuid PK, sucursal_id uuid FK,
  nombre text,                       -- req: "nombres de las impresoras"
  -- D-4: abstracción de transporte
  transporte text NOT NULL DEFAULT 'tcp' CHECK (transporte IN ('tcp','usb')),
  ip inet, puerto integer DEFAULT 9100,        -- transporte = 'tcp'
  usb_nombre_cola text,                        -- transporte = 'usb'
  ancho_mm smallint NOT NULL DEFAULT 80,
  ancho_cols smallint NOT NULL DEFAULT 48,
  code_page text NOT NULL DEFAULT 'CP858',
  soporta_qr_nativo boolean NOT NULL DEFAULT true,
  es_predeterminada boolean NOT NULL DEFAULT false,
  CHECK ((transporte='tcp' AND ip IS NOT NULL)
      OR (transporte='usb' AND usb_nombre_cola IS NOT NULL))
)

core.config_ticket (
  id uuid PK, agencia_id uuid FK,
  logo_url text,                     -- Supabase Storage, cacheado local
  telefono_atencion text,
  leyenda_pie text,                  -- "buen viaje, estamos para servirle"
  credenciales_proveedor text,
  effective_from timestamptz NOT NULL
)

core.parametro (clave text PK, valor jsonb NOT NULL, effective_from timestamptz NOT NULL)
```

**Todos los supuestos numéricos del blueprint viven en `core.parametro`**, no en constantes
de código: `horizonte_materializacion_dias` (90), `minutos_cierre_venta` (15),
`horas_expiracion_cupo` (4), `minutos_lease` (15), `minutos_zona_muerta` (15),
`umbral_sync_degradado_horas` (72), `ventana_config_hora` (03:00),
`deriva_reloj_alerta_min` (2), `deriva_reloj_degradado_min` (5). Cambiar un supuesto tras
validarlo con el cliente debe ser una fila, no un despliegue.

---

## 7. Índices críticos (transaccional)

```sql
-- Búsqueda de folio: se dicta por teléfono y se teclea en la terminal destino
CREATE INDEX ON core.boleto (folio);
CREATE INDEX ON core.boleto (salida_id) WHERE activo;
CREATE INDEX ON core.venta (salida_id) WHERE activo;
CREATE INDEX ON core.movimiento_caja (corte_caja_id) WHERE activo;
CREATE INDEX ON core.pago (venta_id) WHERE activo;
CREATE INDEX ON core.pago (sucursal_cobro_id, pagado_en);     -- reportes en nube
CREATE INDEX ON core.print_job (estado) WHERE estado IN ('pendiente','imprimiendo');
CREATE INDEX ON core.evento_abordaje (salida_id);
```
