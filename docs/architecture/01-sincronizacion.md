# 01 — Motor de Sincronización

> Blueprint v0.2. El requerimiento declara la sincronización "pieza no negociable".
> El caso de asientos compartidos —el problema central— está en
> [01b-consistencia-asientos.md](01b-consistencia-asientos.md).

---

## 1. Principio rector

> **La sincronización no resuelve conflictos: los elimina por construcción.**

En vez de sincronizar todo bidireccionalmente y luego arbitrar, cada entidad se clasifica
en una de cuatro clases de propiedad, y **tres de las cuatro no pueden generar conflicto
jamás**. Solo una clase — la capacidad de asientos — es un recurso genuinamente compartido.

| Clase | Dirección | Escritores | ¿Conflicto? | Entidades |
|---|---|---|---|---|
| **A — Configuración** | nube → sucursal | solo la nube (administrador) | **No** | sucursal, usuario, rol, permiso, conductor, unidad, tipo_unidad, ruta, horario, tarifa, config_impresora, config_ticket, parametro |
| **B — Transaccional local** | sucursal → nube | solo la sucursal creadora | **No** (single-writer) | corte_caja, movimiento_caja, venta, boleto, cliente, print_job |
| **C — Hechos append-only** | cualquier sucursal → nube → todas | cualquiera, solo INSERT | **No** (unión conmutativa) | pago, evento_abordaje, evento_salida, nota_auditoria, evento_custodia (Etapa 2) |
| **D — Capacidad compartida** | bidireccional arbitrada | múltiples | **Sí** — el único caso | asiento_ocupacion, cupo_offline, asiento_lease |

El diseño de A, B y C es lo que hace tratable a D: al reducir el problema a **una sola
tabla**, se puede permitir el aparato pesado (particionamiento, leases, constraints de
exclusión, cola de excepciones) que sería insostenible aplicado a 30 tablas.

**Nota v0.2 (D-1)**: con una sola PC por sucursal, la consistencia *intra*-sucursal es una
transacción de PostgreSQL en `localhost`. Todo lo que sigue trata exclusivamente del plano
**inter**-sucursal, que es donde el problema siempre estuvo.

### 1.1 La regla que hace posible la clase C

> **Ningún estado que cruce fronteras de sucursal se guarda como campo mutable.
> Se deriva de hechos append-only.**

- `venta.esta_liquidada` **no existe** como columna editable. Es
  `SUM(pago.monto) >= venta.importe_total`, donde `pago` es append-only y cada pago es
  propiedad de la sucursal que cobró. Esto resuelve directamente el requisito de "la
  reservación puede pagarse en la terminal destino" **sin dos escritores sobre la misma
  fila**.
- `boleto.abordo` **no existe**. Es `EXISTS(evento_abordaje ... AND NOT anulado)`.
- Una anulación es otro hecho (`nota_auditoria` con `anula_evento_id`), no un `UPDATE`.

En la práctica es un OR-Set: la unión de hechos de todas las réplicas es conmutativa,
asociativa e idempotente. Converge sin arbitraje.

---

## 2. Identidad, relojes y versionado

### 2.1 Identificadores

- **PK de toda entidad: `uuid` v7**, generado en el nodo. Ordenable por tiempo (locality en
  índices B-tree) y sin coordinación, así que funciona offline.
- **Prohibido**: `serial`, `bigserial`, `identity` como PK de dominio. Cualquier PK
  secuencial obliga a coordinar con la nube y rompe D1. (Sí se usan para secuencias
  internas de `sync`, que nunca salen del nodo.)
- **Clave visible al usuario**: `folio` de 6 caracteres particionado por sucursal, ver
  [02b §1](02b-modelo-transaccional.md). El folio **no** es PK ni FK.

### 2.2 Reloj híbrido (HLC)

El reloj de pared de una PC de mostrador no es confiable. Cada fila lleva:

```sql
hlc_ts           timestamptz NOT NULL,  -- componente físico
hlc_cnt          integer     NOT NULL,  -- contador lógico de desempate
sync_sucursal_id uuid                   -- sucursal que originó la escritura
```

Regla HLC estándar: al escribir, `hlc_ts = max(now(), piso_observado)`; al recibir un lote
remoto se avanza el piso al máximo observado. Da un **orden total determinista**
`(hlc_ts, hlc_cnt, sync_sucursal_id)` que todas las réplicas calculan igual, sin depender de
que los relojes coincidan.

Implementación (migración 0041, tras cerrar los defectos D1/D2/D3 de F1):

- `sync.hlc_estado.ultimo_ts` es el **piso observado** — el máximo `hlc_ts` que el nodo ha
  visto de cualquier origen. Ninguna escritura normal lo modifica: `sync.hlc_siguiente()`
  solo lo **lee** (sin lock — antes el `UPDATE` de esa fila única serializaba toda escritura
  de la base).
- `hlc_cnt` sale de la secuencia `sync.hlc_seq` (`nextval` no toma lock). Deja de ser
  "eventos desde que avanzó el ts" y pasa a ser un contador global monótono; el orden total
  no cambia porque los tres campos viajan intactos en la replicación y `sync_sucursal_id`
  es el desempate final.
- **Deriva acotada** (`hlc_deriva_max_seg`, 300 s por defecto): `hlc_siguiente()` nunca
  sella más de ese margen por delante del piso ni del reloj de pared, y `hlc_observar()` no
  deja que un lote remoto empuje el piso más allá de `clock_timestamp() + ese margen`. Una
  excursión del reloj (BIOS corrida, toque manual) queda topada en vez de dispararse para
  siempre; cuando NTP corrige, el sello vuelve solo a la hora real. Cuando el clamp actúa se
  abre una excepción `deriva_reloj` visible en el tablero.
- `hlc_observar()` se cablea en `sync.ingest_fila`, el único camino de escritura replicada
  en los dos lados (pull del nodo, push a la nube).

El HLC se usa para **orden**, no para permisos ni expiraciones. Las expiraciones de cupo sí
usan reloj de pared con NTP (requisito de instalación desde D-5) y un margen de seguridad.

### 2.3 Columnas obligatorias en toda tabla del dominio

```sql
id                 uuid PRIMARY KEY,           -- uuidv7
activo             boolean NOT NULL DEFAULT true,  -- borrado lógico (D3)
creado_en          timestamptz NOT NULL,
creado_por         uuid,
modificado_en      timestamptz NOT NULL,
modificado_por     uuid,
desactivado_en     timestamptz,
desactivado_por    uuid,
desactivado_motivo text,
sync_sucursal_id   uuid,                       -- dueño del registro (ver nota abajo)
hlc_ts             timestamptz NOT NULL,
hlc_cnt            integer NOT NULL,
version            integer NOT NULL DEFAULT 1
```

**No hay tabla de tombstones.** El requerimiento ya exige borrado lógico universal por
auditoría (D3), así que un borrado es un `UPDATE` normal que se replica como cualquier otro
cambio. Un requisito de negocio elimina una pieza de infraestructura completa.

**Sobre el nombre `sync_sucursal_id`** (y no `sucursal_origen_id`, como decía la v0.1): las
columnas estándar se inyectan con `ADD COLUMN IF NOT EXISTS` sobre toda tabla del dominio, y
`core.ruta` ya tiene una columna de negocio llamada `sucursal_origen_id` — la terminal donde
arranca la ruta. Con el nombre anterior, el `ADD COLUMN` se saltaba en silencio y el trigger
de auditoría **sobrescribía el origen real de la ruta** con la sucursal del nodo. Detectado
al aplicar las migraciones contra PostgreSQL. Toda columna de infraestructura lleva prefijo
`sync_`/`hlc_` precisamente para que no pueda colisionar con el vocabulario del dominio.

---

## 3. Transporte: outbox / inbox

### 3.1 Push (sucursal → nube)

```sql
CREATE TABLE sync.outbox (
  seq          bigserial PRIMARY KEY,   -- monotónico LOCAL (aquí sí es correcto)
  tabla        text NOT NULL,
  fila_id      uuid NOT NULL,
  payload      jsonb NOT NULL,          -- post-imagen completa
  hlc_ts       timestamptz NOT NULL,
  hlc_cnt      integer NOT NULL,
  lote_id      uuid,
  estado       text NOT NULL DEFAULT 'pendiente',
               -- pendiente | enviado | confirmado | rechazado
  intentos     integer NOT NULL DEFAULT 0,
  ultimo_error text,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
```

Algoritmo:

1. Tomar hasta N filas `pendiente` **en orden de `seq`** — preserva causalidad
   intra-sucursal (el corte de caja se envía antes que sus movimientos).
2. Agrupar en un lote con `lote_id` (uuidv7) e invocar `api.ingest_batch(lote)`.
3. La RPC en la nube:
   - Es **idempotente por `lote_id`** (`sync.lote_recibido`): si ya se procesó, devuelve el
     mismo ACK sin reprocesar.
   - Aplica cada fila con `INSERT ... ON CONFLICT (id) DO UPDATE` **solo si el HLC entrante
     es mayor** que el almacenado, lo que protege contra reenvíos de versiones viejas.
   - Devuelve por fila: `aceptada` | `rechazada(motivo)` | `conflicto(detalle)`.
4. El nodo marca `confirmado` **solo tras el ACK**. Si el ACK se pierde, se reenvía y la
   idempotencia lo absorbe. **At-least-once + idempotente = efectivamente-una-vez.**
5. Las filas `rechazada` van a la cola de excepciones (§6); no se pierden ni se reintentan
   ciegamente.

### 3.2 Pull (nube → sucursal)

La nube mantiene una **secuencia global** `sync.cambio_log(seq bigserial)` poblada por
trigger. El nodo lleva un cursor por tabla en `sync.cursor`.

Pull incremental por `seq > cursor`, **no por `modificado_en`**. Razón: filas escritas
dentro de una transacción larga pueden hacerse visibles fuera de orden de timestamp, y un
cursor por tiempo las perdería en silencio. Se descartan además las transacciones aún
abiertas con `pg_snapshot_xmin(pg_current_snapshot())`.

### 3.3 Cadencia

| Condición | Push | Pull |
|---|---|---|
| Online, operación normal | cada 5 s, e inmediato tras una venta | cada 30 s |
| Ventana de madrugada | continuo | continuo (aplicación de configuración) |
| Offline | acumula en outbox | — |
| Reconexión tras corte largo | drenaje con backoff, lotes de 500 | catch-up antes de vender asientos fuera de cupo |
| >72 h sin sync | igual + modo degradado (`03 §1.5`) | — |

A 360 boletos/día (D-1), una semana entera sin conexión son ~10 000 filas de outbox:
trivial para PostgreSQL y para un lote de 500.

---

## 4. Resolución de conflictos por entidad

| Entidad | Estrategia | Justificación |
|---|---|---|
| Clase A (config) | **La nube gana siempre.** El nodo nunca escribe estas tablas. | Un solo escritor por definición. |
| Clase B (transaccional) | **El origen gana siempre.** La nube nunca modifica una fila cuyo `sync_sucursal_id` no sea suyo. | Single-writer. Un conflicto aquí es un bug y se alerta como tal. |
| Clase C (hechos) | **Unión.** Deduplicación por `id`. | Conmutativa. |
| `cliente` | Single-writer + deduplicación **sugerida, no automática**, por teléfono normalizado. | Dos sucursales pueden registrar al mismo cliente. Fusionar automáticamente es peor que duplicar: se genera un reporte de posibles duplicados para el administrador. |
| `corte_caja` | Single-writer + índice parcial único `WHERE estado='abierto'`. | El requerimiento exige "solo puede existir uno activo": se garantiza con constraint, no con lógica. |
| Clase D (asientos) | [01b-consistencia-asientos.md](01b-consistencia-asientos.md) | Único recurso genuinamente compartido. |

---

## 5. Orden de convergencia (bootstrap y catch-up)

Las tablas tienen dependencias por clave foránea. El pull inicial y el catch-up largo se
aplican en orden topológico, y dentro de cada lote las FK se difieren
(`SET CONSTRAINTS ALL DEFERRED`) para tolerar orden parcial:

```
Nivel 0  agencia, parametro, tipo_unidad
Nivel 1  sucursal, rol, permiso, rol_permiso
Nivel 2  usuario, usuario_sucursal, unidad, config_impresora, config_ticket
Nivel 3  conductor            (depende de unidad / tipo_unidad — ver D-7)
Nivel 4  ruta, ruta_parada, horario, horario_parada, tarifa
Nivel 5  salida, salida_parada, cupo_offline
Nivel 6  cliente
Nivel 7  corte_caja
Nivel 8  venta, boleto, asiento_ocupacion, movimiento_caja
Nivel 9  pago, evento_abordaje, evento_salida, nota_auditoria
```

Una sucursal no puede vender hasta haber convergido al menos hasta el nivel 5 en el
bootstrap inicial. Después opera aunque el pull se atrase.

---

## 6. Cola de excepciones y salud del sync

```sql
CREATE TABLE sync.excepcion (
  id           uuid PRIMARY KEY,
  tipo         text NOT NULL,  -- sobreventa | rechazo_ingesta | fk_faltante |
                               -- deriva_reloj | folio_duplicado | impresion_fallida |
                               -- divergencia_checksum | mapa_incompatible
  severidad    text NOT NULL,  -- critica | alta | media | baja
  sucursal_id  uuid NOT NULL,
  entidad      text, entidad_id uuid,
  detalle      jsonb NOT NULL,
  estado       text NOT NULL DEFAULT 'abierta',
  resuelto_por uuid, resuelto_en timestamptz, resolucion text,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
```

Se replica a la nube y se muestra en dos lugares: un badge no ocultable en la caja de la
sucursal afectada y el tablero del administrador.

**Tablero de salud de sync** por sucursal: última sincronización exitosa, tamaño del outbox
pendiente, deriva de reloj, **versión de esquema y de binario del nodo** (crítico bajo D-8,
donde conviven versiones distintas), excepciones abiertas por severidad, resultado del
último checksum y **antigüedad del último respaldo local**. Es la herramienta de
diagnóstico remoto para sucursales a 3–6 h de distancia.

### 6.1 Reconciliación por checksum

Job diario: cada nodo calcula, por tabla y por día operativo,
`md5(string_agg(id || version, '' ORDER BY id))` sobre las filas de las que es dueño y lo
envía. La nube compara con su propio cálculo. Cualquier divergencia genera excepción
`divergencia_checksum` con el bloque exacto y dispara un re-push dirigido.

Esto detecta **pérdida silenciosa de datos**, que es el modo de falla más peligroso de un
sistema de sync: nadie lo nota hasta el cierre de mes, y para entonces la evidencia física
(los tickets) ya no existe.

---

## 7. Compatibilidad entre versiones de esquema (D-8)

Un humano actualiza las 4 terminales a mano por TeamViewer, en ventanas de madrugada, y una
sucursal puede estar apagada por día no laboral y saltarse el turno. Consecuencia:
**nodos en versión N y N−1 conviven contra la misma nube durante días, no horas.**

Reglas de migración, sin excepciones:

| Regla | Detalle |
|---|---|
| Solo aditivo en la release que expande | Columnas nuevas **siempre nullable** o con `DEFAULT`. Tablas nuevas, índices nuevos, vistas nuevas. |
| **Nunca** renombrar ni borrar en la misma release | Un `DROP COLUMN` o un `RENAME` rompe al nodo N−1 en producción. |
| La fase *contract* va **una release después** | R1 agrega `col_nueva` y escribe en ambas; R2 (solo cuando **todas** las terminales confirmaron R1) deja de escribir la vieja; R3 la borra. |
| La nube se despliega primero, los nodos después | La nube debe entender N y N−1 simultáneamente. |
| `ingest_batch` tolera campos desconocidos | Un nodo N−1 que manda menos campos no falla; un nodo N que manda campos que la nube ya conoce tampoco. |
| El nodo declara su versión en cada lote | La nube registra `version_nodo` y el tablero muestra qué terminal quedó atrás. |
| Sin migraciones destructivas de datos | Cualquier backfill se ejecuta en la nube, es idempotente y reejecutable. |

**Criterio operativo**: una terminal puede quedarse en N−1 durante **al menos 14 días** sin
degradación funcional. Si una migración no puede cumplirlo, se parte en dos releases.

---

## 8. Qué debe probar el equipo antes de dar esto por bueno

| Escenario | Resultado esperado |
|---|---|
| Cortar red 72 h en una sucursal, 500 ventas | 100% de ventas presentes en nube tras reconectar; checksum idéntico |
| ACK perdido tras un ingest exitoso | Reenvío del lote no duplica nada |
| Restaurar un respaldo de 6 h atrás en un nodo | Divergencia detectada por checksum en < 24 h y re-push dirigido |
| Nodo en versión N−1 operando 14 días contra nube N | Sin errores de ingesta, sin pérdida de campos |
| Apagar la PC a media escritura (simular corte de luz) | PostgreSQL recupera; ninguna venta a medias |
| Los casos de asientos | Ver [01b §7](01b-consistencia-asientos.md) |
