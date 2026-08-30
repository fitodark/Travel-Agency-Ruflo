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

## Sesión 20 — 2026-08-28 · SPA: slice de Viajes (PR #14)

Cuarta pantalla de dominio. Backend F7 (`src/fleet/{manifiesto,abordaje}.ts`) ya
estaba; faltaba exponerlo por HTTP y la pantalla.

- **`src/api/rutas/viajes.ts`** (`tests/api/viajes.test.ts`, 7):
  - `GET /viajes?fecha=` — salidas del día de mi sucursal (sesión), con conteo de boletos.
  - `GET /viajes/:id/checklist` — checklist de abordaje por asiento.
  - `GET /viajes/:id/manifiesto?copia=` — datos congelados para previsualizar.
  - `POST /viajes/:id/manifiestos` — encola las dos copias (conductor/terminal) → 201.
  - `POST /viajes/:id/en-ruta` · `POST /viajes/:id/finalizar` — estado del viaje.
  - `POST /viajes/abordaje` · `POST /viajes/abordaje/:id/corregir` — captura.
  - Escritura pide `abordaje.registrar` (rol operativo: vendedor+). `sucursalId`/
    `usuarioId` de la sesión. Reglas de negocio (salida no en ruta, boleto
    inexistente) → 422.
- **`web/src/paginas/Viajes.tsx`** + `web/src/api/viajes.ts`: lista de salidas con
  chip de estado; al abrir una, checklist con botones "abordó / no se presentó",
  y acciones "Generar manifiestos" / "Marcar en ruta" / "Finalizar viaje". Boletos
  en conflicto resaltados. Cuarto ítem del nav del Shell.

Suite backend: **370 verdes, 1 `it.todo`**. `web`: `tsc` + `vite build` verdes.

---

## Sesión 21 — 2026-08-28 · SPA: slice de Dashboard (PR #15)

Quinta y última pantalla de dominio pendiente. Backend F8 (`src/dashboard/
{operacion,auditoria}.ts`, esquema `reporte`) ya estaba.

- **`src/api/rutas/reportes.ts`** (`tests/api/reportes.test.ts`, 8), SOLO LECTURA
  contra la base LOCAL (números de ESTA terminal; el consolidado es el tablero
  en nube, fuera de alcance):
  - `GET /reportes/{ventas,ingresos-caja,ventas-vs-caja,cortes,gastos}?desde=&hasta=`
  - `GET /reportes/{salud,excepciones,inactivos}`
  - Operación pide `dashboard.ver`; auditoría/salud/gastos/excepciones piden
    `auditoria.ver`. Ambos son de administrador → 403 para vendedor/gerente.
- **`web/src/paginas/Dashboard.tsx`** + `web/src/api/reportes.ts`: selector de
  rango + pestañas (Ventas · Ventas vs. caja · Cortes · Gastos · Salud ·
  Excepciones), tabla genérica. Ruta `/tablero`.
- **`web/src/componentes/Shell.tsx`**: el nav filtra por permiso (`puede`); el
  ítem "Tablero" solo aparece para administrador.

Suite backend: **378 verdes, 1 `it.todo`**. `web`: `tsc` + `vite build` verdes.

---

## Sesión 22 — 2026-08-28 · Tablero consolidado en nube (PR #16)

El deliverable en nube de F8. Decisión (con el usuario, P7 sigue abierta): un
**servicio HTTP de reportes** aparte, no PostgREST ni fotos del export.

- **`src/dashboard/servidor.ts`** (`tests/dashboard/servidor.test.ts`, 7):
  `construirServidorTablero({ db, token })` → Fastify. Reutiliza
  `src/dashboard/{operacion,auditoria}.ts` SIN filtro de sucursal (las 4 juntas).
  - `GET /reportes/{ventas,ingresos-caja,ventas-vs-caja,cortes,gastos}?desde=&hasta=`
  - `GET /reportes/{salud,excepciones}`
  - Auth: `Authorization: Bearer` contra `DASHBOARD_TOKEN` (compare en tiempo
    constante). No hay sesiones ni RBAC — es de solo lectura y P7 aún no fija el
    mecanismo formal (rol de Postgres / PostgREST).
  - `GET /salud` sin auth (healthcheck); `GET /` sirve la página.
- **`src/dashboard/tablero.html`** — página autónoma (HTML + JS vanilla, sin
  build): login por token en `localStorage`, selector de rango, pestañas, tablas.
- **`src/dashboard/main.ts`** — `npm run tablero:nube`: `Pool` a `DATABASE_URL`
  (Supabase), `TABLERO_PUERTO`/`_HOST`, cierre con red de seguridad. Corre JUNTO
  a la nube, NO en la terminal.
- Verificado E2E contra el Supabase real (`/salud`, `/`, 401 sin token,
  `/reportes/salud` con token).

Distinción: el tablero de la SPA corre en cada terminal y ve su base LOCAL; este
corre en la nube y ve las 4 sucursales consolidadas.

Suite backend: **385 verdes, 1 `it.todo`**. `tsc --noEmit` limpio.

PR #16 **mergeado** a `main` (merge `b2994ad`).

### Pendiente de la SPA / reportes

- Las 5 pantallas de dominio y el tablero en nube están completos.
- El mapa visual de asientos sigue esperando el prototipo del cliente.
- P7: falta cerrar el mecanismo de acceso formal del tablero/consumidor externo
  (hoy: bearer compartido).

---

## Sesión 23 — 2026-08-28 · F5: formato de papel del manifiesto

Arranca F5. La impresora Enduro sigue sin instalar, pero la capa ESC/POS +
`npm run printer:fake` permiten construir y probar toda la maqueta sin hardware;
solo la aceptación física (`printer:poc`) espera el equipo.

- **`src/printing/templates/manifiesto.ts`** — `renderManifiesto(datos, cfg)` →
  bytes ESC/POS. Recibe el jsonb CONGELADO de `core.datos_manifiesto` tal cual
  (interfaz en `snake_case`, sin mapear). Sin E/S, sin transporte, como
  `renderBoleto`.
  - Encabezado: título, `COPIA CONDUCTOR|TERMINAL`, ruta origen→destino, hora de
    salida, fecha de operación, unidad+tipo, conductor (`sin asignar` si null),
    `Generado:` (el snapshot), y estado resaltado si ≠ `programada`.
  - Cuerpo agrupado por parada de ascenso; cada pasajero con casilla `[ ]` para
    palomear a mano, asiento a 2 dígitos, nombre y destino. Parada sin nadie se
    lista como `(sin pasajeros en esta parada)`.
  - Copia `terminal`: además importe, `SALDO $…` solo si hay saldo, línea
    `!! CONFLICTO DE SOBREVENTA` en negritas, y bloque `OCUPACION POR TRAMO`.
  - Copia `conductor`: sin importes/saldo/ocupación.
  - Pie: `TOTAL PASAJEROS`, `BOLETOS EN CONFLICTO` si los hay, y línea de firma
    (`Firma del conductor:` / `Responsable de terminal:`).
  - Horas: extrae `HH:mm` del ISO sin aritmética de zona (P12 abierta); la
    localización se hará al generar el jsonb, no en la plantilla.
- **`tests/printing/manifiesto.test.ts`** (13): encabezado, agrupación, casillas,
  conductor sin importes, terminal con importe/saldo/ocupación, saldo solo si
  procede, conflicto marcado + conteo, parada vacía, total, firma por copia,
  `sin asignar`, estado resaltado, respeta ancho 32/48/64, corte de papel.

Pendiente de F5: enganchar un spooler que consuma `core.print_job` y despache por
`template_key` (`boleto` / `manifiesto_conductor` / `manifiesto_terminal`) al
transporte de `core.config_impresora`; y un `printer:poc` de manifiesto para la
aceptación física cuando llegue la Enduro.

Suite backend: **398 verdes, 1 `it.todo`**. `tsc --noEmit` limpio. PR #17
**mergeado** (merge `e1ea734`).

---

## Sesión 24 — 2026-08-28 · F5: spooler de impresión

El consumidor de `core.print_job` que faltaba. Alcance acordado con el usuario:
**solo manifiesto**. La plantilla de boleto y el mapa de asientos siguen
esperando aprobación del prototipo del cliente, así que el boleto no se cablea
todavía y `core.snapshot_boleto` no se toca.

- **`src/printing/spooler.ts`**:
  - `procesarCola(db, opts)` → `ResumenSpooler`. Una pasada: recupera jobs en
    `imprimiendo` de una corrida interrumpida, agrupa los `pendiente` por
    sucursal, para cada una carga `core.config_impresora`
    (`cargarConfigImpresora`), sondea el transporte, y reclama el lote entero con
    `UPDATE ... estado='imprimiendo', intentos+1 ... FOR UPDATE SKIP LOCKED`.
  - Por job: `renderPrintJob(template_key, datos, {cols, codePage})` →
    `open/write/close` → `impreso` con `impreso_en`. Si falla, vuelve a
    `pendiente`; al llegar a `maxIntentos` (3) → `revision_manual` con
    `ultimo_error`.
  - Impresora ausente o que no responde a la sonda: los jobs se quedan en
    `pendiente` SIN gastar intentos (`sinImpresora` / `impresoraFuera` en el
    resumen).
  - `renderPrintJob` solo cablea `manifiesto_conductor` / `manifiesto_terminal`
    (ver `TEMPLATES_SOPORTADOS`); los `boleto` nunca se reclaman.
  - Supuesto D-1 (una PC, un spooler): la recuperación de `imprimiendo` no
    coordina leases.
- **`src/printing/tools/spooler-run.ts`** — `npm run printer:spooler`
  (`--once`, `--interval N`). Bucle contra la base LOCAL.
- **`src/printing/tools/poc-manifiesto.ts`** — `npm run printer:poc-manifiesto
  -- --salida <uuid> [--copia conductor] [--transport tcp|usb]`. Renderiza una
  salida real SIN tocar la cola; por defecto captura y vuelca el papel simulado.
  Es la vía de aceptación física de F5 cuando llegue la Enduro.
- **`tests/printing/spooler.test.ts`** (8, PostgreSQL real, transporte falso
  inyectado): imprime y marca `impreso` + `impreso_en`; respeta el ancho de la
  impresora; sin impresora → sigue en cola; sonda falla → no gasta intentos;
  fallo de escritura reintenta y agota a `revision_manual`; no toca `boleto`;
  recupera `imprimiendo`; segunda pasada no reimprime.

Pendiente de F5: cablear el boleto (cuando su plantilla esté aprobada) —
probablemente exige completar `core.snapshot_boleto` (dirección/teléfono de
origen, número de unidad, `emitido_en`, hora en la zona de la sucursal, que ya
vive en `core.sucursal.zona_horaria`); y la aceptación física de ambos
documentos con la Enduro.

Suite backend: spooler **8/8 verde**, `tsc --noEmit` limpio. (PR #18 mergeado
`7b2540e`.) Al pasar la suite completa afloraron dos fallos ajenos al spooler,
que se arreglan en la sesión siguiente.

---

## Sesión 25 — 2026-08-28 · Aislamiento de `sync.test.ts` y `login.test.ts`

Dos pruebas dependían de estado global en vez de aislarse:

- **`tests/api/sync.test.ts`** — `/sync/estado` y `/sync/excepciones` leen
  `sync.excepcion` y `sync.salud` sin filtrar por nodo. La prueba confiaba en que
  el `pretest` (`limpiar-dev.ts`) las dejara vacías, pero correr un solo archivo
  con `vitest` se salta el `pretest` y `npm run sync` las reensucia a media
  suite. Ahora hace `DELETE FROM sync.excepcion` / `sync.salud` dentro de su
  propia transacción (revertido en el `afterEach`). `DELETE` y no `TRUNCATE`: el
  `ACCESS EXCLUSIVE` interbloquea con el lock de `sync.hlc_estado` de otros
  archivos en paralelo.
- **`tests/auth/login.test.ts`** — "registra cada intento" ordenaba
  `auth_local.intento` por `ocurrido_en`; con el reloj fijo de la prueba los dos
  intentos comparten timestamp y el orden salía arbitrario. Ahora ordena por
  `id` (`bigserial`).

Suite completa: **44 archivos, 406 verdes, 1 `it.todo`, 0 rojas** (`npm test`).
PR #19 **mergeado** (merge `e42f745`).

---

## Sesión 26 — 2026-08-28 · Roadmap: fase F2b (consola de administración)

QA preguntó por los módulos de usuarios/accesos y de sucursales, que deben
funcionar mucho antes que ventas. Al reconstruir el estado: **no existe módulo
para dar de alta ni editar la configuración clase A** (usuarios, sucursales,
tarifas, impresora, ticket). El roadmap de F2 lo incluía; solo salió el CRUD de
clientes (clase B). El resto se difirió a "el dashboard en nube", pero F8 se
construyó como reportes de solo lectura. Única vía hoy: `scripts/sembrar-admin.ts`
o `INSERT` a mano.

La maquinaria clase A (`sync.publicar_a_nodos`, `sync.ingest_fila` sin efectos
locales, el aplicador, `bootstrap.ts`, el RBAC replicado) ya está y está probada.
Falta solo la superficie de autoría y tres huecos: `auth_local.credencial` no
está cableada al pipeline de bajada (03 §1.2 lo da por hecho), no hay auth de
administrador en la nube (Supabase Auth), y la capa 3 de revocación HOTP
(03 §1.5) quedó sin hacer.

Se añadió **F2b — Consola de administración en la nube** a
`docs/architecture/04-riesgos-roadmap.md` (4 slices, 2.5–3 semanas, antes de F9).
Tabla resumen y cierre (~20–22 semanas) actualizados. Sin código todavía.

---

## Sesión 27 — 2026-08-28 · F2b slice 1 (a): `auth_local.credencial` → clase A

Primer hueco de cableado de F2b. El blueprint (03 §1.2) dice que el hash de
contraseña se calcula en la nube y baja replicado como clase A, pero nunca se
cableó: la tabla no tenía columnas de sync, ni trigger de publicación, ni pasaba
por `sync.es_tabla_ingerible` (que solo admitía `core`). Una terminal reinstalada
se quedaba sin ninguna contraseña.

- **`src/db/migrations/0034_credencial_clase_a.sql`**:
  - Columna `id uuid` = `usuario_id` (relación 1:1, uuid ya compartido) + trigger
    de derivación + `UNIQUE`. Mismo patrón que `core.rol_permiso` en 0012.
  - `core.registrar_entidad('auth_local.credencial')` — columnas estándar (HLC,
    versión, auditoría, `activo`) + triggers. El de outbox queda inerte por
    `es_tabla_config` (0032): esta tabla solo baja.
  - `sync.es_tabla_ingerible` ampliada de `core` a `core` + `auth_local`. El
    filtro estructural (las 4 columnas de sync) se mantiene: de `auth_local` solo
    `credencial` las tiene.
  - `sync.publicar_a_nodos('auth_local.credencial')`.
- **`src/sync/clases.ts`** — `'auth_local.credencial': 'A'`.
- **`src/sync/bootstrap.ts`** — añadida al `ORDEN_TOPOLOGICO` tras `core.usuario`.
- **`tests/sync/credencial-clase-a.test.ts`** (8): `es_tabla_ingerible` /
  `es_tabla_config`, derivación de `id`, la config no sube al outbox, la ingesta
  aplica una credencial que "baja de la nube", y el arbitraje por HLC.
- El pull (`aplicarFila` → `sync.ingest_fila`) es genérico; no hizo falta tocarlo.

Migración aplicada a **nube primero** (`db:migrate:nube`, Supabase queda en 0034)
y luego a local, según el orden D-8. `f1-criterios.test.ts` (bootstrap contra
Supabase real) lo confirma: fallaba con la nube en 0033, verde con la nube en 0034.

Suite: `tsc` limpio; `tests/sync` + `tests/auth` + `tests/api` = **192 verdes,
1 `it.todo`, 0 rojas**.

Pendiente de slice 1: el helper `escribirConfig({ modo })`, el servicio
`src/admin/` + Supabase Auth, y el rol de escritura dedicado. PR #22 mergeado
(`973d78a`).

---

## Sesión 28 — 2026-08-28 · F2b slice 1 (b): helper `escribirConfig`

La pieza central que usan los slices 2–4: escribir una fila de configuración
clase A en la nube con la fecha de vigencia que corresponde al modo (§3.1–§3.2).

- **`src/admin/escribir-config.ts`** (primer archivo de `src/admin/`):
  - `escribirConfig(db, { tabla, fila, modo, vigenciaEn?, zonaHoraria?,
    fechaProgramada?, confirmarInmediato? })`.
  - `modo`: `ventana` (default) → `effective_from` = próxima 03:00 hora local;
    `inmediato` (exige `confirmarInmediato: true`) → ahora; `programado` → fecha
    dada.
  - `vigenciaEn`: `effective_from` (alta/cambio) o `effective_until` (baja).
  - Zona para `ventana`: explícita → `fila.zona_horaria` → zona de
    `fila.sucursal_id` → `America/Mexico_City` (P12 sin cerrar).
  - Tablas sin columna de vigencia (`core.config_impresora`): solo admiten
    `inmediato`; diferir un cambio no tendría dónde anotarse.
  - Guarda: la tabla debe ser clase A (`claseDe`) y las claves de `fila` deben
    ser columnas reales. (Que la conexión sea de verdad la nube se comprueba una
    vez al arrancar el servicio — ver sesión 29.)
  - Upsert `ON CONFLICT (id)` → `trg_cambio_log` publica hacia las terminales.
  - `proximaVentana(db, zona, ahora)` exportada aparte (la usa el cálculo y sirve
    para previsualizar en la UI).
- **`tests/admin/escribir-config.test.ts`** (11, PostgreSQL real): los 3 modos,
  `effective_until` para bajas, publicación en `sync.cambio_log`, upsert
  idempotente, zona deducida (Tijuana 1 h detrás de CDMX), rechazos (tabla no
  clase A, columna inexistente).

Sin migración: el helper es TS puro sobre el esquema existente.

Suite: `tsc` limpio; `tests/admin` + `tests/sync` + `tests/auth` = **148 verdes,
1 `it.todo`, 0 rojas**.

Pendiente de slice 1: el servicio `src/admin/servidor.ts` + Supabase Auth y el
rol de Postgres de escritura dedicado (sesión 29, mismo PR).

---

## Sesión 29 — 2026-08-28 · F2b slice 1 (c): servicio `src/admin/` + Supabase Auth

El proceso de la consola y su autenticación. Cierra los cimientos de F2b.

- **`src/admin/auth-supabase.ts`** — `verificarTokenSupabase(token, secreto)`:
  verifica offline un JWT HS256 de Supabase Auth (HMAC-SHA256 contra
  `SUPABASE_JWT_SECRET`; comprueba `alg`, firma en tiempo constante, `exp`,
  `aud='authenticated'`). Sin librería de JWT — Node `crypto`. SUPUESTO: el
  proyecto usa el secreto simétrico (modo por defecto histórico); si rota a
  claves asimétricas + JWKS, hay que cambiar el verificador. `firmarTokenSupabase`
  se exporta para pruebas y desarrollo local (los tokens reales los emite GoTrue).
- **`src/admin/servidor.ts`** — `construirServidorAdmin({ db, jwtSecret,
  adminsIniciales?, ahora? })` → Fastify.
  - `GET /salud` sin auth. Todo lo demás bajo `/api`, con `preHandler` que
    verifica el JWT (401) y autoriza (403): el email debe ser un `core.usuario`
    con `rol='administrador'` vigente, o estar en `ADMIN_EMAILS` (lista de
    arranque, para el primer alta antes de que exista ningún usuario).
  - `GET /api/yo` — identidad resuelta (prueba de vida de la auth).
  - `POST /api/config/:tabla` — escritura genérica sobre `escribirConfig`, con
    allowlist `TABLAS_ADMINISTRABLES` (las 10 tablas de config de F2b). Body:
    `{ fila, modo, vigenciaEn?, zonaHoraria?, fechaProgramada?, confirmarInmediato? }`.
    201 si es alta, 200 si actualiza. Los errores de guarda de `escribirConfig`
    → 400 `escritura_invalida`.
- **`src/admin/main.ts`** — `npm run admin`. `Pool` a `DATABASE_URL` (nube),
  `ADMIN_PUERTO`/`_HOST`. **Aquí** se comprueba `sync.nodo.es_nube` una vez al
  arrancar (se sacó de `escribirConfig`: por llamada tomaba el lock de la fila
  única `sync.nodo` y serializaba la suite de pruebas).
- **`tests/admin/servidor.test.ts`** (14) y ajustes en `escribir-config.test.ts`:
  verificación del JWT (firma, expiración, basura), `GET /salud` sin token,
  401 sin token, 403 email no admin, 200 por lista de arranque y por
  `core.usuario`, `POST /api/config` a tabla fuera de la lista → 400, escritura
  + publicación en `sync.cambio_log` (201), `inmediato` sin confirmar → 400.
- **Pendiente (deuda anotada en `main.ts`)**: rol de Postgres dedicado para la
  consola en vez del de `DATABASE_URL`. Y la UI (formularios) — llega con los
  CRUD de los slices 2–4.

`npm test` completo: **47 archivos, 439 verdes, 1 `it.todo`, 0 rojas**.

Con esto **el slice 1 de F2b queda cerrado**: `auth_local.credencial` replica,
`escribirConfig` pone la fecha de vigencia, y el servicio autentica admins y
expone la superficie de escritura. Siguen los slices 2 (sucursales), 3 (usuarios
+ accesos + HOTP) y 4 (impresora/ticket/tarifas).

---

## Sesión 30 — 2026-08-28 · F2b slice 2: sucursales

CRUD de `core.sucursal` desde la consola, con la semilla HOTP al alta.

- **`src/db/migrations/0035_revocacion_hotp_clase_a.sql`** — `auth_local.revocacion_hotp`
  se replica clase A (mismo patrón que 0034): `id uuid` = `sucursal_id`, columnas
  estándar, `publicar_a_nodos`. La semilla se genera en la nube y baja a las
  terminales para la capa 3 de revocación (03 §1.5). En `clases.ts` y
  `bootstrap.ts` (tras `core.sucursal`). Nota de seguridad en el archivo: la
  semilla baja a las 4 terminales, pero un código de revocación solo DESACTIVA
  usuarios (fail-safe), así que el riesgo es acotado. **0035 en nube y local.**
- **`src/admin/sucursales.ts`** — `crearSucursal` (valida código base32 o asigna
  el siguiente libre; valida zona contra `pg_timezone_names`; genera semilla de
  20 bytes), `editarSucursal`, `darDeBajaSucursal` (`activo=false` +
  `effective_until`), `regenerarHotp`, `listarSucursales` (todas, con flag
  `tieneHotp`). La secuencia de folios la crea sola el trigger
  `core.trg_secuencia_folio` cuando la sucursal aterriza en el nodo — aquí no hay
  que hacer nada.
- **`src/admin/rutas-sucursales.ts`** — `GET /api/sucursales`,
  `POST /api/sucursales` (201), `PATCH /api/sucursales/:id`,
  `POST /api/sucursales/:id/baja`, `POST /api/sucursales/:id/regenerar-hotp`.
  Registrado en el bloque `/api` de `servidor.ts` (hereda la auth).
  `auth_local.revocacion_hotp` sumada a `TABLAS_ADMINISTRABLES`.
- **`escribir-config.ts`**: alta y edición ahora son sentencias distintas
  (`INSERT` vs `UPDATE ... WHERE id`). El `INSERT ... ON CONFLICT DO UPDATE`
  anterior fallaba el NOT NULL de las columnas que una edición parcial no trae
  (dirección, código). Y ya no inventa `id`: lo produce la tabla (DEFAULT
  `uuid_v7` o el trigger de derivación), para no pisar el id determinista de
  `parametro`/`rol_permiso`/`credencial`/`revocacion_hotp`.
- **`tests/admin/sucursales.test.ts`** (13: dominio + HTTP). Ajuste en
  `tests/sync/credencial-clase-a.test.ts` (`es_tabla_ingerible` de
  `revocacion_hotp` ahora es `true`). Los `describe` de la consola contra
  PostgreSQL llevan `timeout: 25_000` — cada alta son dos escrituras y la suite
  en paralelo satura el serializador `sync.hlc_estado` (defecto vigente).

`npm test`: **48 archivos, 452 verdes, 1 `it.todo`, 0 rojas**.

---

## Sesión 31 — 2026-08-28 · F2b slice 3 (a): usuarios y accesos (CRUD)

La mitad de CRUD del slice 3 — lo que QA necesita para probar permisos, caja y
viajes con usuarios reales. La capa 3 de revocación HOTP (§1.5) es la otra mitad,
pendiente.

- **`src/admin/usuarios.ts`**:
  - `crearUsuario` — la fila (`core.usuario`), las asignaciones a sucursales
    (`core.usuario_sucursal`), y una CREDENCIAL TEMPORAL: `hashPassword` (Argon2id,
    en la nube) + `debe_cambiar = true`. Devuelve la contraseña en claro UNA vez
    para que el administrador la comunique. `contraseñaTemporal()` genera
    `XXXX-XXXX-XXXX` con un alfabeto sin caracteres que se confunden al dictar.
  - `editarUsuario` (parcial), `darDeBajaUsuario` (INMEDIATA por defecto, §3.4;
    el aplicador del nodo cierra la sesión viva), `asignarSucursal` /
    `quitarSucursal` (reactivar limpia `effective_until`), `restablecerPassword`,
    `listarUsuarios` (con `tieneCredencial` y las sucursales con flag `activa`).
  - Credencial: siempre inmediata, `id = usuario_id` explícito para que un
    restablecimiento sea UPDATE y no choque contra la PK.
- **`src/admin/rutas-usuarios.ts`** — `GET/POST /api/usuarios`, `PATCH /:id`,
  `POST /:id/baja`, `POST /:id/sucursales`, `DELETE /:id/sucursales/:sucursalId`,
  `POST /:id/restablecer-password`. Registradas en `servidor.ts`.
- **`tests/admin/usuarios.test.ts`** (14: dominio + HTTP). `describe` con
  `timeout: 30_000` (Argon2id + varias escrituras por alta).

`npm test`: **49 archivos, 466 verdes, 1 `it.todo`, 0 rojas**.

Pendiente de slice 3: **capa 3 de revocación HOTP** (§1.5) — generador de código
fuera de banda en la consola + validador nuevo en el nodo, consumido en
`src/auth/login.ts`. La semilla ya baja replicada (0035, slice 2).

---

## Sesión 32 — 2026-08-28 · F2b slice 3 (b): capa 3 de revocación HOTP

Cierra el slice 3 y el hueco de la capa 3 de §1.5 que quedó pendiente desde F2.
Escenario: se despide a un vendedor, la sucursal lleva días sin internet, la baja
de clase A no ha bajado. El administrador genera un código de 8 dígitos, lo
**dicta por teléfono**, el gerente lo captura y el nodo bloquea al usuario offline.

- **`src/db/migrations/0036_revocacion_capa3.sql`** — tabla
  `auth_local.revocacion_aplicada` (local del nodo, NO se replica: es la marca de
  bloqueo, como `auth_local.sesion`) + permiso `usuario.revocar` para gerente y
  administrador. **0036 en nube y local.**
- **`src/auth/hotp.ts`** (puro) — `generarCodigo(semilla, usuarioId, contador)`
  (HMAC-SHA1 + truncación RFC 4226, 8 dígitos) y `verificarCodigo` que barre una
  ventana de contadores hacia adelante (el código viaja más rápido que el sync).
  No es TOTP: no depende de relojes, que es justo lo que falla en el escenario.
- **`src/admin/revocacion.ts`** — `generarCodigoRevocacion` (nube): lee la
  semilla, `contador = ultimo_usado + 1`, genera el código y avanza `ultimo_usado`
  (baja replicado como referencia). Ruta
  `POST /api/usuarios/:id/codigo-revocacion`.
- **`src/auth/revocacion.ts`** — `aplicarCodigoRevocacion` (nodo): valida contra
  la semilla local (piso = max de lo consumido por la nube y lo ya aplicado
  localmente, anti-replay), marca `revocacion_aplicada` y cierra las sesiones
  vivas del usuario. Ruta `POST /auth/revocar` (`exige` permiso `usuario.revocar`).
- **`src/auth/login.ts`** — paso 3b: niega la entrada (`motivo: 'revocado'`) si
  hay marca de revocación con `aplicado_en >= usuario.effective_from`. Una re-alta
  desde la consola (con `effective_from` posterior) la deja sin efecto.
- **Pruebas**: `tests/auth/hotp.test.ts` (6, puro), `tests/auth/revocacion.test.ts`
  (6, incluye el ciclo revocar→login denegado→re-alta→login OK),
  `tests/admin/revocacion.test.ts` (3), y 3 casos nuevos en `tests/api/auth.test.ts`
  (gerente aplica; vendedor 403; código inválido 400).

`npm test`: **52 archivos, 484 verdes, 1 `it.todo`, 0 rojas**.

**Slice 3 CERRADO.** Queda el slice 4 (impresora / ticket / tarifas) y el rol de
Postgres de escritura dedicado.

---

## Sesión 33 — 2026-08-28 · F2b slice 4: impresora, ticket, tarifas

Cierra F2b (salvo el rol de Postgres dedicado). Sin migración — sobre el esquema
existente.

- **`src/admin/impresion.ts`**:
  - `configurarImpresora` — SIEMPRE inmediato (`core.config_impresora` no lleva
    vigencia a propósito, 0011: la IP es hardware presente). Actualiza la fila
    vigente de la sucursal si existe, o la crea. **Cierra el pendiente de F0**:
    cuando llegue la Enduro, `configurarImpresora({ ip })` y surte efecto en la
    siguiente impresión, sin desplegar. Valida transporte↔ip/cola.
  - `configurarTicket` — `core.config_ticket` es versionado-append: cada cambio
    es una fila nueva. `ventana` por defecto (cosmético), admite inmediato.
    `ticketVigente(db, agenciaId, ahora)` lee la tabla base (no la vista, que fija
    el instante en `now()`).
  - `listarImpresoras`.
- **`src/admin/tarifas.ts`**:
  - `crearTarifa` — **RECHAZA `inmediato` (§3.4)**: no se cambia el precio a media
    venta. Fija el precio nuevo y CIERRA el anterior del mismo tramo en la misma
    fecha (sin traslape ni hueco). `darDeBajaTarifa`, `listarTarifas`.
- **`src/admin/rutas-config.ts`** — `GET/POST /api/impresoras`,
  `GET/POST /api/ticket`, `GET/POST /api/tarifas`, `POST /api/tarifas/:id/baja`.
  Registradas en `servidor.ts`.
- **`core.parametro` y `core.rol_permiso`** siguen SIN rutas dedicadas: se
  escriben por el endpoint genérico `POST /api/config/:tabla`. Nota: revocar un
  permiso además exige que `rbac.puede()` filtre por `activo` — pendiente.
- **`tests/admin/config.test.ts`** (9: dominio + HTTP).

`tsc` limpio. `npm test`: **53 archivos, 493 verdes, 1 `it.todo`, 0 rojas**.

**F2b CERRADA** salvo el **rol de Postgres de escritura dedicado** para la consola
(hoy usa `DATABASE_URL`, como el tablero). Y del slice 3: `rbac.puede()` no filtra
`activo`, así que revocar un permiso desde la consola aún no surte efecto.

---

## Sesión 34 — 2026-08-28 · F2b: rol de Postgres dedicado + `rbac` filtra `activo`

Los dos pendientes de F2b.

- **`src/auth/rbac.ts`** — `puede()` y `permisosDe()` filtran `AND activo`. Un
  permiso retirado (`activo = false`, que es como la consola lo baja — 
  `core.rol_permiso` no lleva `effective_from`) ya deja de valer.
  `tests/auth/rbac.test.ts` +1 caso, ahora transaccional.
- **`src/db/migrations/0037_rol_consola.sql`** — rol `donaji_consola` (NOLOGIN; el
  despliegue le pone `LOGIN PASSWORD` y la consola apunta con `ADMIN_DATABASE_URL`).
  - **Lee** `core` y `sync` completos (lo mismo que el administrador ve en el
    tablero). **Escribe SOLO** las 9 tablas de config clase A + `auth_local.
    {credencial,revocacion_hotp}` + la fontanería que disparan sus triggers
    (`sync.hlc_estado`, `sync.cambio_log`, `core.folio_secuencia`, secuencias).
    No puede escribir `core.venta`, `boleto`, `pago`, `corte_caja` — nada
    transaccional (P6).
  - `EXECUTE` en `core.uuid_v7`, `sync.hlc_siguiente`, `sync.sucursal_local`.
  - `ALTER DEFAULT PRIVILEGES` para que futuras tablas de `core` sean legibles.
  - `GRANT donaji_consola TO CURRENT_USER` para que ops y pruebas puedan
    `SET ROLE`. **0037 en nube y local.**
- **`src/db/connection.ts`** — `conexionDesdeUrl(url)` extraído (SSL, pooler,
  describe) para una URL cualquiera. **`src/admin/main.ts`** usa
  `ADMIN_DATABASE_URL` si está, si no cae a `DATABASE_URL`.
- **`tests/admin/rol-consola.test.ts`** (2): con `SET LOCAL ROLE donaji_consola`
  corre TODO el CRUD de la consola (sucursal, usuario, revocación, impresora,
  ticket, tarifa, parámetro, permiso) sin un solo `permission denied`, y publica a
  `sync.cambio_log`; y `has_table_privilege` confirma que no puede tocar datos
  transaccionales.

- **`src/db/migrations/0038_forzar_nube_pruebas.sql`** — `sync.trg_cambio_log`
  acepta `SET LOCAL donaji.forzar_nube = 'on'` además de `sync.nodo.es_nube`
  (misma idea que `sync.replicando()`, 0014). Las pruebas de la consola marcaban
  la nube con `UPDATE sync.nodo`, que toma el lock de la fila única y serializaba
  la suite en paralelo hasta hacer saltar timeouts. Ahora usan el GUC — sin lock.
  Sin efecto en producción. **0038 en nube y local.**

`tsc` limpio. `npm test`: **54 archivos, 496 verdes, 1 `it.todo`, 0 rojas**.

**F2b CERRADA.** Despliegue: `ALTER ROLE donaji_consola WITH LOGIN PASSWORD '...'`
en Supabase y `ADMIN_DATABASE_URL` en el entorno de la consola.

Las seis ramas de F2b (sesiones 28–34) se mergearon en orden el 2026-08-28:
PRs **#23–#28**, `main` en `4827f5c`. Migraciones 0034–0038 ya en nube y local.
`src/admin/` tiene la consola completa; `npm run admin` la levanta. Sobre `main`
mergeada: `tsc` limpio, las 84 pruebas de `tests/admin/` + `tests/auth/{rbac,hotp,
revocacion}` en verde. Cierre documental: PR #29.

---

## Sesión 35 — 2026-08-28 · F2b: UI de la consola (primera pasada)

La consola tenía API pero no interfaz. Primera pasada, vanilla como
`tablero.html` (sin build):

- **`src/admin/consola.html`** (~380 líneas). Servida en `GET /` (pública, sin
  token — los datos siguen tras el JWT). Login: si `/config` trae
  `supabaseUrl`+`anonKey` → formulario email/contraseña con `@supabase/supabase-js`
  (cdnjs); si no → pegado de token. El JWT vive en `localStorage`.
  - Pestaña **Sucursales**: tabla (código, nombre, zona, vigencia, estado, HOTP)
    + "Nueva sucursal" (formulario) + acciones por fila (editar, baja, regenerar
    HOTP) vía `prompt`/`confirm`.
  - Pestaña **Usuarios y accesos**: tabla (nombre/correo, rol, sucursales,
    credencial, estado) + "Nuevo usuario" (con checkboxes de sucursales, devuelve
    la contraseña temporal) + acciones (editar, baja, asignar/quitar sucursal,
    restablecer contraseña, **código de revocación** — abre un `prompt` con el
    código de 8 dígitos para dictar).
  - Widget de modo de propagación reutilizable (ventana / inmediato con
    confirmación / programado con fecha).
- **`src/admin/servidor.ts`** — `GET /` sirve `consola.html`; `GET /config`
  devuelve `{ supabaseUrl, supabaseAnonKey }` (públicos; vacíos si no se
  configuró). `OpcionesServidorAdmin` gana `supabaseUrl`/`supabaseAnonKey`/`pagina`.
- **`src/admin/lookups.ts`** — `resolverAgencia(db, id?)`: usa la única agencia si
  no se pasa una (el caso de Donaji). `POST /api/sucursales` y `/api/ticket` ya no
  exigen `agenciaId`.
- **`src/admin/main.ts`** — pasa `SUPABASE_URL`/`SUPABASE_ANON_KEY` del entorno.
- Verificado en el navegador (servidor local + JWT de prueba): login, ambas
  pestañas, alta de sucursal por API (201, agencia resuelta), y el toggle del
  widget de modo.
- **`tests/admin/servidor.test.ts`** +4 (`GET /`, `GET /config`),
  `tests/admin/sucursales.test.ts` +1 (alta sin `agenciaId`).

### Segunda pasada (misma sesión) — impresora, ticket, tarifas

- El JS se separó a **`src/admin/consola.js`** (servido en `GET /consola.js`);
  `consola.html` queda en 78 líneas y ambos bajo el límite de 500.
- Pestaña **Impresoras**: tabla + formulario (sucursal, transporte tcp/usb con
  campos que se muestran según el transporte, IP/puerto/cola, columnas, code
  page, predeterminada). Siempre inmediato. Upsert por sucursal.
- Pestaña **Ticket**: formulario con los valores vigentes precargados (leyenda,
  teléfono, créditos del proveedor, logo, secreto HMAC) + modo. Cada guardado es
  una versión nueva.
- Pestaña **Tarifas**: tabla (ruta, tramo, importe, vigencia, estado) + "Nueva
  tarifa" (select de ruta → selects de origen/destino poblados de sus paradas,
  importe, modo sin `inmediato` por §3.4) + acción "retirar" por fila.
- **`src/admin/tarifas.ts`** — `listarRutas(db)` (ruta + paradas). Ruta
  `GET /api/rutas`.
- Verificado en el navegador: las 5 pestañas cargan, y alta de impresora y de
  ticket por sus endpoints devuelven 201. `tests/admin/servidor.test.ts`
  actualizado para `/consola.js`.

### Tercera pasada (misma sesión) — formularios inline en vez de `prompt`

- **`editor({ titulo, campos, conModo?, onGuardar })`** en `consola.js`: renderiza
  un formulario a pantalla completa del panel (con "← volver") a partir de una
  lista de campos (`text`/`select`/`checkbox`/`number`/`datetime-local`), opcional
  el widget de modo. Reemplaza los `prompt` de `suc-edit` y `usr-edit`.
- **`banner(html)`** — mensaje persistente (se cierra a mano) para la contraseña
  temporal y el código de revocación, en vez de un `toast` de 3,5 s.
- **`usr-suc`** ahora es una vista con la lista de sucursales y un botón
  asignar/quitar por fila (refresca en sitio), en vez de un `prompt` + `confirm`.
- **`usr-revocar`** es un `editor` con un select de sucursal → genera el código y
  lo muestra en un `banner` sobre la lista.
- Los `confirm()` de baja / regenerar HOTP se mantienen (son sí/no puro, no
  recogían texto). Cero `prompt()` en el archivo.
- Verificado en el navegador: editar sucursal (guarda y vuelve a la lista),
  vista de sucursales de un usuario, y código de revocación (con la semilla
  sembrada). `consola.js` queda en ~555 líneas — un poco sobre el límite de 500,
  pero partir el cierre compartido costaría más de lo que aporta.

Las tres pasadas de UI se mergearon en un solo PR **#30** (`main` `20a65a8`) el
2026-08-28.

---

## F2b — CERRADA

Toda la fase (PRs **#21–#30**) está en `main`. Consola de administración en la
nube completa: `src/admin/` (14 archivos TS + `consola.html`/`consola.js`),
`npm run admin`. Migraciones **0034–0038** aplicadas a nube y local.

| Slice | Qué | PRs |
|---|---|---|
| Roadmap | fase F2b añadida a `04-riesgos-roadmap.md` | #21 |
| 1 | `auth_local.credencial` → clase A (0034); `escribirConfig`; servidor + Supabase Auth (JWT HS256); `POST /api/config/:tabla` | #22, #23 |
| 2 | sucursales; `auth_local.revocacion_hotp` → clase A (0035); semilla HOTP al alta | #24 |
| 3a | usuarios / accesos / credencial temporal Argon2id | #25 |
| 3b | capa 3 de revocación HOTP (0036): `src/auth/{hotp,revocacion}.ts`, `POST /auth/revocar`, paso `revocado` en el login | #26 |
| 4 | impresora / ticket / tarifas | #27 |
| deuda | rol Postgres `donaji_consola` (0037); `rbac.puede()` filtra `activo`; GUC `donaji.forzar_nube` de pruebas (0038) | #28 |
| doc | marcas de merge en el historial | #29 |
| UI | `consola.html`/`consola.js`: 5 pestañas con listado + alta + edición inline + acciones | #30 |

**Lo único pendiente es de despliegue**, no de código:
`ALTER ROLE donaji_consola WITH LOGIN PASSWORD '...'` en Supabase, y en el entorno
de la consola: `ADMIN_DATABASE_URL` (→ ese rol), `SUPABASE_JWT_SECRET`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_EMAILS`.

Arrastres registrados: P7 (mecanismo de acceso del sistema externo de reportes)
sigue abierto — la consola trae su propia auth y no depende de él. P12 (zona
horaria de las 4 sucursales) fija la hora exacta de la ventana nocturna; hoy
`America/Mexico_City` por defecto.

---

## Sesión 36 — 2026-08-28 · Cierre de los 6 defectos del motor de sync

Los seis defectos que vivían fijados en verde con pruebas `DEFECTO VIGENTE` en
`tests/sync/{caos-perdida,caos-reintentos}.test.ts`. Cada prueba traía una nota
`AL CORREGIR: … invertir`. Se hicieron los seis. Rama `fix-defectos-sync`.

### Tanda 1 — identidad, folios y FK (D4, D5, D6)

- **`0039_bootstrap_robusto.sql`** (D4):
  - `core.tipo_unidad.id` deja de ser `DEFAULT core.uuid_v7()` y pasa a derivarse
    de la `clave` con `md5('core.tipo_unidad:' || clave)::uuid` + trigger
    `core.trg_tipo_unidad_id` (mismo patrón que `rol_permiso` 0012 / `parametro`
    0013). `UPDATE` de convergencia: nube y local tenían ids aleatorios distintos
    para la misma Sprinter; ahora convergen sin insertar ni borrar. Ninguna FK
    apunta todavía a `tipo_unidad` (unidad/salida vacías), así que reescribir la
    PK en sitio es seguro.
  - `sync.ingest_batch` (parte de 0010): una `unique_violation` que NO es traslape
    de asiento se archiva como `folio_duplicado`/`alta`, no `sobreventa`/`critica`.
- **`src/sync/bootstrap.ts`** (D4): aborta también ante `estado = 'conflicto'`, no
  solo `rechazada` — un choque de unicidad durante el bootstrap no se resuelve
  reintentando y, si se ignora, afloraba niveles después como FK rota en
  `core.salida`.
- **`0040_fks_deferrables.sql`** (D6): bloque `DO` que declara las 69 FK de `core`
  `DEFERRABLE INITIALLY IMMEDIATE`. El comportamiento por defecto no cambia; el
  `SET CONSTRAINTS ALL DEFERRED` de `bootstrap.ts` por fin difiere de verdad.
- **`src/sync/bootstrap.ts`** (D5): `rehidratarFolios(node, cloud)` tras el COMMIT
  de la copia — por cada `core.folio_secuencia` local, consulta `max(folio)` de la
  nube para el prefijo de esa sucursal, lo decodifica del base32 sin ambiguos de
  0006 y pone `siguiente = usado + 1 + 100` (margen para folios en vuelo). Sin
  migración: `folio_secuencia` **sigue sin replicarse** (0012 lo prohíbe con
  razón); solo se rehidrata al instalar. R13 vuelve a ser cierto.

### Tanda 2 — el sello HLC (D1, D2, D3), `0041_hlc_sin_candado.sql`

Los tres se tocan y no admiten parches sueltos. Rediseño:

- `sync.hlc_estado.ultimo_ts` es ahora un **piso observado**. `sync.hlc_siguiente()`
  solo lo **lee** (sin lock — **D2**: antes el `UPDATE` de esa fila única
  serializaba toda escritura de `core` hasta el COMMIT del llamador).
- Contador desde la secuencia `sync.hlc_seq` (`nextval` sin lock, cicla en
  INT_MAX). `hlc_cnt` deja de reiniciarse; el orden total `(hlc_ts, hlc_cnt,
  origen)` se mantiene porque los tres campos viajan intactos (0014) y
  `arbitraje.ts` ya usa `origen` de desempate.
- **Deriva acotada** (**D3**), parámetro `hlc_deriva_max_seg` (300 s):
  `hlc_siguiente` nunca sella más de ese margen por delante del piso ni del reloj
  de pared; una excursión queda topada en vez de dispararse para siempre, y al
  corregir NTP el sello vuelve solo a la hora real. `hlc_observar` acota igual el
  piso: un remoto disparado no lo envenena y uno envenenado se sana. El clamp abre
  una excepción `deriva_reloj` (`sync.registrar_deriva_reloj`, dedup, solo en un
  nodo).
- **`hlc_observar` cableada** (**D1**) en `sync.ingest_fila`: tras aplicar (o
  ignorar por HLC) una fila replicada, avanza el piso. Sirve en los dos lados
  (pull del nodo, push a la nube). Existía desde 0001 sin llamador.
- `GRANT USAGE ON SEQUENCE sync.hlc_seq TO donaji_consola` (0037 le da `EXECUTE`
  sobre `hlc_siguiente`).

### Pruebas

Las 6 `DEFECTO VIGENTE` reescritas para afirmar el comportamiento correcto:
FK diferibles + inserción hijo-antes-que-padre bajo `SET CONSTRAINTS DEFERRED`;
el piso HLC absorbe un skew razonable y acota uno absurdo (+ `deriva_reloj`);
una excursión queda topada en la deriva máxima (+ `deriva_reloj`); una
transacción abierta sobre `core` no bloquea otra fila; el bootstrap con seeds
converge sin colisión de identidad; la terminal reinstalada rehidrata folios y
sube sin conflicto.

Migraciones 0039–0041 aplicadas a **nube y local**. `tsc` limpio. `npm test`
completo (con `f1-criterios` contra Supabase real, 15/15): **54 archivos, 500
verdes, 1 `it.todo`, 0 rojas.** Mergeado a `main` (PR #32, merge `bcac125`).

---

## Sesión 37 — 2026-08-28 · Seed de QA para el inicio de sesión

QA necesitaba probar login con usuarios y sucursales reales. El módulo existe
—la consola de F2b (`src/admin/`)— pero escribe en la nube y necesita despliegue
+ sync para llegar a un nodo. Se optó por un seed local (como `sembrar-admin.ts`).

- **`scripts/sembrar-qa.ts`** (`npm run seed:qa`, `--target nube`, `--sucursal N`):
  3 sucursales (códigos `1`/`2`/`3` — no chocan con los que hardcodean las
  pruebas de `tests/admin/`) y 6 usuarios que cubren cada caso del login:
  administrador en las 3 (picker de 3), gerente/vendedores atados a una
  (sesión directa), un vendedor multisucursal (picker sin ser admin) y uno sin
  sucursal (login rechazado `sin_sucursal_activa`). Idempotente: reactiva lo que
  un test haya dado de baja, refresca hashes, y ajusta las asignaciones
  `usuario_sucursal` al conjunto deseado. Contraseña `donaji-qa` (o `QA_PASSWORD`).
  Fija `sync.nodo.sucursal_id` a la sucursal `1` (Oaxaca) por defecto.
- **`scripts/limpiar-dev.ts`**: el `pretest` ahora también vacía
  `auth_local.sesion` y `auth_local.intento`. Un login manual dejaba sesiones
  abiertas que `tests/config/aplicador.test.ts` contaba en su pasada global
  (fallo de 6 pruebas destapado por el seed).
- Decisión (con el usuario): el login **no** se restringe a la sucursal del nodo
  —devuelve todas las asignadas al usuario, como dice el blueprint §1.3—; el
  administrador "ve todas" desde la consola/tablero en nube, no desde la terminal.
- Verificado: los 6 escenarios de login dan el resultado esperado. `npm test`:
  **54 archivos, 500 verdes, 1 `it.todo`** (una prueba de cadencia del motor es
  flaky bajo carga; pasa en aislamiento).

---

## Sesión 38 — 2026 · F2c: un solo frontend (la SPA absorbe la consola de admin)

QA no podía completar las pruebas de login: el header mostraba el UUID de la
sucursal en vez del nombre, no había forma de cambiar de sucursal, y los usuarios
/ sucursales dados de alta con `seed:qa` no se veían en ningún lado — su CRUD
vivía en OTRA app (la consola de F2b, `npm run admin`, `consola.html`, login con
Supabase Auth). El usuario pidió unificar: un administrador llega a la PC de una
sucursal, inicia sesión en la MISMA app, edita configuración (que se guarda en la
nube para que las demás sucursales la vean al sincronizarse) y cierra sesión.
Rama `fe-admin-unificada`.

### Fase 1 — header + cambio de sucursal

- `src/auth/sesion.ts`: `sucursalesDe(node, usuarioId, ahora)` (lo reusa
  `login.ts` paso 4); `seleccionarSucursal` acepta `permitirCambio`.
- `GET /auth/me` devuelve `sucursalNombre` + `sucursales`. Nuevo
  `POST /auth/cambiar-sucursal`: cambia entre las asignadas; **409 si hay un corte
  de caja abierto** en la sucursal actual.
- `web/`: el header muestra el nombre de la sucursal y, si hay >1, un selector.

### Fase 2 — sección "Administración" en la SPA

- **`src/api/rutas/admin.ts`**: monta bajo `/admin` los handlers de dominio de
  `src/admin/` (`sucursales`, `usuarios`, `tarifas`, `impresion`, `revocacion`,
  `escribirConfig`) **sin cambios** — reciben un `Consultable`, se les pasa la
  conexión a la NUBE. Autorización: la **sesión local** del admin (`exige` +
  `rol='administrador'`), NO Supabase JWT. `GET /admin/salud` sondea la
  disponibilidad; sin nube todo `/admin` salvo `/salud` responde 503.
- `src/api/{server,main}.ts`: pool opcional a la nube desde `ADMIN_DATABASE_URL`
  ?? `DATABASE_URL`, verificado con `sync.nodo.es_nube` al arrancar (mejor
  esfuerzo — la terminal arranca igual si no hay).
- **`web/src/paginas/admin/`**: 5 pantallas React (Sucursales, Usuarios,
  Impresoras, Ticket, Tarifas) con listado + alta + edición inline + widget de
  modo de propagación, portadas de `src/admin/consola.js`. `AdminLayout` con
  sub-nav y banner "sin conexión". Nav "Administración" en el `Shell`, visible
  solo con los permisos `config.*`.
- **Retirado**: `src/admin/{servidor,auth-supabase,consola.html,consola.js,
  main}.ts`, `npm run admin`, y las pruebas HTTP de `tests/admin/*` que usaban
  `construirServidorAdmin` + `firmarTokenSupabase` (`tests/admin/servidor.test.ts`
  entero; los bloques "por HTTP" de sucursales/usuarios/config/revocacion). La
  cobertura HTTP la toma `tests/api/admin.test.ts`. Los módulos de dominio y sus
  pruebas quedan intactos.
- **Supabase Auth eliminado del proyecto.** Blueprint 03 §1.1 y 04 §F2b
  actualizados.

### Seed de QA — ahora contra la NUBE

Con la sección Administración leyendo de la nube, un `seed:qa` solo-local queda
"desconectado" (no se ve en Administración, `reconcile` marca divergencia). Se
corrigió:

- **`scripts/sembrar-qa.ts`** ahora escribe en la **nube** por defecto (ahí los
  triggers `trg_cambio_log` publican). El nodo local recibe los datos con
  `npm run api` corriendo (pull) — el script deja `sync.nodo.sucursal_id`
  apuntando a la sucursal `1` de una vez (la fila baja después, no hay FK).
  `--target local` sigue disponible pero avisa que es modo desconectado. A
  `admin@donaji.local` (compartido con `sembrar-admin`) solo se le SUMAN las 3
  sucursales, no se le quita ninguna.
- **`scripts/limpiar-qa.ts`** (`npm run limpiar:qa`): borra el escenario de QA de
  la nube Y de local (5 usuarios `@donaji.local`, 3 sucursales `1`/`2`/`3`, sus
  credenciales/sesiones/asignaciones/folios/HOTP), y en la nube también las filas
  de `sync.cambio_log` de esas entidades. No toca `admin@donaji.local`.

### Fase 3 — autoría de rutas y horarios (rama `admin-rutas-horarios`)

Sin migración: las 4 tablas (`core.ruta`, `ruta_parada`, `horario`,
`horario_parada`) ya son clase A (`registrar_entidad` + `publicar_a_nodos`,
0004/0008). Se evitó `escribirConfig` (mal encaje para tablas estructurales
multi-fila): las inserciones compuestas van en **una sentencia con CTEs**
(`WITH r AS (INSERT ruta …), p AS (INSERT ruta_parada …)`) — atómicas y sin pedir
un `Client` del pool; cada `INSERT` publica igual por `trg_cambio_log`.

- **`src/admin/horarios.ts`**: `crearRuta({nombre, sucursalIds})` (≥2, distintas),
  `editarRuta`, `darDeBajaRuta`, `listarRutasDetalle` (ruta + paradas con
  `ruta_parada_id`); `crearHorario({rutaId, horaSalida, diasSemana, conductorId?,
  unidadId?, vigenteDesde?, vigenteHasta?, pasos})`, `editarHorario` (parcial),
  `darDeBajaHorario`, `listarHorarios`, `listarConductores`, `listarUnidades`.
- **`src/admin/rutas-horarios.ts`** + registrada en `src/api/rutas/admin.ts`
  (`/admin/rutas-detalle`, `/admin/horarios`, `/admin/conductores`,
  `/admin/unidades`).
- **`web/src/paginas/admin/Horarios.tsx`**: lista de rutas con "nueva ruta"
  (nombre + lista ordenada de sucursales) y, por ruta, sus horarios + "nuevo
  horario" (hora, días como toggles, conductor/unidad opcionales, vigencia, hora
  de paso por parada). Nav "Rutas y horarios" (`config.horarios`).
- Aviso en la UI: cambiar una ruta/horario **no** re-materializa salidas ya
  creadas (D-7); el job nocturno toma los cambios para las futuras.
- `tests/api/admin.test.ts` +2 (crear ruta + horario; rechazo de ruta de 1 parada).

`tsc` limpio (raíz + `web/`), `vite build` OK. `npm test`: **54 archivos, 480
verdes, 1 `it.todo`, 0 rojas**.

**Despliegue**: la consola ya no necesita despliegue propio; para escribir
config en producción, `src/api/` (la terminal) necesita `ADMIN_DATABASE_URL`
(rol `donaji_consola`, `ALTER ROLE … LOGIN PASSWORD` en Supabase) o cae a
`DATABASE_URL`.

---

## Sesión 39 — 2026-08-29 · El pull no bajaba nada: bloqueado por una entrada obsoleta

QA corrió `seed:qa` (→ nube) y los datos locales no coincidían con la nube.
Diagnóstico: **el pull estaba atascado desde el 29-08 07:42** en `sync.cambio_log`
seq 33 — una entrada vieja de `core.tipo_unidad` con el `id` ALEATORIO de antes de
0039. El nodo ya tiene la Sprinter con el `id` determinista (`md5(...)`), así que
aplicar la entrada vieja por `id` crea un duplicado del `clave` (`UNIQUE`) →
`conflicto`. `pull.ts` DETIENE el cursor en la primera fila que no aplica y no
avanza — pensado para un rechazo por FK que el siguiente ciclo resuelve. Pero un
`conflicto` de clase A nunca se resuelve reintentando (el nodo no gana la clase
A), así que el pull quedaba muerto y NADA posterior (incluido el escenario de QA)
bajaba. Rama `fix-pull-clase-a-obsoleto`.

- **`src/sync/pull.ts`**: una fila de **clase A** en `conflicto` (choque de
  unicidad) ya NO bloquea — se **omite** (nuevo estado `omitida`, contador
  `PullResult.omitidas`), se abre una excepción `divergencia_checksum` (severidad
  **media**, deduplicada por tabla) y el cursor avanza. La nube es la autoridad de
  la clase A; una publicación posterior trae el estado bueno (0039 lo hizo). Un
  rechazo por FK (`rechazada`) sigue bloqueando como antes.
- **`scripts/sembrar-qa.ts`**: con `--target nube` y `LOCAL_DATABASE_URL`, ahora
  también hace un **`bootstrap(local, nube)`**: copia el estado ACTUAL de la nube
  (ids deterministas) y deja el cursor en el `max(seq)` de ese momento, así el
  nodo se salta TODO el `sync.cambio_log` histórico de la PoC —lleno de entradas
  obsoletas que referencian ids muertos— y solo procesa lo nuevo. Es la
  preparación que un nodo real hace al instalarse. Sustituye al viejo
  `fijarNodoLocal`.
- **`src/sync/pull.ts` (2ª parte)**: además del `conflicto` de clase A, un
  **rechazo por FK** que ya lleva `GRACIA_BLOQUEO_MIN` (10 min) atascado en la
  MISMA fila se omite también (para cualquier tabla que baje por pull — todas son
  autoridad de la nube). Un rechazo por FK legítimo se resuelve en uno o dos
  ciclos; si tras 10 min sigue igual, es cruft que referencia un id muerto. Al
  omitir se marca `resuelta` la excepción `rechazo_ingesta` previa y se abre una
  `divergencia_checksum`.
- **`scripts/limpiar-dev.ts`**: el `pretest` **ya NO resetea `sync.cursor`**.
  Resetearlo obligaba al pull a re-procesar todo el `cambio_log` histórico y
  dejaba el nodo de dev atascado en cada `npm test`. La suite usa nodos
  desechables, no ese cursor.
- **`scripts/sanear-nube.ts`** (`npm run sanear:nube [-- --aplicar]`): borra del
  `sync.cambio_log` de la nube las entradas HUÉRFANAS —`fila_id` que ya no existe
  como fila en su tabla— por cada tabla de clase A. Dry-run por defecto. En la
  Supabase compartida son ~392 (usuario, ruta, horario, salida, tipo_unidad).
- **`tests/admin/{sucursales,escribir-config,revocacion,rol-consola}.test.ts`**:
  dejaron de hardcodear los códigos de sucursal (W/X/Y/Z); piden los LIBRES a la
  base o dejan que `crearSucursal` auto-asigne. Un `bootstrap` (o pruebas en
  paralelo) puede tener cualquier código ocupado.
- `tests/sync/caos-perdida.test.ts` +2: un `conflicto` de clase A se omite; un
  bloqueo por FK envejecido se omite y el pull sigue.
- Limpieza puntual de la base local de dev (sucursales V/W/X/Y y cruft de
  ruta/horario/salida que un bootstrap de prueba copió de la nube).

### Segunda pasada — el motor SÍ sincroniza, pero el tablero lo mostraba "atascado"

QA reportó "outbox atascado" y una config nueva (ruta + horario + tarifa) que "no
aparece en ventas". Diagnóstico contra la base viva: **el motor está al día** —
cursor local = `max(seq)` de la nube; la ruta, los dos horarios (uno vigente, el
otro creado y dado de baja) y la tarifa bajaron correctos e idénticos. Dos
espejismos y una confusión de flujo:

- **`src/api/rutas/sync.ts` + `src/sync/salud.ts`**: el conteo de `outbox
  atascado` era `estado = 'rechazado' OR intentos >= 5`. Una fila **`confirmado`**
  con muchos `intentos` (reenvíos absorbidos por idempotencia, o cruft de
  `core.tipo_unidad` de antes de 0032) contaba como atascada **para siempre**. Se
  añade `estado <> 'confirmado'` a la guarda. Prueba en `tests/api/sync.test.ts` y
  `tests/sync/motor-pendiente.test.ts`.
- **`src/sync/pull.ts`**: al arrancar, resuelve toda excepción `rechazo_ingesta`
  `abierta` cuyo `seq` ya quedó por debajo del cursor. Un `bootstrap` (o un ciclo
  posterior que sí aplicó la fila) deja esas excepciones huérfanas —`abierta`
  eternamente— y el tablero muestra una terminal bloqueada que está al día. Prueba
  en `tests/sync/caos-perdida.test.ts`.
- **"No aparece en ventas" no es sincronización.** `core.buscar_salidas` lee
  `core.salida` (materializada), no `core.horario`. No había NINGUNA salida
  materializada, y `core.materializar_salidas` solo procesa horarios **con
  conductor** (D-7: sin conductor no hay tipo de unidad ni mapa). El horario nuevo
  no tiene conductor y en la nube no hay conductores ni unidades sembrados.
  Además el horario y la tarifa son `vigente_desde 2026-09-01`. Para verlo en
  ventas: sembrar flota, asignar conductor al horario y correr `npm run
  materializar` para fechas ≥ 01-09.

`tsc` limpio. `npm test`: **verde** (`tests/api/sync.test.ts`,
`tests/sync/motor-pendiente.test.ts`, `tests/sync/caos-perdida.test.ts` incluidos).

**Para QA**: `npm run seed:qa` (hace el bootstrap solo) → `npm run api` (el motor
al reiniciar resuelve la excepción huérfana). Opcional: `npm run sanear:nube --
--aplicar` limpia el `cambio_log` histórico de la nube.

---

## Sesión 40 — 2026-08-29 · SPA: menú lateral colapsable + sistema de diseño

Petición: que el menú lateral se pueda colapsar y que los componentes no luzcan
tan genéricos. Solo `web/` — sin tocar backend ni datos. Rama
`ui-menu-colapsable`.

- **`web/tailwind.config.js`**: paleta de marca `brand` (teal, `brand-600
  #1b766e`, `brand-950 #082726`), `arena` (cálidos), `lienzo #f6f5f2`, `tinta
  #1c2523`; `borderRadius.xl`, sombras `tarjeta`/`panel`.
- **`web/src/index.css`**: capa de componentes — `.btn` + variantes
  (`.btn-primario`, `.btn-fantasma`, `.btn-peligro`, `.btn-sutil`), `.campo` /
  `.campo-sm` (inputs), `.tarjeta`, `.chip` + estados
  (`chip-ok`/`baja`/`alerta`/`error`), anillo de foco accesible.
- **`web/src/componentes/ui.tsx`** (nuevo): primitivos —
  `Boton`, `Tarjeta`, `EncabezadoPagina`, `Campo`, `CampoSelect`, `Chip`,
  `Tabla<T>`, `Aviso`, `Cargando`.
- **`web/src/componentes/iconos.tsx`** (nuevo): iconos SVG en línea (sin
  dependencia — la terminal opera offline), uno por sección del nav.
- **`web/src/componentes/Shell.tsx`**: `<aside>` colapsable `w-60` ↔ `w-16`,
  estado en `localStorage` (`donaji.nav.colapsado`); iconos + tooltip al
  colapsar; grupos "Operación" / "Administración"; sidebar teal oscuro; header
  con chip de rol y selector de sucursal reestilizado.
- **`Login.tsx`, `ElegirSucursal.tsx`, `admin/AdminLayout.tsx`** y el resto de
  páginas: fondo `lienzo`, tarjetas con borde suave y sombra, tablas con
  encabezado en versalitas y `hover` de fila, botones/inputs/chips a las nuevas
  clases. Steppers y selección de asiento en `Vender` pasan a teal.

`tsc` limpio en `web/`, `vite build` OK (CSS 27.35 kB). Sin cambios de lógica ni
de rutas API.

---

## Sesión 41 — 2026-08-29 · seed:qa siembra un viaje vendible

QA creó una ruta + horario + tarifa por la sección Administración y en la
búsqueda de boletos no aparecía nada. Diagnóstico: **la sincronización estaba
bien** (cursor local = máx. de la nube; ruta/horario/tarifa idénticos en ambos
lados). `core.buscar_salidas` lee `core.salida` (materializada), no `core.horario`,
y la cadena estaba cortada en el primer eslabón: el horario **no tenía conductor**
(y `core.materializar_salidas` lo exige, D-7), y **no había ningún conductor ni
unidad** en el sistema — `seed:qa` solo sembraba sucursales y usuarios. Rama
`qa-viaje-vendible`.

- **`scripts/sembrar-qa.ts`**: nueva función `sembrarViajeVendible` (dentro de la
  tx del seed). Con ids fijos `d0d0da01-…` (idempotente por `ON CONFLICT (id)`):
  unidad `QA-01` (SPRINTER-18, que ya trae el seed de esquema), conductor
  "Conductor QA", ruta "QA Oaxaca-Puebla" (Oaxaca 0 → Puebla 1) con sus paradas,
  horario 07:00 **con conductor** vigente desde hoy + `horario_parada`, tarifa
  0→1 $650 vigente desde ya. Luego llama a `core.materializar_salidas(horario,
  30)` — 31 salidas. Contra la nube, cada INSERT publica por `trg_cambio_log` y
  el `bootstrap` del final las copia; el nodo las ve en el pull.
- **`scripts/limpiar-qa.ts`**: `limpiarViajeVendible` borra el viaje de ids fijos
  y todo lo que cuelga de sus salidas (venta/boleto/pago/lease/ocupación/evento/
  cupo/cambio_conductor). Las 3 sucursales de QA ahora se **DESACTIVAN**
  (`activo=false`) en vez de borrarse — una venta/corte/ruta hecha a mano contra
  ellas rompía el `DELETE` por FK; desactivarlas es lo que hace la app y
  `re-seed:qa` las reactiva por `ON CONFLICT (codigo)`.
- Notas de esquema: `unidad`/`conductor`/`ruta`/`ruta_parada`/`horario_parada`
  usan `activo` + `desactivado_*` (sin `effective_until`); `horario`/`tarifa`
  tienen ambos.
- Verificado end-to-end contra la base local: `seed:qa` → `buscar_salidas`
  (Oaxaca→Puebla, 2 pax) devuelve la salida con importe $650, 18 asientos,
  `seleccionable=true`; `seed:qa` de nuevo → "0 nuevas, 31 ya estaban";
  `limpiar:qa` deja limpio y repetible.

**Para QA**: `npm run seed:qa` → `npm run api` → en Vender, Oaxaca Centro →
Puebla, cualquier fecha desde hoy.

---

## Sesión 42 — 2026-08-29 · seed:qa reventaba en el bootstrap por ids divergentes

Al correr `npm run seed:qa` (nube): `sembrar()` de la nube OK, pero
`prepararNodoLocal` → `bootstrap(local, nube)` reventaba con
`Bootstrap en conflicto en core.usuario: usuario_email_key`. Causa: un
`seed:qa --target local` anterior había creado `gerente@`, `vendedor.oax@`, etc.
en LOCAL con ids generados en local; la nube les dio OTROS ids. El bootstrap copia
por `id`, así que al insertar el usuario de la nube chocaba contra el mismo
`email` (UNIQUE) con id distinto → `conflicto` → abortaba. Y realinear caso por
caso no escala: `usuario_sucursal` tiene su propia clave natural, `credencial` la
suya, etc. Rama `qa-bootstrap-reset`.

- **`scripts/sembrar-qa.ts`**: `prepararNodoLocal` ahora, ANTES del bootstrap,
  **vacía por completo** el nodo local — `TRUNCATE ... CASCADE` de cada tabla de
  `core.*` y `auth_local.*` (un `DO $$` sobre `pg_tables`). La clase A del nodo es
  por diseño una copia de la nube; `seed:qa` prepara un entorno de PRUEBA, así que
  las ventas/cortes locales son desechables. El `bootstrap` reconstruye todo desde
  la nube — exactamente lo que hace una terminal al reinstalarse. `sync.*` (nodo,
  cursor, hlc) no se toca: no tiene FK a `core`/`auth_local`.
- Verificado: TRUNCATE + `bootstrap` copia 93+ filas de config + 31 salidas del
  viaje; los usuarios locales quedan con el id de la nube; `buscar_salidas`
  Oaxaca→Puebla devuelve la salida ($650, 18 asientos, `seleccionable`).

**Para QA**: `npm run seed:qa` ahora completa. La base local queda como copia
exacta de la nube.

---

## Sesión 43 — 2026-08-29 · Módulo de flota: unidades y conductores en Administración

Se preguntó si el CRUD de conductores debía llevar la unidad embebida o si eran
altas separadas. Resolución (grounded en `0003_core_flota.sql` y `02-modelo-datos
§3-4`, P11/D-7): **dos catálogos separados**, `conductor → unidad → tipo_unidad →
mapa`. `conductor.tipo_unidad_id` es NOT NULL (el conductor es el portador del
mapa); `conductor.unidad_habitual_id` es opcional y, si se da, su tipo debe
coincidir (trigger `validar_conductor_unidad`). La "asociación con la unidad" es
un campo del formulario de conductor, no una entidad combinada. `tipo_unidad`
queda solo-lectura (el mapa se siembra por SQL). Rama `admin-flota`.

- **`0042_permiso_config_flota.sql`**: permiso `config.flota` (rol
  administrador) + `GRANT INSERT, UPDATE ON core.unidad, core.conductor TO
  donaji_consola` (el rol acotado de 0037 solo tenía SELECT amplio).
- **`src/admin/flota.ts`**: `listarTiposUnidad`, `listar/crear/editar/darDeBaja`
  Unidad y Conductor. `core.unidad` y `core.conductor` NO tienen
  `effective_from/until` → todo va modo `inmediato` (como `config_impresora`); el
  trigger estándar pone `desactivado_en` al `activo=false`. `validarCadena`
  chequea la coherencia tipo↔unidad antes de que reviente el trigger.
- **`src/admin/rutas-flota.ts`** → registradas en `src/api/rutas/admin.ts`:
  `/admin/{tipos-unidad, unidades-detalle, unidades[/:id[/baja]],
  conductores-detalle, conductores[/:id[/baja]]}`.
- **`core.unidad`, `core.conductor`** sumadas a `TABLAS_ADMINISTRABLES`.
- **`web/`**: `paginas/admin/{Unidades,Conductores}.tsx` (patrón de
  `Usuarios.tsx`; el select de unidad habitual se filtra por el tipo elegido),
  cliente en `api/admin.ts`, nav en `Shell.tsx` (`config.flota`) y sub-nav en
  `AdminLayout.tsx`, iconos `unidades`/`conductores`.
- `tests/api/admin.test.ts` +1 (alta de unidad + conductor asociado, dup de nº
  económico → 400, baja). `tsc` raíz y `web/` limpios, `vite build` OK.
- Verificado en el navegador contra la nube: las dos pantallas listan la flota
  de QA y el alta de una unidad nueva se escribe y aparece en la tabla.

**Despliegue**: `npm run db:migrate:nube` para 0042 (permiso + grants).

---

## Sesión 44 — 2026-08-30 · El horario nuevo se materializa solo al guardarlo

Se creó una ruta con parada intermedia (`HJP - Inter - PU`: Oaxaca → Terminal
Dev → Puebla) + su horario con conductor, y en Vender no aparecía. Validado
contra la base viva: **la consulta está bien** — ruta y horario correctos y
sincronizados; `core.buscar_salidas` lee `core.salida` (materializada) y **no
había ninguna** porque nunca se corrió `npm run materializar`. Materializar ese
horario a mano (probado en local, tx revertida) → 8 salidas → `buscar_salidas
Oaxaca → Terminal Dev` devuelve la salida de las 08:00, `seleccionable`.

Petición del usuario: **un cambio en el FE no debe exigir correr nada aparte** —
la configuración de horarios se hace en la ventana acordada con las terminales
para que al día siguiente ya se pueda vender.

- **`src/admin/horarios.ts`**: `crearHorario` y `editarHorario`, cuando el
  horario resultante tiene conductor, llaman a `materializarHorario` (horizonte
  completo) **ahí mismo, contra la nube**. `core.materializar_salidas` es
  idempotente (`ON CONFLICT (horario_id, fecha_operacion) DO NOTHING`): en un
  edit solo agrega días que falten, no toca las salidas ya congeladas (D-7). Si
  el horario aún no está vigente, se guarda igual y se devuelve
  `avisoMaterializacion` (el job nocturno lo retomará) — no revienta.
- **`ResultadoHorario`** ahora trae `salidasCreadas` y `avisoMaterializacion`.
  `rutas-horarios.ts` los propaga; `Horarios.tsx` muestra "N salidas generadas".
- El job `npm run materializar` **sigue** para el barrido diario (empujar el día
  91 del horizonte, horarios que ganan conductor por otra vía).
- `tests/api/admin.test.ts` +1 (horario con conductor → `salidasCreadas > 0` y
  las filas existen en `core.salida`). `npm test`: 54 archivos, 485 verdes.

**Para el horario ya creado sin materializar**: `npm run materializar` una vez
(o re-guardar el horario). Los que se creen de ahora en adelante ya no lo
necesitan.

---

## Sesión 45 — 2026-08-30 · El pull se atascaba en cientos de cupo_offline huérfanos

`npm run materializar` corrió, las tarifas se dieron de alta, pero la ruta
seguía sin verse. Diagnóstico contra la base viva: **el pull estaba 782 entradas
atrás** (cursor local 1725, `max(seq)` de la nube 2507) y con una excepción
`rechazo_ingesta` abierta en `core.cupo_offline` seq 1726 — "el pull no avanza
hasta resolverlo". Todo lo nuevo (salidas del horario, tarifas) estaba parado
detrás.

Causa raíz: la suite de caos (`tests/sync/`, prefijo `019caa5f-`) crea datos en
la Supabase compartida, publica por `trg_cambio_log`, borra los `core.*` — **pero
no las entradas del `cambio_log`** —, y `repartir_cupo_offline` genera ids nuevos
cada corrida. Se acumularon **~700 entradas huérfanas** (285 `cupo_offline`, 104
de cada `salida`/`horario`/`ruta`/`usuario`). El motor las saltaba una por una
tras la gracia de 10 min → días para drenar.

- **`src/sync/pull.ts`**: un `conflicto` por **choque de unicidad** durante el
  pull se omite **al toque, de cualquier clase** (antes: solo clase A, y las
  demás tras 10 min). El pull es la dirección autoritativa — si una constraint
  única rebota la versión de la nube, la fila LOCAL es la obsoleta y reintentar
  nunca sirve. Un `exclusion_violation` (la invariante de asiento) SÍ sigue
  bloqueando: es el conflicto genuino de clase D que se arbitra.
- **`scripts/sanear-nube.ts`**: ya no se limita a las tablas de clase A —
  recorre TODA tabla que aparezca en `sync.cambio_log` y tenga columna `id`, y
  purga las entradas cuyo `fila_id` ya no existe. Dry-run: 705 huérfanas.
- **`tests/sync/harness.ts`** `limpiarNube`: borra también su `sync.cambio_log`
  (por prefijo y por payload) para no dejar huérfanos en cada corrida.
- **`scripts/limpiar-dev.ts`**: el `pretest` barre también el prefijo `019caa5f-`
  (solo en local — la base de dev lo hereda por pull de la Supabase compartida).
- `tests/sync/caos-perdida.test.ts` +1 (choque de unicidad en `cupo_offline` se
  omite en el primer pull, sin gracia). `npm test`: 485 verdes (1 flaky de lease
  por carga, pasa aislada).

**Para desatascar la nube ahora**: `npm run sanear:nube -- --aplicar` (borra las
705). Con el fix de `pull.ts` desplegado, el nodo igual las salta en un ciclo.

---

## Sesión 46 — 2026-08-30 · Pantalla de inicio + no se vende sin corte abierto

QA: no se debe poder vender sin un corte de caja abierto. Al iniciar sesión la
SPA debe llevar a una pantalla de inicio (por ahora, bienvenida; más adelante,
reporte del corte activo), y desde ahí "Vender" — pero si no hay corte, a `/caja`
a abrir el del día.

- **`web/src/paginas/Home.tsx`** (nuevo): "Bienvenido a {sucursal}" + estado del
  corte (abierto → cifras saldo/ingresos/egresos/en-caja; sin corte → aviso ámbar
  + "Abrir corte del día") + accesos a Vender / Caja / Viajes.
- **`App.tsx`**: `index` pasa de `Navigate to /vender` a `<Home />`. `/vender` va
  envuelto en `<RequiereCorte>` — si `GET /caja/corte` da `null`, redirige a
  `/caja` con `state.avisoCorte`. Login y ElegirSucursal ya navegaban a `/`.
- **`Caja.tsx`**: banner ámbar "Para vender boletos primero abre el corte" cuando
  se llega redirigido desde `/vender`.
- **`Shell.tsx`**: ítem "Inicio" al tope del nav (`end` en el `NavLink` para que
  solo esté activo en `/`); icono `inicio` en `iconos.tsx`.
- Sin cambios de backend: `core.registrar_pago` ya exige un corte abierto para
  cobrar (0023/F6); esto es la capa de UX que lo hace obvio antes de empezar.
- `tsc` (`web/`) limpio, `vite build` OK. Verificado en el navegador: sin corte →
  Home ámbar, `/vender` redirige a `/caja`; con corte → Home con cifras, Vender
  entra normal.

---

## Sesión 47 — 2026-08-30 · Asignar conductor a un horario ya creado

Un horario de la ruta "HJP - PU FULL" (09:00) no salía en la búsqueda de ventas.
Diagnóstico: **la consulta está bien** — el horario está sincronizado, pero se
creó SIN conductor, así que `materializar_salidas` lo salta (D-7) y no hay
`core.salida`. La pantalla de Horarios solo tenía alta + baja; no había forma de
asignarle un conductor después.

- **`web/src/paginas/admin/Horarios.tsx`**: cada horario del listado tiene ahora
  "editar" — un formulario inline para asignar/cambiar conductor, unidad y
  vigencia. Los que no tienen conductor se marcan en ámbar "sin conductor — no se
  vende". Al guardar con conductor, `editarHorario` materializa en el acto
  (Sesión 44, idempotente).
- **`web/src/api/admin.ts`**: `editarHorario(id, cambios)` → `PATCH
  /admin/horarios/:id` (ya existía en el backend). `HorarioDetalle` gana
  `conductorId` / `unidadId` para poblar los selectores.
- **`src/admin/horarios.ts`**: `listarHorarios` devuelve además `conductor_id` y
  `unidad_id`.
- `tests/api/admin.test.ts` +1 (alta sin conductor → 0 salidas; PATCH con
  conductor → materializa; el listado trae `conductorId`). `npm test` verde.
- Verificado en el navegador: al asignarle "Conductor QA" al horario de las 09:00
  → "89 salidas generadas".

---

## Sesión 48 — 2026-08-30 · La búsqueda de ventas: ruta + escalas, y no más duplicados

QA en la búsqueda "Oaxaca Centro → Puebla": las filas mostraban "tramo [0,1)",
"[0,3)", "[0,2)" y parecían destinos distintos (son TODAS a Puebla — el número es
el índice de parada DENTRO de cada ruta), y salía "07:00" dos veces.

- **El "07:00" repetido era un bug real**: la ruta "HJP - PU FULL" tenía dos
  horarios de las 07:00, uno **dado de baja** — pero sus 91 salidas seguían
  `programada` y `core.buscar_salidas` no filtraba `h.activo`, así que las ofrecía.
- **`0043_buscar_salidas_con_ruta.sql`**: `core.buscar_salidas` (DROP + CREATE,
  cambia el `RETURNS TABLE`) devuelve además `ruta_nombre`, `origen_nombre`,
  `destino_nombre` y `escalas` (paradas intermedias entre origen y destino).
  Filtra `h.activo AND r.activo`. Limpieza puntual: cancela las salidas futuras
  sin boletos de horarios ya inactivos.
- **`src/admin/horarios.ts`** `darDeBajaHorario`: además de `activo=false`,
  **cancela** (`estado='cancelada'`) las salidas futuras del horario que no
  tengan boletos vendidos (D-7: las que tienen boleto no se tocan). Devuelve
  `{ salidasCanceladas }`.
- **`web/`**: `Vender.tsx` muestra "Oaxaca Centro → Terminal Dev → Puebla · HJP -
  PU FULL" en vez de "tramo [0,2)", en el listado y en el resumen. `Horarios.tsx`
  avisa "N salidas canceladas" al dar de baja.
- `tests/ventas/busqueda.test.ts` +2 (ruta/escalas; horario inactivo no ofrece);
  `tests/api/admin.test.ts` +1 (baja cancela salidas). `npm test`: 54 archivos,
  **489 verdes**.

**Despliegue**: `npm run db:migrate:nube` para 0043 (recrea `buscar_salidas` y
limpia los duplicados existentes).

---

## Sesión 49 — 2026-08-30 · Modal de horas de paso en el detalle del horario

QA: en el listado de horarios se ve hora de salida, días, conductor y vigencia,
pero no la hora de paso por las terminales intermedias. Pidió un modal.

- **`web/src/componentes/ui.tsx`**: nuevo primitivo `Modal` (overlay `fixed
  inset-0`, cierra con Escape o clic en el fondo, `role="dialog"`).
- **`web/src/paginas/admin/Horarios.tsx`**: cada horario con más de dos paradas
  tiene "paradas" — abre el modal con la lista numerada origen → intermedias →
  destino y la hora local de cada una. El dato (`HorarioDetalle.pasos`) ya venía
  del backend; solo faltaba mostrarlo.
- Sin backend, sin migración. `tsc` (`web/`) limpio, `vite build` OK. Verificado
  en el navegador con "HJP - PU FULL" (Oaxaca → Terminal 1 → Terminal 2 →
  Puebla).

---

## Sesión 50 — 2026-08-30 · Buscar un boleto por folio en Viajes

QA pidió buscar en Viajes por folio. Validación del blueprint (02b §1): el folio
NO es un consecutivo numérico — es un STRING de 6 caracteres `[código de
sucursal][contador base32 de 5]`, alfabeto `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
(sin `I L O U`, se dictan por teléfono). `core.boleto.folio` es `char(6) UNIQUE`
con índice `boleto_folio_idx`.

- **`src/fleet/abordaje.ts`**: `normalizarFolio` (mayúsculas, quita espacios/
  guiones, `O→0`, `I/L→1` — símbolos que un folio real nunca tiene) +
  `buscarBoletoPorFolio` (match exacto tras normalizar sobre
  `core.v_checklist_abordaje` + contexto de la salida: origen, destino, hora,
  estado, conductor).
- **`GET /viajes/boleto?folio=`** (`src/api/rutas/viajes.ts`): 404 si no existe.
- **`web/src/paginas/Viajes.tsx`**: caja "Buscar por folio" arriba del listado.
  El resultado muestra el boleto + el viaje, con los botones de abordaje
  (abordó / no se presentó) y "ver viaje completo →" que abre ese viaje.
- `tests/api/viajes.test.ts` +2 (folio case-insensitive trae el viaje; folio
  inexistente o de longitud inválida → 404). `npm test` verde. Sin migración.

---

Los cinco criterios de aceptación verdes contra Supabase real
(`tests/sync/f1-criterios.test.ts`). Contrato de pruebas del motor cerrado
(`salud.ts` Ses. 4, arbitraje/reasignación en F4, checksum dirigido de
`reconcile.ts` Ses. 18, los 12 `it.todo` de `engine.ts` Ses. 19). Los 6 defectos
`DEFECTO VIGENTE` cerrados el 2026-08-28 (migraciones 0039–0041 +
`src/sync/bootstrap.ts` — ver § Sesión 36).

**Único arrastre, movido a F4:** el `it.todo` "catch-up de pull ANTES de vender
fuera de cupo" (`tests/sync/engine.test.ts`) — transversal al módulo de venta: el
motor ya expone `modo` y `ultimaSyncExitosa`; falta que `src/ventas/` consulte esa
señal y bloquee el override de asiento cuando el nodo lleva mucho sin bajar.

## Decisiones abiertas para el arquitecto

- Replicación de `core.asiento_ocupacion` hacia las sucursales (decidir antes de
  F4).
- P7 (mecanismo de acceso del sistema externo de reportes), P8 (umbrales de
  sync), P12 (zona horaria de las 4 sucursales).
- Fijar en el blueprint la región real de Supabase: `us-west-2`, no East US.

## Deuda técnica registrada

- Los archivos de `tests/sync/` miden 600–970 líneas, contra el límite de 500 de
  `CLAUDE.md`. Hay que partirlos.
