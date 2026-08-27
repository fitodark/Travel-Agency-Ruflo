# Historial de trabajo — Donaji

Registro por sesión de lo construido, las decisiones tomadas y el estado en que
quedó el proyecto. Complementa —no sustituye— a
[`architecture/CHANGELOG.md`](architecture/CHANGELOG.md), que documenta la
evolución del *blueprint* (v0.1 → v0.2), y a las notas de memoria del asistente.

Base de reconstrucción: el *changelog* del blueprint, el ledger de migraciones
(`public.schema_migration`), los archivos de prueba y las notas de estado de F0 y
F1. El repositorio todavía no tiene commits, así que las fechas de las sesiones
tempranas son las que registran esas fuentes, no `git log`.

---

## Sesión 1 — 2026-08-26 · Cierre de diseño (blueprint v0.2)

**Objetivo**: responder las preguntas técnicas bloqueantes y pasar el diseño de
"borrador con supuestos" a "diseño en firme".

- **D-1 · Una sola PC por sucursal** (P1). Nodo y caja son la misma máquina. La
  sincronización intra-sucursal desaparece; el problema de conflictos queda
  **solo** en el plano inter-sucursal. Esa PC es SPOF total de la sucursal.
- **D-2 · Respaldo local pasa a crítico y se adelanta de F5 a F0.** Con una sola
  PC, el `pg_dump` a medio externo es la única defensa real (R2).
- **D-3 · UPS deja de ser recomendación y pasa a requisito de instalación.**
- **D-4 · Transporte de impresión abstracto (TCP | USB) desde F0.** Impresora
  objetivo: Enduro 80 mm (USB + Ethernet). 48 columnas, fuente A.
- **D-5 · El instalador configura el SO**: servicio con arranque automático,
  **NTP activo** (pieza de la garantía anti-sobreventa, no cosmético), plan de
  energía sin suspensión, Windows Update diferido.
- **D-6 · Mapa real de asientos: 18 plazas, no 19** (`knowledge/esquema.JPG`).
  Configuración 1+2. Los cupos se reparten en **bloques contiguos completos**,
  nunca asientos sueltos.
- **D-7 · Cadena conductor → unidad → tipo_unidad → esquema.** El mapa de una
  `salida` se **congela por snapshot** al materializarla: un cambio de conductor
  (evento cotidiano) no puede invalidar asientos ya vendidos.
- **D-8 · Convivencia de esquemas N y N−1 medida en días.** Un humano actualiza 4
  terminales por TeamViewer en la madrugada; una puede saltarse la noche.
  Expand/contract endurecido: solo columnas *nullable*, *contract* una release
  después. Dos canales separados: datos (automático, continuo) y binarios
  (manual, por release).
- **Stack cerrado**: TypeScript end-to-end (Node 22 + Fastify + React). Revertible
  hasta F1, no después.
- **Supabase**: cuenta del proveedor, plan Pro pagado por el cliente. Desbloquea
  `btree_gist` → la garantía dura anti-sobreventa (`EXCLUDE USING gist`) es
  viable.

**Estado al cerrar**: diseño en firme; arranca F0 con migraciones versionadas.

---

## Sesión 2 — 2026-08-26 / madrugada del 27 · Fase F0 (descubrimiento y respaldo)

**Objetivo**: PoCs de los tres frentes de riesgo técnico y respaldo local, todo
verificado ejecutándolo.

- **Esquema aplicado** en local y en Supabase: migraciones `0001`–`0011`.
  - `0001`–`0007` — núcleo (`core`): organización, flota, rutas/salidas,
    ventas/asientos, caja/folios, eventos/config. Columnas estándar de auditoría
    y sync por trigger. HLC (`sync.hlc_estado`), identidad de nodo (`sync.nodo`).
  - `0008` — infraestructura de sync: cursor, idempotencia de lotes, `cambio_log`,
    cola de excepciones, `checksum_bloque`, tabla `sync.salud`.
  - `0009` — vistas de auth local.
  - `0010` — ingesta idempotente de lotes (`sync.ingest_batch` / `ingest_fila`).
  - `0011` — vistas `core.v_config_*_vigente`: nadie lee las tablas base de
    configuración directamente.
- **Capa ESC/POS** con los tres transportes: TCP 9100, USB por cola RAW de
  Windows, y captura en memoria para pruebas.
- **Impresión por datos, no por código**: `src/printing/config.ts` arma
  transporte y plantilla desde las vistas de config vigente. Cuando llegue la IP
  de la impresora: `INSERT` en `core.config_impresora`, sin desplegar nada. Esa
  tabla es clase A → baja desde la nube: el administrador puede corregir la IP de
  una terminal a seis horas de distancia.
- **Respaldo local** (`src/backup/`): `pg_dump` con verificación de restauración,
  incluida la prueba de que detecta un dump truncado. Clavado a la base local,
  no configurable. `pg-tools.ts` resuelve un binario `pg_dump` de versión ≥ a la
  del servidor (la máquina de dev tiene `pg_dump` 9.5 en el PATH).
- **PoC de sincronización**: 7 escenarios contra el Supabase real + dos terminales
  locales desechables.
- **47 pruebas en verde.**

**Pendiente único de F0**: la impresora **Enduro 80 mm física** no estaba
instalada (infraestructura la tenía en revisión). Faltan dos cosas que no se
resuelven por ficha técnica: soporte de QR nativo `GS ( k` vs. fallback raster
(ambos implementados), y qué página de códigos acepta para acentos (se asume
CP858). El usuario confirmó el 2026-08-27 que sigue sin estar lista.

**Hallazgos de entorno registrados** (ver nota de memoria "Entornos y bases"):
- `DATABASE_URL` cambió de significado al crear el proyecto de Supabase — hoy
  apunta a la nube. Por eso existe `src/db/connection.ts`, que resuelve el destino
  explícitamente.
- Supabase está en plan **Free** en dev: se pausa por inactividad y el límite de
  conexiones es estrecho para 4 nodos. **Subir a Pro antes de instalar una
  terminal real.**
- Local es PostgreSQL 18.4 y la nube 17.6 — riesgo de "funciona en mi máquina".
- TLS a Supabase con `rejectUnauthorized: false` (no se valida la cadena).

---

## Sesión 3 — 2026-08-27 · Fase F1 (motor de sincronización), primera parte

**Objetivo**: construir el ciclo continuo de sync y la reconciliación.

- **`src/sync/engine.ts`** — ciclo continuo: push 5 s, pull 30 s, backoff
  exponencial con techo de 5 min + jitter ±20%, *stale-guard* a 72 h. No usa
  `setInterval` (solaparía corridas); cada ciclo agenda el siguiente. Recuerda su
  última sync exitosa entre reinicios leyendo `sync.salud`.
- **`src/sync/clases.ts`** — clasificación A/B/C/D como dato ejecutable. Distingue
  conflicto esperable (clase D, se arbitra) de síntoma de bug (clase B).
- **`src/sync/reconcile.ts`** — checksum por tabla y día con re-push dirigido del
  bloque divergente.
- **Migraciones `0012`, `0013`, `0014`**:
  - `0012` — clase A que faltaba.
  - `0013` — parámetro de identidad.
  - `0014` — **la corrección más importante de la fase.**
    `core.trg_columnas_estandar` y `sync.trg_outbox` corrían también al aplicar
    filas **replicadas**, no solo en escrituras locales. Encadenaba seis
    defectos: la nube pisaba el `hlc_ts` del origen, con lo que la guarda
    `WHERE EXCLUDED.hlc > almacenado` quedaba inerte y el comportamiento real era
    "gana el último en llegar a la nube" — lo que el blueprint prohíbe. Además el
    nodo reencolaba hacia arriba la configuración recién bajada y el eco se
    realimentaba sin converger. Resuelto con la bandera transaccional
    `donaji.replicando` que los triggers consultan vía `sync.replicando()`
    (elegida sobre `session_replication_role` porque esa exige superusuario y el
    rol de Supabase no lo es).

**Estado al cerrar la sesión**:
- **11 pruebas marcadas `DEFECTO VIGENTE`** en `tests/sync/`: escritas para
  *pasar* documentando el comportamiento roto, con nota de cómo invertirlas al
  corregir el motor. Como la `0014` corrigió esos defectos, ahora **fallan** — y
  que fallen es la señal de éxito.
- **Dos regresiones sin diagnosticar** (criterios de aceptación de F1 que pasaban
  antes de la `0014`): criterio 1 (500 escrituras con 72 h de red caída deben
  llegar al 100%; se rechazaban ~5) y criterio 5 (nodo N−1 contra nube N).
- Falta `src/sync/salud.ts` — 41 pruebas en `todo` lo esperan.

---

## Sesión 4 — 2026-08-27 · Cierre de F1: regresiones, inversiones y `salud.ts`

**Objetivo**: dejar la suite `tests/sync/` en verde y construir el tablero de
salud.

### Criterio 1 — resuelto (no era la guarda de HLC)

`push.ts` y `pull.ts` hacían `SELECT seq::text … ORDER BY seq`. El `::text` crea
una columna de salida llamada `seq` y `ORDER BY` se enlaza al **alias**, no a la
columna: el lote se ordenaba **lexicográficamente** (`"10" < "2"`). Con 1000
filas y `LIMIT 500` eso partía el lote entre una venta y su boleto → la nube
rechazaba el boleto por clave foránea (se auto-reparaba al reintentar, pero
`rechazadas` ya no era 0). `EXPLAIN` mostraba `Sort Key: ((outbox.seq)::text)`.
La `0014` no introdujo el bug: quitó el eco de configuración que desplazaba los
`seq` y lo tapaba. **Fix**: quitar `::text` de ambos `SELECT`.

### Criterio 5 — era la prueba obsoleta, no una regresión

La sub-prueba reingería una fila de `core.sucursal` que el nodo ya tenía con HLC
idéntico → `ignorada_hlc`, que es correcto. La aserción `.toBe('aceptada')` se
escribió cuando la guarda era inerte. Reescrita para subir `hlc_cnt`+1 y afirmar
que el apply real ocurre y que la columna desconocida se filtra en silencio.

### Las 11 pruebas `DEFECTO VIGENTE` — invertidas

- **caos-perdida** (9): el HLC del origen se conserva; la guarda bloquea un
  payload viejo; un ACK perdido no rompe el checksum; el cursor de pull se
  **detiene** en una fila rechazada (no la pierde), abre `sync.excepcion` y
  retoma cuando el bloqueo se resuelve; una transacción en otra base **no**
  detiene el pull (filtro acotado a `current_database()`); el nodo no reencola lo
  que baja; el eco no se realimenta (versión estable); la config bajada no queda
  marcada como propiedad del nodo.
- **caos-reintentos** (1): un reenvío tardío del corte abierto se ignora por HLC,
  sin conflicto ni excepción.
- **f1-criterios 3b** (1): el "día operativo" del checksum se fija en UTC en los
  dos lados.

**Patrón detectado**: toda prueba que publique un cambio de configuración a mano
en `sync.cambio_log` debe subir el `hlc_ts`/`hlc_cnt` del payload (o hacer un
`UPDATE` real sobre `core.*`, que dispara el trigger). Antes daba igual porque la
guarda era inerte. Con eso se arregló también `NO se salta filas de transacciones
todavía abiertas` (que no era `DEFECTO VIGENTE`).

### `src/sync/salud.ts` — construido

Tablero de diagnóstico remoto de R2:
- `medirSalud(node, opts?)` — foto local completa **sin tocar la nube**: outbox
  pendiente vs. atascado (rechazado o ≥5 intentos), antigüedad de lo más viejo
  sin subir, versión de esquema/binario, excepciones abiertas por severidad,
  último respaldo, último checksum, `degradado` a las 72 h (con `ahora()`
  inyectable).
- `clasificarDeriva(seg)` — puro. Umbrales 01b §4: ≤2 min `ok`, ≤5 `alerta`,
  ≤15 `degradado`, `>15` `fuera_de_zona_muerta`.
- `medirDeriva(node, cloud)` — reloj de pared nodo vs. nube, descontando media
  latencia RTT.
- `registrarDeriva(node, seg)` — persiste la medición y, fuera de zona muerta,
  abre una excepción `deriva_reloj` deduplicada.
- `reportarSalud(node, cloud)` — sube a `sync.salud` de la nube; **sobrevive a
  que la nube esté caída** sin perder la medición local.
- `registrarRespaldo(node, {...})` — lo llama `src/backup/run.ts` tras cada
  respaldo.
- **Migración `0015_sync_respaldo.sql`** — tabla `sync.respaldo` (solo-anexar, no
  se replica). Aplicada a local; no hace falta en Supabase.
- Los 10 `it.todo` de `salud.ts` en `motor-pendiente.test.ts` convertidos a
  pruebas reales, todas verdes. Borrado el `namespace ContratoSalud`.

**Estado al cerrar**: `tests/sync/` → 4 archivos, **0 fallos**, ~66 pruebas
verdes, 31 `todo`. `tsc` limpio.

### Limpieza y primer commit

Eliminados ~12 archivos de 0 bytes con nombres basura en la raíz del repositorio,
residuo de redirecciones de shell mal formadas. **Commit inicial del repo**
(`9bc967d` en `main`): F0 + F1, 82 archivos. Sin `.env` / `backups/` /
`node_modules/` (gitignore). Sin trailer `Co-Authored-By` (el proyecto no tiene
`attribution.commit`).

---

## Sesión 5 — 2026-09-01 · Fase F2, slice 1: autenticación offline

**Objetivo**: `src/auth/` — login sin red, sesiones y RBAC. Módulo de dominio
probado contra Postgres real, como F1; sin capa HTTP todavía. Rama
`f2-auth-offline`.

- **Validación previa**: los MCP de ruflo no cargaron esta sesión (handshake
  expiró al arrancar); el servidor en sí está sano. Se procede directo, como F1.
- **Dependencia nueva**: `@node-rs/argon2` (binario `win32-x64-msvc`
  precompilado, sin node-gyp).
- **Migración `0016_auth_sesion_seleccion.sql`**: `auth_local.sesion.sucursal_id`
  pasa a nullable + `CHECK` de coherencia con `sucursal_elegida_en`. El login
  valida credenciales y el usuario elige sucursal en un segundo paso.
- **`src/auth/`**:
  - `passwords.ts` — wrapper Argon2id aislado (única pieza con dependencia
    nativa).
  - `rbac.ts` — `puede()` / `permisosDe()` contra `core.rol_permiso` (dato, no
    `if`).
  - `sesion.ts` — `abrirSesion`, `verificarSesion` (con vigencia del usuario
    como defensa en profundidad), `seleccionarSucursal`, `cerrarSesion`,
    `cerrarSesionesDe`. Token opaco = `auth_local.sesion.id`. TTL 12 h.
  - `login.ts` — orquesta: rate-limit por email → credencial → Argon2id verify →
    vigencia (contra `ahora` inyectable) → sucursal activa → stale-guard §1.5 →
    abrir sesión. Cero llamadas a la nube. `estaDegradado()` lee el umbral de
    `core.parametro`.
- **Pruebas** (`tests/auth/`, 32, todas verdes): los 4 criterios de aceptación
  de F2 (login sin red/nube caída; baja `effective_until` vencida bloquea;
  baja recibida tarde surte efecto al instante; 73 h sin sync → bloqueo de
  primer login, con override del gerente y excepción para usuario activo en 24 h)
  más rate-limit, rutas de rechazo, y el `CHECK` de coherencia de la sesión.
- Aprendizaje: `verbatimModuleSyntax` no deja importar el `const enum`
  `Algorithm` de `@node-rs/argon2` → se usa el valor numérico (2). Y `pg` exige
  castear (`$n::uuid`, `::citext`, `::inet`, `::timestamptz`) los parámetros que
  pueden llegar `null`, o falla con "no se pudo determinar el tipo del parámetro".

---

## Sesión 6 — 2026-09-01 · Fase F2, slice 2: aplicador de configuración

**Objetivo**: `src/config/` — materializar la vigencia de la configuración con el
reloj local del nodo (03 §3). Misma rama `f2-auth-offline`.

- **Principio** (§3.1): la configuración se propaga como un dato con fecha de
  vigencia, no como un comando remoto. Un cambio con `effective_from` viaja como
  cualquier fila y el nodo lo aplica solo con su reloj.
- **`src/config/aplicador.ts`** — `aplicarConfiguracion(node, { ahora })`,
  idempotente, sin transacción propia:
  1. Cierra sesiones de usuarios cuya vigencia terminó (`cerrada_motivo =
     'vigencia_usuario'`) — cubre la baja diferida vencida y la baja recibida
     tarde (`effective_until` ya en el pasado).
  2. Cierra sesiones cuya sucursal elegida dejó de estar asignada o vigente
     (`'vigencia_sucursal'`).
  3. Publica la época de configuración; `epocaCambio` avisa si hay caché que
     invalidar.
  - `ultimaPasadaAplicador(node)` para el tablero de salud.
- **`src/config/epoca.ts`** — `epocaConfig(node)`: token derivado de
  `max(modificado_en)` + `count` sobre las tablas de clase A (lista desde
  `sync/clases.ts`). `modificado_en` viaja intacto desde el origen (0014), así
  que refleja cuándo el administrador tocó la config, no cuándo bajó.
- **Migración `0017_config_aplicado.sql`** — singleton `sync.config_aplicado`
  (`ultima_pasada`, `ultima_epoca`, `sesiones_cerradas_total`). Un aplicador
  detenido es tan grave como un sync detenido.
- **`salud.ts`**: nuevo campo `ultimaPasadaAplicador` (lee `sync.config_aplicado`
  directo, sin dependencia cruzada sync→config).
- **Pruebas** (`tests/config/`, 12, todas verdes): criterios 2 y 3 de F2 desde el
  lado del aplicador (baja normal, baja recibida tarde, usuario desactivado, no
  toca a los vigentes, baja al futuro, idempotencia), sucursal retirada o
  desactivada, sesión sin sucursal, marca de la pasada, y la época.
- Fix del fixture `seedAuth`: el `codigo` de sucursal (char(1)) era fijo `'A'`/
  `'B'` → colisión al sembrar dos usuarios en una prueba; ahora rota sobre un
  alfabeto sin ambiguos.

---

## Sesión 7 — 2026-09-01 · Fase F2, slice 3: capa HTTP (Fastify) y CRUD

**Objetivo**: `src/api/` — el servidor que la SPA consume por `localhost`.
Dependencia nueva: `fastify` v5. Misma rama `f2-auth-offline`.

- **Decisión de alcance**: el blueprint §4.1 es explícito — la API de la
  terminal es "la única autoridad de escritura del dominio" pero **la config
  (sucursales, usuarios, tarifas, impresora, ticket) es clase A**: la nube gana,
  el nodo nunca la escribe. Se edita en el dashboard en nube (F8). Por eso:
  - **`/clientes`** — CRUD completo (clase B, local, sube por outbox).
  - **`/catalogos/*`** — SOLO LECTURA de la config clase A (sucursales,
    usuarios, config-impresora, config-ticket, parámetros), desde las vistas
    `v_*_vigente`.
- **`src/api/`**:
  - `server.ts` — `construirApp({ db, ahora?, logger? })`; `db` entra por
    parámetro (un `Pool` en prod, un `Client` en transacción en pruebas), así
    toda la capa se prueba con `app.inject()` sin puerto ni base dedicada.
  - `errores.ts` — `ErrorHttp` + helpers; el error handler no filtra detalle de
    PG (un SQLSTATE se vuelve 409 genérico).
  - `autenticar.ts` — `exige({ conSucursal?, permiso? })`: preHandler que resuelve
    el `Bearer` contra `auth_local.sesion`, exige sucursal elegida y el permiso
    de `core.rol_permiso`.
  - `rutas/auth.ts` — `POST /auth/login` (429 en rate-limit), `/auth/sucursal`,
    `/auth/logout`, `GET /auth/me` (rol + sucursal + permisos).
  - `rutas/clientes.ts` — GET (búsqueda por nombre y por teléfono normalizado),
    GET/:id, POST (201, pone la sucursal de la sesión), PATCH parcial, DELETE
    (baja lógica, 204).
  - `rutas/catalogos.ts` — los 6 endpoints de lectura.
  - `main.ts` — arranque con `Pool` + `listen` (script `npm run api`). Corre
    como servicio de Windows (§4.2): no atado a una ventana.
- **`src/db/consulta.ts`** — interfaz `Consultable` (`{ query }`) que cumplen
  `Client`, `PoolClient` y `Pool`. `auth/*` pasa de pedir `Client` a pedir
  `Consultable`, y así la API puede pasarles su `Pool` o su `Client` de prueba.
- **Pruebas** (`tests/api/`, 24, todas verdes): `auth` (login ok / 401 / 429 /
  400, elección de sucursal, `me`, logout, 401 sin token), `clientes` (CRUD,
  404, outbox, 409 sin sucursal), `catalogos` (lectura + RBAC 403 vs 200,
  impresora null vs configurada, parámetros).
- Smoke: `npm run api` levanta en `127.0.0.1`, `/salud` y `/auth/login`
  responden.

### Semilla de admin para dev

- **`scripts/sembrar-admin.ts`** (`npm run seed:admin`): crea, si faltan, una
  agencia y una sucursal; el usuario `admin@donaji.local` (rol administrador);
  su `auth_local.credencial` con hash Argon2id (password `donaji-admin` por
  defecto, o `ADMIN_PASSWORD`); el vínculo a todas las sucursales; y fija
  `sync.nodo.sucursal_id`. Idempotente. Acepta `--target nube`.
- Verificado end-to-end: `npm run api` + login como admin → token, `/auth/me`
  con los 21 permisos, `/catalogos/*` responden.
- **Fix del fixture `seedAuth`**: rotar el `codigo` de sucursal (char(1) UNIQUE)
  a ciegas chocaba con la sucursal ya sembrada en dev. Ahora pide a la base los
  códigos LIBRES (`unnest` del alfabeto `EXCEPT` los usados). Robusto contra
  cualquier dato ya commiteado.

**F2 queda cerrada** salvo el dashboard en nube (F8), que es quien da de alta y
baja la configuración de clase A.

### Merge

F2 mergeada a `main` el 2026-09-01 (PR #1, merge commit `51edd1c`); rama
`f2-auth-offline` eliminada.

---

## Sesión 8 — 2026-09-01 · Fase F3, slice 1: materialización de salidas

**Objetivo**: `core.materializar_salidas` — convertir cada horario vigente en las
salidas concretas del horizonte, con el mapa congelado. Rama `f3-flota`.

- **Contexto**: todo el esquema de flota/rutas/salidas ya existe (migraciones
  0003–0004). F3 es lógica, no tablas.
- **Migración `0018`**: `core.materializar_salidas(horario_id, dias?, desde?)` —
  job nocturno de la NUBE. Por cada día operativo del horizonte (según
  `dias_semana` ISO, dentro de `vigente_desde/hasta`): crea `core.salida` con
  `mapa_snapshot` **congelado** (copia de `conductor → tipo_unidad → mapa`, D-7) y
  `conductor_nombre_snapshot`, y `core.salida_parada` (hora de paso en la zona
  horaria de cada sucursal; cierre de venta a `minutos_cierre_venta` antes).
  Idempotente por `UNIQUE (horario_id, fecha_operacion)`.
- **`src/fleet/materializar.ts`**: `materializarHorario` y `materializarVigentes`
  (procesa los `v_horario_vigente` con conductor, salta los sin). +
  `scripts/materializar.ts` (`npm run materializar`, default `--target nube`).
- **Pruebas** (`tests/fleet/`, 10, verdes): criterio 1 de F3 (salidas del
  horizonte con mapa y paradas), idempotencia, filtro `dias_semana`, ventana
  `vigente_desde/hasta`, zona horaria, horizonte por parámetro (91 días), y los
  rechazos (sin conductor, horario de baja, inexistente).
- **Fix `src/db/schema.ts`**: el checksum de migraciones hasheaba el SQL crudo;
  `core.autocrlf` de Git en Windows convierte CRLF al hacer checkout tras un
  commit y disparaba el guard de "migración modificada". Ahora normaliza a LF
  antes de hashear.

---

## Sesión 9 — 2026-09-01 · Fase F3, slice 2: reparto de cupo offline

**Objetivo**: `core.repartir_cupo_offline` — repartir los asientos de cada salida
en conjuntos disjuntos por bloques contiguos, para que la sobreventa offline sea
imposible por construcción (01b §3). Rama `f3-flota`.

- **Migración `0019`**: `core.repartir_cupo_offline(salida_id)`. Reparto v1
  determinista (§3.3): cada parada intermedia recibe UNA fila completa (bloque de
  3 asientos); el origen se queda con el resto, incluida la banca trasera de 4
  (B5, el único bloque para un grupo familiar). `tramos = int4range(orden, n-1)`.
  `vigente_hasta`: para las intermedias, su paso menos `horas_expiracion_cupo`
  (SUPUESTO S5, T-4h); para el origen, su propio `cierre_venta_en`. Idempotente
  (DELETE + INSERT). Rechaza cuando hay más paradas vendedoras que bloques
  (límite documentado en 01b §3.5). `materializar_salidas` (`CREATE OR REPLACE`)
  ahora llama al reparto por cada salida nueva (§6.1 paso 3).
- **`src/fleet/cupo.ts`**: `repartirCupo(db, salidaId)` (recalcula, para el
  cambio de conductor) y `cupoDeSalida(db, salidaId)` (lo inspecciona).
- **Pruebas** (`tests/fleet/cupo.test.ts`, 8, verdes): la ruta S1→S2→S3→S4
  reparte exactamente como el blueprint (B0,B1,B2,B5 → origen; B3 → S2; B4 → S3;
  asientos 12/3/3, tramos `[0,3)`/`[1,3)`/`[2,3)`); disjuntos que suman 18; una
  fila por intermedia; ruta sin intermedias deja los 6 bloques en el origen;
  expiración T-4h vs. cierre de venta; idempotencia; el rechazo por exceso de
  paradas; y que la materialización ya deja el cupo repartido.

---

## Sesión 10 — 2026-09-01 · Fase F3, slice 3: cambio de conductor

**Objetivo**: `core.cambiar_conductor` — los cuatro casos de la regla de
compatibilidad de mapa (02 §5.3). Cierra F3. Rama `f3-flota`.

- **Migración `0020`**: `core.cambiar_conductor(salida_id, conductor_nuevo,
  usuario_id, con_conexion?, motivo?)`. El invariante NO es "mismo tipo de
  unidad" sino `asientos_vendidos(salida) ⊆ asientos_vendibles(mapa_nuevo)` **y**
  `bloques_repartidos(salida) ⊆ bloques(mapa_nuevo)`.
  - **Caso 1 — compatible**: libre (permiso `conductor.cambiar.compatible`).
    Solo cambia `conductor_id` y `conductor_nombre_snapshot`; NO toca el mapa ni
    los cupos.
  - **Caso 2 — incompatible**: bloqueado para `vendedor` (exige
    `conductor.cambiar.incompatible`, es decir gerente/admin). **Sin conexión**
    queda `cambio_conductor` `pendiente` sin tocar la salida. **Con conexión** se
    fuerza: recalcula `mapa_snapshot` y cupos, marca los boletos huérfanos
    `conflicto_sobreventa` y su ocupación `conflicto`, y abre `sync.excepcion`
    `mapa_incompatible`/`critica` por sucursal emisora. La propuesta de asiento
    nuevo es F4 (01b §7).
  - **Caso 3 — sin boletos**: cambio libre; re-materializa `mapa_snapshot` y cupo.
  - **Caso 4 — `en_ruta`/`finalizada`**: lanza; el conductor queda como dato
    histórico.
  Toda operación deja fila en `core.cambio_conductor` (clase C, append-only).
- **`src/fleet/conductor.ts`**: `cambiarConductor(db, {...})`.
- **Pruebas** (`tests/fleet/conductor.test.ts`, 8, verdes): los 4 casos, el
  bloqueo a vendedor, `pendiente` sin conexión, huérfano vs. boleto que sí cabe,
  excepción crítica, y la fila de auditoría.
- Nota de proceso: al editar `0020` tras aplicarla hubo que resetear su fila en
  `public.schema_migration` y `DROP FUNCTION` para re-aplicar (la migración no
  estaba commiteada ni compartida).

**F3 queda cerrada**: los 3 slices, los 4 criterios de aceptación.

---

## Pendientes de F1

- `src/sync/engine.ts` funciona pero no cumple el `ContratoEngine` propuesto en
  `motor-pendiente.test.ts` (es la clase `SyncEngine`, no `crearMotor`).
- `src/sync/reconcile.ts` no expone el arbitraje determinista como función pura.
- Quedan 31 `it.todo` (engine 12 + reconcile 19).

## Defectos conocidos aún vivos (con su prueba `DEFECTO VIGENTE` en verde)

- `sync.hlc_observar` existe pero no la llama nadie: el reloj local no salta al
  máximo observado en un pull.
- `sync.hlc_estado` es fila única que serializa toda escritura de la base.
- Una excursión del reloj deja el HLC adelantado para siempre (sin tope de
  deriva).
- `core.folio_secuencia` no se replica: una terminal reinstalada reinicia folios.
- El seed de `tipo_unidad` no fija `id`: un nodo sembrado no puede hacer bootstrap.
- Las FK de `core` no son `DEFERRABLE`: el `SET CONSTRAINTS ALL DEFERRED` del
  bootstrap no difiere nada.

## Decisiones abiertas para el arquitecto

- Replicación de `core.asiento_ocupacion` hacia las sucursales (decidir antes de
  F4).
- P7 (mecanismo de acceso del sistema externo de reportes), P8 (umbrales de
  sync), P12 (zona horaria de las 4 sucursales).
- Fijar en el blueprint la región real de Supabase: `us-west-2`, no East US.

## Deuda técnica registrada

- Los archivos de `tests/sync/` miden 600–970 líneas, contra el límite de 500 de
  `CLAUDE.md`. Hay que partirlos.
