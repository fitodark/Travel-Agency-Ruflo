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

### Merge

F3 mergeada a `main` el 2026-09-01 (PR #2, merge commit `d664e3e`); rama
`f3-flota` eliminada.

---

## Sesión 11 — 2026-09-01 · Fase F4, backend completo (5 slices)

Se decidió NO saltar a F6: F4 es ~80 % backend (máquina de estados, búsqueda,
leases, arbitraje, reasignación) y nada de eso depende del prototipo del mapa de
asientos, que es lo único pendiente de aprobación del cliente. Se hizo todo el
backend en una rama, `f4-venta-backend`.

### Slice 1 — búsqueda y disponibilidad por tramo (pasos 1–2)

- **Migración `0021`**: `core.asientos_libres(salida, desde, hasta, ahora)` —
  vendibles sin ocupación firme ni lease vivo que solape el tramo.
  `core.asientos_ofrecibles(...)` — regla de oro offline (01b §3.4): con conexión
  cualquier libre; sin conexión solo el cupo propio y solo mientras esté vigente
  descontando la zona muerta. `core.buscar_salidas(...)` — paso 2: salidas del
  día origen→destino con disponibilidad por tramo, tarifa vigente y
  `seleccionable` (programada + venta abierta + caben N).
- **`src/ventas/busqueda.ts`**: `buscarSalidas(db, opts)`.
- **Pruebas** (`tests/ventas/busqueda.test.ts`, 12): oferta completa con
  conexión, venta que solapa deja de ofrecerse, tramo disjunto no colisiona,
  lease vivo bloquea, offline solo cupo propio (12/3/0), horario lleno visible
  pero no seleccionable, `en_ruta` no aparece, cierre pasado, tarifa vs. `null`.

### Slice 2 — leases en línea (paso 3)

- **Migración `0022`**: `core.adquirir_lease(...)` → `(estado, lease_id,
  expira_en)`. `estado` es DATO, no excepción: `otorgado` / `ocupado` (ocupación
  firme que solapa) / `lease_ajeno` (otro lease vivo). Solo lanza ante lo
  imposible (salida inexistente/no programada, asiento no vendible, tramo
  inválido). Libera de paso los leases vencidos del asiento para que la
  constraint no los arrastre. `liberar_lease` (idempotente),
  `barrer_leases_expirados` (barrido periódico, `liberado_en = expira_en`),
  `consumir_lease` (para `registrar_venta`).
- **`src/ventas/lease.ts`**: `adquirirLease`, `liberarLease`,
  `barrerLeasesExpirados`, `consumirLease`, `leasesVivos`.
- **Pruebas** (`tests/ventas/lease.test.ts`, 13).
- Nota de proceso: al editar `0022` tras aplicarla hubo que resetear su fila en
  `schema_migration` + `DROP FUNCTION` (bug de ambigüedad `expira_en` vs. OUT
  param; se resolvió calculando `v_exp` antes del INSERT y aliando el UPDATE).

### Slice 3 — venta / reservación / pagos (pasos 4–6)

- **Migración `0023`**: `core.registrar_venta(salida, sucursal, usuario, tel,
  origen, destino, pasajeros jsonb, es_reservacion?, cliente?, pago jsonb?,
  con_conexion?, ahora?)` → N boletos con folio (`core.siguiente_folio`), N
  ocupaciones firmes (el `EXCLUDE` revienta la venta entera si choca), pago
  opcional — todo en una transacción. Autorización de asiento: lease vivo propio
  que cubra el tramo · o (offline) asiento del cupo propio vigente · o (online)
  directo. El ticket se encola cuando el saldo llega a 0, sin importar
  `es_reservacion`. `core.registrar_pago` (abono/liquidación, cobro posible en
  otra sucursal — C5), `core.verificar_transferencia` (solo quien vendió),
  `core.snapshot_boleto`, `core.encolar_impresion_venta`, `core.corte_abierto`.
- **Fuera de alcance (F6)**: el `core.movimiento_caja` de ingreso. Se crea el
  `core.pago` con su `corte_caja_id`; el enlace pago→corte lo cablea F6.
- **`src/ventas/venta.ts`**: `registrarVenta`, `registrarPago`,
  `verificarTransferencia`, `saldoDeVenta`.
- **Pruebas** (`tests/ventas/venta.test.ts`, 17).

### Slice 4 — arbitraje determinista (01b §6)

- **`src/sync/arbitraje.ts`** (TypeScript, sin migración): `prioridadDe` (nivel
  1–4, 1 = pagado e impreso = gana), `compararOcupaciones` (orden total:
  prioridad → `emitidoEn` → `sucursalId` → `boletoId` → `id`; nunca 0 para
  distintas, nunca el orden de llegada a la nube), `arbitrar` (puro).
  `resolverConflictoAsiento(db, salida, asiento)` aplica: ganador `firme`,
  perdedores `conflicto` + boleto `conflicto_sobreventa` (sin borrarse),
  excepción `sobreventa` crítica deduplicada.
- **Pruebas**: 7 `it.todo` de ARBITRAJE de `motor-pendiente.test.ts` convertidos
  a pruebas puras reales; `tests/sync/arbitraje.test.ts` (5) para la aplicación.

### Slice 5 — reasignación automática del perdedor (01b §7)

- **`src/sync/reasignacion.ts`**: `elegirAsientoReasignado(mapa, anterior,
  libres, acompañantes)` puro — mismo bloque → adyacente a acompañante (misma
  fila, columnas contiguas) → cualquiera; `null` si no cabe.
  `proponerReasignacion(db, boletoId)` — libera la ocupación vieja, toma la nueva
  firme, boleto a `reasignado` **con el mismo folio**, `nota_auditoria`
  (`reasignacion_por_conflicto`) + reimpresión `REIMPRESIÓN — CAMBIO DE ASIENTO`.
  Unidad llena → `null` + excepción `sobreventa` severidad **alta**.
  `reasignarPerdedores` encadena §6 → §7.
- **Pruebas**: 4 `it.todo` de REASIGNACIÓN convertidos a pruebas puras;
  `tests/sync/reasignacion.test.ts` (4) para la base.

### Cierre

Backend de F4 cerrado. Suite: **270 verdes, 0 rojas, 18 `it.todo`** (los 13 de
ARBITRAJE/REASIGNACIÓN se implementaron; quedan engine 12 + checksum de
reconcile 6). `tsc` limpio. Migraciones `0021`–`0023` aplicadas en local y nube.
Mergeada a `main` el 2026-09-01 (PR #3, merge commit `5226d73`); rama
`f4-venta-backend` eliminada.

**Pendiente de F4 (bloqueado):** el render del mapa de asientos en la SPA, a la
espera de la aprobación del prototipo del cliente.

### Nota de entorno

Los hooks y el statusline de ruflo (`hook-handler.cjs`, `statusline.cjs`) lanzan
procesos `npx @claude-flow/cli …` desatendidos que se cuelgan (mismo fallo que el
timeout del MCP `claude-flow` al arrancar). Se acumularon ~390 procesos `node`
(~6 GB) y hubo que barrerlos por antigüedad a lo largo de la sesión. La
mitigación real es `"disableAllHooks": true` en `~/.claude/settings.json`
(backups guardados en `*.bak-donaji-oom`).

---

## Sesión 12 — 2026-09-01 · Fase F6 (cortes de caja), 2 slices

Se saltó F5 (impresión) por ahora: F6 no depende de ella y cierra de paso el
enlace `pago → movimiento_caja` que F4 había dejado pendiente. Rama `f6-caja`.

### Slice 1 — ciclo del corte (`0024`, `src/caja/corte.ts`)

- `core.abrir_corte(sucursal, usuario, saldo_inicial, ahora?)` — el "un solo
  corte abierto por sucursal" lo garantiza el índice único parcial
  `corte_unico_abierto_idx` (0006); la función solo traduce el `unique_violation`
  a un mensaje. `core.cerrar_corte(corte, usuario_cierre, saldo_declarado,
  ahora?)` → desglose + diferencia declarado − calculado; guarda
  `saldo_final_calculado` desde `v_corte_saldo`.
- **`src/caja/corte.ts`**: `abrirCorte`, `cerrarCorte`, `saldoCorte`,
  `corteAbiertoDe`.
- **Pruebas** (`tests/caja/corte.test.ts`, 10): 2º corte rechazado por la BD
  (verificado: sigue habiendo uno), otra sucursal sí a la vez, tras cerrar se
  abre otro, diferencia, doble cierre, saldo negativo / inexistente / usuario no
  vigente. Helper `esperaError` (SAVEPOINT) para varias aserciones-que-lanzan en
  una transacción.

### Slice 2 — movimientos (`0025`, `src/caja/movimiento.ts`)

- **`core.trg_pago_a_ingreso`** — trigger en `core.pago`: crea el
  `movimiento_caja(ingreso, pago_boleto)` cuando el pago se vuelve dinero
  confirmado (efectivo al registrar, transferencia al verificar). Suma al corte
  de `pago.corte_caja_id` — el de quien COBRA, no la venta (C5). Guardado con
  `sync.replicando()`. La baja del pago arrastra su ingreso.
- `core.registrar_egreso(...)` — descripción obligatoria.
  `core.anular_movimiento(...)` — baja lógica idempotente; el monto vuelve al
  corte por la vista, el registro queda para auditoría.
- **`src/caja/movimiento.ts`**: `registrarEgreso`, `anularMovimiento`,
  `movimientosDeCorte(corte, rol)` — gerente → `v_movimiento_operativo`, admin →
  `v_movimiento_auditoria`.
- **Pruebas** (`tests/caja/movimiento.test.ts`, 9) — los 4 criterios de
  aceptación de F6: venta efectivo suma ingreso, transferencia no hasta
  verificar, **reservación cobrada en destino suma al corte de quien cobra**,
  egreso resta / sin descripción lanza, **anular egreso devuelve el monto**,
  **gerente no ve el inactivo / admin sí**, corte cerrado rechaza, baja del pago
  arrastra su ingreso. El enlace pago→ingreso es real: usan `registrarVenta` /
  `registrarPago` / `verificarTransferencia` de F4.

### Cierre

F6 cerrada (los 4 criterios de aceptación). Suite: **289 verdes, 0 rojas, 18
`it.todo`**. `tsc` limpio. Migraciones `0024`–`0025` en local y nube. Mergeada a
`main` el 2026-09-01 (PR #4, merge commit `e9bda8f`); rama `f6-caja` eliminada.

De higiene: se quitó de `scripts/sembrar-admin.ts` el ejemplo de uso con
contraseña en línea (`ADMIN_PASSWORD='…'`), que el inspector de git marcaba como
"Password exposed".

---

## Sesión 13 — 2026-09-01 · Fase F7 (viajes efectuados), 2 slices

La impresora sigue sin estar lista (problemas técnicos y de red), así que se
saltó F5 otra vez: F7 no depende de imprimir físicamente — encola los `print_job`
igual que F4 con los boletos. Rama `f7-viajes`.

### Slice 1 — manifiestos (`0026`, `src/fleet/manifiesto.ts`)

- `core.salidas_del_dia(fecha, sucursal?)` — listado de viajes del día.
- `core.datos_manifiesto(salida, copia, ahora?)` — datos congelados. Copia
  **conductor**: por parada de ascenso, sin importes. Copia **terminal**: con
  importe, saldo pendiente, **boletos en conflicto marcados** (`conflicto: true`)
  y ocupación por tramo. Lleva `generado_en` (las ventas posteriores no salen en
  el papel). Las paradas de ascenso son todas menos el destino; una parada sin
  nadie se lista vacía.
- `core.generar_manifiestos(salida, usuario, ahora?)` — encola los dos
  `print_job` (`manifiesto_conductor` / `manifiesto_terminal`) en la sucursal de
  origen; al regenerar da de baja (`activo=false`) los manifiestos pendientes
  previos.
- **`src/fleet/manifiesto.ts`**: `salidasDelDia`, `datosManifiesto`,
  `generarManifiestos`.
- **Pruebas** (`tests/fleet/manifiesto.test.ts`, 9).

### Slice 2 — abordaje + estado del viaje (`0027`, `src/fleet/abordaje.ts`)

- `core.registrar_abordaje(boleto, abordo, usuario, sucursal, ahora?)` — captura
  (append-only, clase C). `core.corregir_abordaje(evento, ...)` — hecho nuevo con
  `anula_evento_id`, **nunca un UPDATE**; el último no anulado manda
  (`v_boleto_abordaje`).
- `core.marcar_en_ruta(salida, usuario, conductor?, ahora?)` — INSERT
  `evento_salida` tipo `en_ruta`; UPDATE `salida` estado + `salida_real_en` +
  conductor. **Bloquea la venta** desde ahí (ya lo respetan `registrar_venta`,
  `buscar_salidas`, `adquirir_lease`). `core.finalizar_salida(...)`.
- Vista `core.v_checklist_abordaje` — por boleto vivo: `abordo` / `no_presento`
  / `pendiente`, con flag `conflicto`.
- **`src/fleet/abordaje.ts`**: `registrarAbordaje`, `corregirAbordaje`,
  `marcarEnRuta`, `finalizarSalida`, `checklistAbordaje`.
- **Pruebas** (`tests/fleet/abordaje.test.ts`, 11): pendiente por defecto,
  abordó / no se presentó, la corrección manda, el evento sube a `sync.outbox`,
  boleto inexistente / cancelado, marcar en ruta fija estado+hora+conductor,
  **una salida en ruta ya no vende**, no re-marcar en ruta, finalizar solo si
  está en ruta.

### Cierre

F7 cerrada. Suite: **309 verdes, 0 rojas, 18 `it.todo`**. `tsc` limpio.
Migraciones `0026`–`0027` en local y nube. Mergeada a `main` el 2026-09-01
(PR #5, merge commit `1bbadd1`); rama `f7-viajes` eliminada.

**Pendiente (F5/F9):** imprimir físicamente manifiestos y tickets — mismo estado
que los boletos de F4, esperando la impresora.

---

## Sesión 14 — 2026-09-01 · Fase F8 (dashboard en nube), 3 slices

Backend de F8. El dashboard como UI es frontend (fuera de alcance aquí, como el
mapa de F4). Rama `f8-dashboard`, PR #6 (merge `a0b3543`).

### Slice 1 — reportes de operación (`0028`, `src/dashboard/operacion.ts`)

- Esquema `reporte`. `f_ventas(desde, hasta, sucursal?)` reporta por la sucursal
  que **vende** (`venta.sucursal_venta_id`); `f_ingresos_caja(...)` por la que
  **cobra** (`pago.sucursal_cobro_id`). Funciones separadas a propósito: la
  reservación pagada en destino es venta en el origen e ingreso en el destino
  (**C5**). `f_ventas_vs_caja(...)` las pone lado a lado con la nota de que **no
  deben cuadrar**. `f_cortes(...)` con declarado vs. calculado. Día operativo =
  día local de la sucursal.
- **Pruebas** (`tests/dashboard/operacion.test.ts`, 6).

### Slice 2 — auditoría, salud, gastos (`0029`, `src/dashboard/auditoria.ts`)

- `v_inactivos` (baja lógica con motivo y resumen), `v_salud_sucursal` (última
  sync, atraso, deriva, versión, `degradado` = `null`/`false`/`true`),
  `f_excepciones_abiertas()` / `f_excepciones_resumen()`, `f_gastos(desde, hasta)`
  (egresos de caja por sucursal + nómina mensual, sin prorratear).
- **Pruebas** (`tests/dashboard/auditoria.test.ts`, 5).

### Slice 3 — esquema `api` + export semanal (`0030`, `scripts/export-semanal.ts`)

- `api.v1_venta`, `api.v1_pago`, `api.v1_movimiento_caja` (activos e inactivos),
  `api.v1_salida` — versionadas y **andamiadas**: P7 sigue parcial (falta el
  mecanismo de acceso del sistema externo). `docs/architecture/api-contrato.md`
  documenta el esquema y la política `v1_`/`v2_`.
- `src/dashboard/export.ts` — `rangoSemanaAnterior` (lun–dom ISO),
  `generarBundleSemanal`, `escribirBundle` (10 JSON por semana en
  `exports/<YYYY-Www>/`). `npm run export:semanal` (default `--target nube`); la
  entrega (correo / SFTP) la cablea F9. `exports/` gitignoreado.
- **Pruebas** (`tests/dashboard/export.test.ts`, 4).

### Cierre

F8 cerrada. Los 4 criterios de aceptación cubiertos. Suite: **324 verdes, 0
rojas, 18 `it.todo`**. `tsc` limpio. Migraciones `0028`–`0030` en local y nube.

---

## Sesión 15 — 2026-09-01 · API `/sync` y arranque de la SPA

QA necesitaba pantallas para probar logueo, navegación y el motor de sync en
vivo. El repo no tenía nada de frontend. Decisiones con el usuario: SPA en `web/`
en este mismo repo, construir directo contra el blueprint (sin subagente
arquitecto — la infra de ruflo sigue inestable), primer entregable = login +
shell + Sincronización + Clientes. Rama `spa-y-api-qa`, PR #7 (merge `6b9a347`).

### API — estado del motor de sync (`src/api/rutas/sync.ts`)

- `GET /sync/estado` — snapshot: outbox pendiente/atascado, más viejo sin subir,
  última sync, deriva, excepciones por severidad, versión de esquema, última
  pasada del aplicador, `degradado` (contra `umbral_sync_degradado_horas`).
- `GET /sync/excepciones` — abiertas, crítica primero.
- `POST /sync/ciclo` — disparo manual: abre `Client` frescos a local y nube, hace
  `push` + `pull`, y los cierra. Reporta el fallo si la nube no responde. Nunca
  en el camino crítico de una venta (el motor es un contenedor aparte, §4.1).
- **Pruebas** (`tests/api/sync.test.ts`, 4).

### SPA (`web/`)

- React 18 + Vite + TanStack Query + Tailwind + React Router. `package.json` y
  `node_modules` propios. Proxy dev `/api/*` → `http://127.0.0.1:3000`.
- `src/api/` cliente HTTP (fetch + token opaco en memoria + `sessionStorage`) y
  wrappers por dominio. `src/auth/sesion.tsx` — `ProveedorSesion` / `useSesion`,
  rehidratación por `/auth/me`.
- Pantallas: **Login → Elegir sucursal** (paso 2 solo si el usuario tiene
  varias) → **Shell** con navegación. **Sincronización** (polling 3 s del estado,
  botón "Forzar ciclo", excepciones abiertas). **Clientes** (alta + búsqueda,
  CRUD de F2).
- `npm run typecheck` y `vite build` verdes.

### Cómo lo corre QA

```
npm run api                          # raíz
cd web && npm install && npm run dev  # http://localhost:5173
```
Login: `admin@donaji.local` / `donaji-admin`. Flujo de prueba del motor:
registrar un cliente → ver subir el outbox → "Forzar ciclo" → ver drenar.

### Siguiente iteración

Un slice por dominio = ruta API + pantalla: ventas/reservación, caja, viajes,
dashboard (reportes de F8). El flujo de venta con mapa de asientos sigue
esperando el prototipo del cliente.

Suite backend: **328 verdes, 0 rojas, 18 `it.todo`**.

---

## Sesión 16 — 2026-09-01 · SPA: slice de ventas (ruta API + pantalla)

Primer slice de dominio sobre la SPA. Rama `spa-ventas`, PR #8 (merge `3c01233`).

### API — `src/api/rutas/ventas.ts` (`tests/api/ventas.test.ts`, 6)

- `GET /ventas/salidas` — búsqueda con disponibilidad por tramo (pasos 1-2).
- `POST /ventas/lease` · `POST /ventas/lease/:id/liberar` — paso 3 con conexión.
- `POST /ventas` — registra venta/reservación (pasos 4-6). **`sucursalVentaId` y
  `usuarioId` siempre salen de la sesión, nunca del body.**
- `POST /ventas/:id/pagos` — abono/liquidación (posible en otra sucursal, C5).
- `POST /ventas/pagos/:id/verificar` · `GET /ventas/:id` (saldo + boletos).
- **El error handler** ahora mapea los `RAISE` de las funciones de dominio
  (SQLSTATE `P0001`) a **422 `regla_negocio`** con el mensaje — antes esos
  errores caían a 500 genérico.
- Helper `crearUsuarioConAcceso` en `tests/ventas/fixture.ts` (usuario +
  credencial `PASSWORD_OK` + `usuario_sucursal`) para las pruebas HTTP.

### SPA — `web/src/paginas/Vender.tsx`

Stepper de 6 pasos: búsqueda → horario → **asientos** (lista de
`asientosOfrecibles`; el mapa visual espera el prototipo del cliente) →
pasajeros → resumen → pago (efectivo / transferencia / reservar sin pago).
`web/src/api/{ventas,catalogos}.ts`. "Vender" es la pantalla de inicio.

Suite backend: **334 verdes, 0 rojas, 18 `it.todo`**. web: `tsc` + `vite build`
verdes.

---

## Sesión 17 — 2026-08-27 · SPA caja, bug de replicación y motor de sync automático

Tres entregas encadenadas (PRs #9, #10, #11).

### SPA — slice de caja (PR #9, rama `spa-caja`)

- `src/api/rutas/caja.ts` (`tests/api/caja.test.ts`, 7): `GET/POST /caja/corte`,
  `POST /caja/corte/:id/cerrar`, `GET /caja/corte/:id/movimientos` (visibilidad
  por rol), `POST /caja/corte/:id/egresos`, `POST /caja/movimientos/:id/anular`.
- `web/src/paginas/Caja.tsx` (`AbrirCorte` / `CorteAbiertoVista`), `web/src/api/caja.ts`.

### Bug: un cliente nuevo no llegaba a Supabase (PR #10, rama `fix-sync-cliente`)

- Causa raíz: `core.cliente.telefono_normalizado` es **columna generada**, y
  `sync.ingest_fila` la incluía en el `INSERT`, que Postgres rechaza. El outbox
  quedaba en `rechazado` en silencio.
- **`0031_ingesta_columnas_generadas.sql`**: reescribe `sync.ingest_fila`
  (partiendo de la versión 0014, conservando el envoltorio `donaji.replicando`)
  añadiendo `AND c.is_generated = 'NEVER'` a la lista de columnas. Reencola los
  `core.cliente` rechazados por ese motivo.
- **`0032_outbox_no_sube_config.sql`**: `sync.es_tabla_config()` +
  `sync.trg_outbox()` ya no encola tablas clase A (las que tienen
  `trg_cambio_log`). Resuelve el conflicto perpetuo de `tipo_unidad_clave_key`.
- `scripts/limpiar-dev.ts` reemplaza a `limpiar-datos-poc.ts`: purga filas de la
  PoC (prefijo `01900000-`) **incluyendo `sync.cambio_log`** (en la nube tenía
  101 entradas que re-propagaban la PoC a cada pull) y, solo en `local`, resetea
  el runtime de sync.

### Motor de sync automático (PR #11, rama `motor-sync-automatico`)

Requisito de QA: *"el motor automáticamente debe ejecutarla si la conexión es
estable… QA no debe intervenir en otro proceso adicional"*.

- **`src/sync/servicio.ts`** (nuevo): supervisor `iniciarMotor()`. Conexiones a
  local y nube, arranca un `SyncEngine`, reconecta desde cero si una se cae,
  sobrevive a arrancar sin internet.
- **`src/api/main.ts`**: `npm run api` arranca el motor **embebido por defecto**
  (con conexión, cada operación llega a la nube en segundos; sin conexión, se
  encola y la terminal sigue operando). Producción: `API_SIN_SYNC=1` + servicio
  aparte. Red de seguridad de 5 s al cerrar (el `SyncEngine.detener()` puede
  esperar a un push contra una nube muda).
- **`scripts/sync.ts`**: reescrito como envoltura fina sobre `iniciarMotor()`.
- **`package.json`**: `pretest` → `scripts/limpiar-dev.ts` (la suite arranca
  siempre contra una base sin ruido de un `npm run api` previo); script `sync`.
- **Deadlocks en la suite**: causados por `TRUNCATE sync.*` dentro de
  transacciones de prueba — su `ACCESS EXCLUSIVE`, tomado ANTES del primer INSERT
  (o sea antes del lock de `sync.hlc_estado`), rompía la serialización que ese
  lock impone y abría un ciclo entre archivos. Se cambiaron a `DELETE`; el
  `pretest` deja las tablas limpias.

Suite backend: **346 verdes, 0 rojas, 18 `it.todo`**. `tsc --noEmit` limpio.

### Pendiente de la SPA

- Slices de **Viajes** y **Dashboard** aún sin construir.
- El mapa visual de asientos sigue esperando el prototipo del cliente.
- El botón "Forzar ciclo" y `POST /sync/ciclo` quedan como diagnóstico de QA
  ("pruebas en vivo"); ya no son necesarios para operar.

---

## Sesión 18 — 2026-08-28 · Reconciliación por checksum: diff dirigido (PR #12)

Deuda de F1 (`motor-pendiente.test.ts`): los 6 `it.todo` del checksum de
`reconcile.ts`. `sync.calcular_checksum` decía SI un bloque diverge; faltaba QUÉ
fila y de qué lado, que es lo que el §6.1 promete ("el bloque exacto y un re-push
dirigido").

- **`0033_filas_bloque.sql`**: `sync.filas_bloque(tabla, sucursal, dia)` →
  `(id, version)` por fila, mismo corte UTC que `calcular_checksum`.
- **`src/sync/reconcile.ts`**: cuando un bloque no coincide, baja al detalle y
  clasifica cada id en `soloEnLocal` (el nodo la tiene, la nube no → re-push),
  `soloEnNube` (pérdida local → excepción crítica, humano) o `versionDistinta`
  (mismo id, otra `version` → divergencia de contenido). El re-push dirigido
  reencola SOLO `soloEnLocal ∪ versionDistinta`, no el día entero. La excepción
  `divergencia_checksum` lleva las listas (recortadas a 50) en el detalle.
- **`tests/sync/reconcile.test.ts`** (6, nube simulada): los 6 `it.todo` se
  vuelven pruebas reales. `motor-pendiente.test.ts` los quita.
- Incidente de la sesión: un motor de sync embebido (`npm run api`) quedó vivo
  contra la base de dev escribiendo `sync.salud` con la hora real; frente al
  `AHORA` futuro de las pruebas, 46 fallaron por `bloqueo_degradado`. Se mató el
  proceso y se restauró el repunte de `sync.nodo` en `seedAuth`/`seedCaja` (ahora
  DESPUÉS de los INSERT, donde no interbloquea) como defensa permanente.

Suite backend: **352 verdes, 0 rojas, 12 `it.todo`**. `tsc --noEmit` limpio.

---

## Sesión 19 — 2026-08-28 · Motor de sync: los 12 `it.todo` de `engine.ts` (PR #13)

Última deuda de F1. `engine.ts` ATERRIZÓ hace tiempo como la clase `SyncEngine`
(no `crearMotor`): toma dos `Client` abiertos y `servicio.ts` los reconecta. El
`ContratoEngine` propuesto se retira; las pruebas se escriben contra el motor real.

- **`src/sync/engine.ts`**: se añade `get modo(): EstadoMotor`
  (`detenido | inactivo | sincronizando | sin_red | degradado`) derivado del
  estado interno, y `async ciclo(): Promise<ResultadoCiclo>` — un push + un pull,
  independientes, que resuelve al terminar (lo que las pruebas necesitan para no
  depender de timers). El campo privado `estado` se renombra a `st` para no
  chocar con el getter.
- **`tests/sync/engine.test.ts`** (11 + 1 `it.todo`, nube simulada): cadencia
  (push ≫ pull), push inmediato tras venta, nube caída → `sin_red` sin lanzar,
  `calcularBackoff` monótono y topado (puro), backoff que se reinicia tras el
  primer éxito (fallo forzado con `LOCK sync.lote_recibido` + `lock_timeout` en
  conexión dedicada), drenaje en lotes, `detener()` que espera el ciclo en curso,
  dos motores sin doble envío (`FOR UPDATE SKIP LOCKED`), degradado a +73 h con
  `now()` inyectado, degradado que sigue drenando, error de pull que no tumba el
  push.
- El `it.todo` que queda: "catch-up de pull ANTES de vender fuera de cupo" — no
  es solo del motor; exige que `src/ventas/` consulte una señal y bloquee el
  override. El motor ya expone `modo` y `ultimaSyncExitosa`; falta el enganche.
- `motor-pendiente.test.ts` retira el `ContratoEngine` y el bloque de 12
  `it.todo`; solo conserva las propiedades puras de arbitraje/reasignación.

Suite backend: **363 verdes, 0 rojas, 1 `it.todo`**. `tsc --noEmit` limpio.

---

## Pendientes de F1

- El contrato de pruebas del motor está CERRADO: `salud.ts` (Ses. 4), arbitraje
  y reasignación (F4), checksum dirigido de `reconcile.ts` (Ses. 18) y los 12
  `it.todo` de `engine.ts` (Ses. 19, `tests/sync/engine.test.ts`).
- Queda **1 `it.todo`**: "catch-up de pull ANTES de vender fuera de cupo" — es
  cross-cutting (motor + `src/ventas/`), a la espera de esa decisión de diseño.

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
