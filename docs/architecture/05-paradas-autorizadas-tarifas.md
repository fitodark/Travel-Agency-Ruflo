# 05 · Paradas autorizadas y tarifa por parada — Plan de implementación

> **Estado: BORRADOR — en espera de respuestas del cliente.**
> Fecha de apertura: 2026-09-03 · Blueprint v0.2
>
> Este plan se construyó a partir de dos sesiones con el cliente sobre el flujo real
> de rutas. Hay **decisiones ya fijadas** (§2) que se pueden empezar a construir y
> **preguntas abiertas** (§7) que complementan el plan antes de tocar las fases que
> dependen de ellas. QA pidió expresamente que no se retrabaje: **no arrancar una
> fase cuya pregunta bloqueante siga abierta.**
>
> Memoria de trabajo asociada: `donaji-rutas-paradas-tarifas`.

---

## 1. Contexto

Una ruta (p. ej. `Huajuapan de León → CDMX`) toca dos clases de punto:

- **Terminales** — ascenso + descenso. Son sucursales reales: tienen PC/caja, usuario,
  prefijo de folio, corte de caja, impresora.
- **Paradas autorizadas de solo descenso** — no son terminales. El pasajero solo puede
  **bajar** ahí; nadie asciende, no se venden boletos desde ahí. Ejemplo del cliente:
  *"Parada — Cuautla / referencia — sobre carretera, a la altura del Home Depot"*.

Cada parada autorizada tiene **su propia tarifa** desde la terminal de origen, y esa
tarifa **puede ser mayor** que la de la sucursal destino final.

### Lo que el modelo actual YA soporta

| Requisito | Dónde vive hoy |
|---|---|
| Paradas intermedias ordenadas | `core.ruta_parada (ruta_id, sucursal_id, orden)` |
| Hora de paso por parada | `core.horario_parada` → `core.salida_parada` |
| **Tarifa por par de paradas** | `core.tarifa (ruta_id, parada_origen_orden, parada_destino_orden, importe)` versionada con `effective_from/until` |
| Venta por tramo sin bloquear el asiento aguas abajo | `int4range` en `core.asiento_ocupacion` / `core.cupo_offline` |
| Reparto de cupo offline con peso por parada | `core.ruta_parada.peso_cupo` |

La idea cabe en el esquema sin rediseñarlo. Lo que falta es **modelar la diferencia
terminal vs. parada-solo-descenso** y **cerrar validaciones** que hoy no existen.

### Lo que falta o está mal hoy

1. `ruta_parada.sucursal_id` obliga a que toda parada sea una `core.sucursal`. Eso
   quema `sucursal.codigo` (`char(1)`, techo de 32), exige `direccion_completa` /
   `telefono_principal` NOT NULL, y mete la parada en el CRUD de sucursales, usuarios,
   impresoras y cortes.
2. Nada impide **vender un boleto que "asciende" en una parada de solo descenso**:
   `core.buscar_salidas` y `core.registrar_venta` solo checan `origen_orden < destino_orden`.
3. `core.registrar_venta` **suma a ciegas** el `importe` que manda el cliente; la tarifa
   solo se usa para mostrarla en la búsqueda.
4. `core.tarifa` referencia paradas por `orden` (posición). Insertar una parada a media
   ruta recorre los `orden` y deja las tarifas apuntando al par equivocado.
5. Un asiento cuyo destino es una parada de solo descenso **no se puede revender** para
   el tramo liberado (nadie asciende ahí). Hoy el `int4range` lo liberaría.
6. `core.repartir_cupo_offline` (`0019`) **asume que toda parada intermedia vende** y le
   da un bloque completo (`v_n_intermedias = v_n_paradas - 2`). Con paradas de descenso
   sobre-reparte bloques y puede disparar *"reparto por bloques insuficiente"* sin razón.

---

## 2. Decisiones fijadas (validadas con el cliente)

| # | Decisión | Consecuencia / sujeto a |
|---|---|---|
| **D1** | Catálogo nuevo `core.punto_ruta`. `ruta_parada` y `salida_parada` dejan de apuntar a `core.sucursal` y apuntan a un punto. | Una parada de descenso no consume `sucursal.codigo` ni aparece en CRUD de sucursales/usuarios/caja. |
| **D2** | La bandera ascenso/descenso vive en `punto_ruta.tipo` (`'terminal'` \| `'parada_descenso'`), **global** — no por ruta. | Sujeto a **P-1**. Si una parada puede ser descenso de ida y ascenso de vuelta, la bandera se mueve a `ruta_parada` (contingencia acotada, misma forma). |
| **D3** | El boleto guarda **dos rangos**: `tramos` (viaje: tarifa, impresión, manifiesto) y `tramos_ocupacion` (EXCLUDE, disponibilidad, cupo). | `tramos_ocupacion` = `[origen, destino)` si el destino es terminal; `[origen, n-1)` (hasta el final de la ruta) si es `parada_descenso`. |
| **D4** | `core.registrar_venta` valida el importe contra `core.tarifa` de forma **estricta**: sin tarifa vigente para el par ⇒ rechaza; cada `pasajero.importe` debe igualar la tarifa del tramo. | Interruptor `core.parametro` `validar_tarifa_estricta` (default `true`). Punto de extensión documentado para descuentos (**P-2**). |
| **D5** | Cambiar las paradas de una ruta = **baja + alta**, nunca edición in-place. | Frecuencia ~2 años (P-9). No se re-llavea `tarifa` / `horario_parada` por `ruta_parada_id`. Se mantiene a propósito que no exista "editar paradas de ruta". |
| **D6** | Solo los puntos con ascenso reciben `hora_paso`, `cierre_venta` y cupo offline. Las paradas de descenso tienen fila en `salida_parada` (para resolver destino y tarifa) con `hora_paso_programada = NULL` y `cierre_venta_en = NULL`. | El boleto a una parada de descenso cierra su venta cuando cierra la terminal de origen (P-6). |
| **D7** | El boleto impreso a una parada muestra **nombre de la parada + tarifa**, sin `referencia`. | P-6. |
| **D8** | Los pagos se registran siempre en la sucursal de origen. | El **tercer método de pago** que no suma al corte (P-7) queda **fuera** de estas fases. |

---

## 3. Modelo de datos objetivo

```sql
CREATE TABLE core.punto_ruta (
  id           uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  nombre       text NOT NULL,
  referencia   text,                                  -- no se imprime en el boleto
  tipo         text NOT NULL CHECK (tipo IN ('terminal','parada_descenso')),
  sucursal_id  uuid REFERENCES core.sucursal(id),     -- NOT NULL sii tipo='terminal'
  municipio    text,
  zona_horaria text NOT NULL DEFAULT 'America/Mexico_City',
  CHECK ((tipo = 'terminal') = (sucursal_id IS NOT NULL))
);
SELECT core.registrar_entidad('core.punto_ruta');   -- columnas estándar + outbox
SELECT sync.publicar_a_nodos('core.punto_ruta');    -- clase A: nube → nodos

-- ruta_parada: sucursal_id → punto_id
ALTER TABLE core.ruta_parada  ADD COLUMN punto_id uuid REFERENCES core.punto_ruta(id);
-- salida_parada: sucursal_id → punto_id ; horas nullables
ALTER TABLE core.salida_parada ADD COLUMN punto_id uuid REFERENCES core.punto_ruta(id);
ALTER TABLE core.salida_parada ALTER COLUMN hora_paso_programada DROP NOT NULL;
ALTER TABLE core.salida_parada ALTER COLUMN cierre_venta_en      DROP NOT NULL;

-- boleto / ocupación / lease: rango de viaje + rango de ocupación
ALTER TABLE core.boleto            ADD COLUMN tramos_ocupacion int4range;
ALTER TABLE core.asiento_ocupacion ADD COLUMN tramos_ocupacion int4range;
ALTER TABLE core.asiento_lease     ADD COLUMN tramos_ocupacion int4range;
-- el EXCLUDE de asiento_ocupacion / asiento_lease pasa a operar sobre tramos_ocupacion
```

**Regla de `tramos_ocupacion`** (con `n` paradas, orden `0 … n-1`):

| Destino de la venta | `tramos` (viaje) | `tramos_ocupacion` |
|---|---|---|
| terminal | `[origen, destino)` | `[origen, destino)` |
| `parada_descenso` | `[origen, destino)` | `[origen, n-1)` |

El origen de una venta **siempre** debe ser un punto `terminal` (los `parada_descenso`
nunca originan).

### Cableado de sincronización

- `src/sync/clases.ts` → `'core.punto_ruta': 'A'` en `CLASE_POR_TABLA`.
- `src/admin/escribir-config.ts` → `'core.punto_ruta'` en `TABLAS_ADMINISTRABLES`.
- Los cambios de columna en `ruta_parada` / `salida_parada` se propagan por los
  triggers existentes (`to_jsonb(NEW)`); `sync.ingest_fila` toma solo las columnas que
  el extremo ya tiene (tolera N+1, D-8).
- **Deploy:** migrar nube **y** las 4 terminales en la misma ventana, luego
  `bootstrap`/pull, y recién entonces dar de alta paradas.

---

## 4. Fases de implementación

> Migraciones a partir de `0048`. Cada `CREATE OR REPLACE` se apila sobre la anterior,
> como ya hace el repo (`0021` → `0043` con `buscar_salidas`).

### Fase 0 — Catálogo de puntos y re-cableado estructural  ·  `0048`

- Crear `core.punto_ruta` + wiring de sync.
- Backfill: un `punto_ruta` tipo `terminal` por cada `core.sucursal` activa.
- `ruta_parada.punto_id` y `salida_parada.punto_id`: `ADD COLUMN` → backfill vía el
  mapeo sucursal→punto → `SET NOT NULL`. `UNIQUE (ruta_id, punto_id)`.
  `sucursal_id` queda deprecado; se elimina en `0049`.
- `hora_paso_programada` / `cierre_venta_en` de `salida_parada` → nullables.
- Re-cablear `core.materializar_salidas` (`0018`/`0019`): join por `punto_ruta`
  con `LEFT JOIN core.sucursal`; zona horaria desde `punto_ruta.zona_horaria`.
- Código: `clases.ts`, `escribir-config.ts`, `src/admin/horarios.ts`
  (`listarRutasDetalle`, `listarHorarios`), `src/admin/tarifas.ts` (`listarRutas`).
- Seed nuevo `src/db/seed/0003_puntos.sql` (puntos terminal de las 4 sucursales) para QA.
- **Es refactor puro:** las ~270 pruebas deben pasar sin cambios. Añadir fixture con
  una ruta que incluya un `parada_descenso`.
- **Bloqueante:** ninguno. **Se puede arrancar ya.**

### Fase 1 — Bandera ascenso/descenso en búsqueda y venta  ·  `0049`

- `DROP COLUMN ruta_parada.sucursal_id`, `salida_parada.sucursal_id`.
- `core.buscar_salidas` → `p_origen` / `p_destino` pasan a ser **punto ids**; origen
  debe ser `tipo='terminal'`; destino cualquier punto posterior; join a
  `core.punto_ruta` para nombres y escalas.
- `core.registrar_venta` y `core.adquirir_lease` → `RAISE` si el `orden` de origen es
  un `parada_descenso`.
- Código: `src/ventas/busqueda.ts`, `src/api/rutas/ventas.ts` (querystring
  `origen`/`destino` = punto ids), `web/src/api/catalogos.ts` (`listarPuntos`),
  `web/src/paginas/Vender.tsx` (selector Origen = terminales, Destino = todos los puntos).
- **Bloqueante:** **P-1** (si "sí", la bandera se mueve a `ruta_parada`).

### Fase 2 — Semántica de ocupación del asiento  ·  `0050`

- `ADD COLUMN tramos_ocupacion` en `boleto` / `asiento_ocupacion` / `asiento_lease`;
  backfill `= tramos`; `SET NOT NULL`.
- Reemplazar el `EXCLUDE USING gist (… tramos WITH &&)` por `tramos_ocupacion WITH &&`
  en `asiento_ocupacion` y `asiento_lease`.
- `core.asientos_libres` / `core.asientos_ofrecibles` (`0021`) → `&&` contra
  `tramos_ocupacion`.
- `core.adquirir_lease` y `core.registrar_venta` → calcular
  `hasta_ocupacion = CASE WHEN destino_es_descenso THEN n-1 ELSE destino END`.
- `core.snapshot_boleto` no cambia (sigue leyendo `lower/upper(b.tramos)` = viaje).
- Revisar que `src/api/rutas/ventas.ts` (GET venta) y `web` (Viajes,
  `ModalDetalleBoleto`) muestren `tramos` (viaje), no `tramos_ocupacion`.
- **Bloqueante:** **P-3** (asiento apartado desde el origen vs. desde la parada de
  ascenso — un `CASE` más si el cliente lo pide).

### Fase 3 — Validación de tarifa en la venta  ·  `0051`

- `core.registrar_venta`: resolver `core.v_tarifa_vigente` para
  `(ruta, origen_orden, destino_orden)`; sin tarifa ⇒ `RAISE`; cada `pasajero.importe`
  debe igualar la tarifa.
- Parámetro `validar_tarifa_estricta` (default `true`).
- Punto de extensión: con catálogo de descuentos, `importe ∈ {tarifa} ∪ {tarifas con descuento}` + motivo auditado.
- **Bloqueante para relajar la regla:** **P-2**. La fase se entrega **estricta**; no
  bloquea el resto.

### Fase 4 — Materialización y cupo offline con paradas de descenso  ·  `0052`

- `core.materializar_salidas`: el `INSERT INTO core.salida_parada` deja de leer solo
  `horario_parada`; nuevo origen = `core.ruta_parada` de la ruta + `LEFT JOIN
  core.horario_parada`. `parada_descenso` → `hora_paso_programada` / `cierre_venta_en`
  en `NULL`.
- `core.repartir_cupo_offline` (`0019`): `v_n_intermedias` cuenta solo puntos
  `terminal` con ascenso; las `parada_descenso` no entran al `FOR` de vendedoras ni
  reciben bloque. El chequeo `v_n_bloques - v_n_intermedias >= 1` usa el conteo
  corregido.
- **Bloqueante:** ninguno (depende de Fase 0 y 1).

### Fase 5 — Impresión, manifiesto y alta de rutas  ·  `0053` + admin + SPA

- `core.snapshot_boleto`: `origen` / `destino` desde `punto_ruta.nombre`; sin `referencia` (D7).
- Manifiestos (`0026` `datos_manifiesto` / `salidas_del_dia`): incluir las
  `parada_descenso` en la lista del chofer, marcadas "solo descenso", sin hora.
- `src/admin/puntos.ts` (nuevo) + `src/admin/rutas-puntos.ts` (nuevo) — CRUD
  `core.punto_ruta` vía `escribirConfig` (clase A, ventana nocturna).
- `crearRuta` (`src/admin/horarios.ts`): contrato `{ nombre, paradas: [{ puntoId }] }`;
  valida que primera y última sean `terminal`.
- `crearHorario`: `pasos` solo para puntos con ascenso.
- `POST /admin/rutas-detalle/:id/reemplazar` (nuevo, orquestador de D5): baja de
  horarios (cancela salidas futuras sin boletos) + baja de ruta y tarifas + alta de la
  ruta nueva, en una transacción contra la nube. Las salidas con boletos vendidos
  quedan intactas (D-7).
- SPA: `web/src/paginas/admin/Puntos.tsx` (nuevo), `Horarios.tsx` (armar ruta con
  puntos + tipo), `Tarifas.tsx` (matriz de pares válidos: origen = terminal con
  ascenso, destino = punto posterior).
- **Bloqueante:** ninguno.

### Orden de entrega

| PR | Fase | Bloquea a | Notas |
|---|---|---|---|
| #A | 0 (`0048` + wiring) | todo | refactor; reversible |
| #B | 1 (`0049`) | #C, #E | espera **P-1** |
| #C | 2 (`0050`) | — | espera **P-3**; backfill, probar en staging |
| #D | 3 (`0051`) | — | estricta; interruptor por parámetro |
| #E | 4 (`0052`) | — | — |
| #F | 5 (`0053` + admin + SPA) | — | — |

Cada PR: `npm run build && npm test` verde antes de merge. Los tests de sync no deben
`TRUNCATE sync.*` (deadlock con `hlc_estado`). Migraciones a nube + 4 terminales en la
misma ventana.

---

## 5. Superficie de cambio (resumen)

| Área | Objeto / archivo | Cambio |
|---|---|---|
| Esquema | `0048` `core.punto_ruta`; `ruta_parada.punto_id`; `salida_parada.punto_id` + horas nullables | Fase 0 |
| Búsqueda | `core.buscar_salidas` (`0043`) | punto ids; filtrar origen = terminal |
| Venta | `core.registrar_venta` (`0023`) | prohibir origen en descenso; `tramos_ocupacion`; validar importe vs tarifa |
| Disponibilidad | `core.asientos_libres` / `asientos_ofrecibles` (`0021`) | `&&` contra `tramos_ocupacion` |
| Lease | `core.adquirir_lease` (`0022`) | `tramos_ocupacion` extendido |
| Materialización | `core.materializar_salidas` (`0018`) | `salida_parada` desde `ruta_parada`; paradas de descenso sin hora |
| Cupo offline | `core.repartir_cupo_offline` (`0019`) | contar solo terminales con ascenso |
| Impresión | `core.snapshot_boleto` (`0023`/`0046`) | nombre de punto; sin referencia |
| Manifiesto | F7 `datos_manifiesto` (`0026`) | listar paradas de descenso |
| Pago | `core.pago` CHECK + `trg_pago_a_ingreso` (`0025`) | **tercer método — BLOQUEADO (P-7)** |
| Sync | `src/sync/clases.ts`, `src/admin/escribir-config.ts` | registrar `core.punto_ruta` |
| Admin API | `src/admin/puntos.ts`, `rutas-puntos.ts` (nuevos); `horarios.ts`, `tarifas.ts` | CRUD puntos; contrato de ruta; grid de tarifas |
| SPA | `web/src/paginas/Vender.tsx`; `web/src/paginas/admin/{Puntos,Horarios,Tarifas}.tsx` | selector de puntos; alta de ruta; matriz |

---

## 6. Riesgos

- **Fase 2 es la de mayor superficie.** `tramos` aparece en la API de venta y en la SPA
  (Viajes, `ModalDetalleBoleto`). Verificar que todo lo visible use el rango de viaje.
- **Deploy de esquema en 5 nodos.** Nube + 4 terminales antes de que fluya dato. El
  motor tolera columnas desconocidas (D-8), pero el `DROP COLUMN` de la Fase 1 debe ir
  **después** de que todos los nodos tengan `punto_id` poblado.
- **`repartir_cupo_offline`** ya tiene el defecto latente (asume que toda intermedia
  vende). Corregirlo en Fase 4 puede cambiar el reparto de rutas existentes con
  intermedias — revisar que no rompa cupos ya emitidos.

---

## 7. Preguntas abiertas con el cliente

> Bloquean las fases indicadas. **No arrancar esas fases hasta cerrarlas.**

| ID | Pregunta | Bloquea | Impacto si cambia la hipótesis del plan |
|---|---|---|---|
| **P-1** | ¿Una parada de solo descenso es *siempre* solo-descenso, o puede ser descenso rumbo a CDMX y ascenso rumbo a Huajuapan? | Fase 1 | La bandera se mueve de `punto_ruta.tipo` a `ruta_parada` — cambio acotado, mismo esfuerzo. |
| **P-2** | Descuentos / tarifas especiales (INAPAM, estudiante, menor, redondo, cortesía): ¿existen hoy? ¿catálogo con %/monto, u override de gerente con motivo? | relajar Fase 3 | La validación estricta admite un conjunto de tarifas con descuento + motivo auditado. |
| **P-3** | Asiento con ascenso en parada intermedia: ¿el tramo `[origen, parada_de_ascenso)` queda vendible, o el asiento se aparta desde el origen? | Fase 2 | Un `CASE` más en el cálculo de `tramos_ocupacion`. |
| **P-4** | Tercer método de pago: ¿cuál es? ¿liquida la venta (imprime boleto)? ¿se reconcilia en algún reporte aunque no entre al corte? ¿qué rol lo usa? | fase aparte (no listada) | ~1 migración: `core.pago` CHECK, `trg_pago_a_ingreso`, `pagoSchema`, selector en `Vender.tsx`. |
| **P-5** | Reservaciones / boletos a futuro al reemplazar una ruta: ¿viajan con la estructura vieja? (hipótesis: sí). | Fase 5 (orquestador) | — |
| **P-6** | Cierre de venta de un boleto a parada de descenso = cuando cierra la terminal de origen (hipótesis: sí). | Fase 4 | — |
| **P-7** | Manifiesto: ¿el chofer necesita ver quién baja en cada parada? ¿el boleto lleva hora estimada de la parada, o solo nombre + tarifa? | Fase 5 | — |
| **P-8** | Cupo offline: ¿terminales intermedias con ascenso tienen cupo `[su_orden, destino)` y las de descenso no tienen cupo? (hipótesis: sí). | Fase 4 | — |
| **P-9** | Alta del sentido inverso: ¿el sistema ofrece crear el espejo `CDMX → Huajuapan` reusando los puntos en orden inverso, o son dos altas independientes? | Fase 5 (UX) | — |

### Respuestas del cliente ya recibidas (sesión 2026-09-02)

- Una parada etiquetada como descenso **no** se puede ocupar para ascenso, ni para
  venta de boletos "de paradas hacia terminales".
- **No** hay paradas de solo ascenso. Solo dos tipos: terminales (ascenso/descenso) y
  paradas de solo descenso.
- Una terminal intermedia con bandera de ascenso **sí** puede originar boletos.
- La tarifa de una terminal origen a una parada autorizada **puede ser más alta** que a
  la sucursal destino.
- Cuando un pasajero baja en una parada de solo descenso, ese asiento **ya no se vende**
  para el tramo restante.
- Paradas de descenso: solo `nombre` + `referencia`. El boleto imprime nombre + tarifa,
  **sin** referencia.
- Los pagos se dan en la sucursal de origen (efectivo o transferencia). Habrá un
  **tercer método por definir** que **no suma al corte activo** de la sucursal.
- Las paradas intermedias con ascenso tienen horario de paso; las de solo descenso
  **no**.
- Las rutas cambian con muy baja frecuencia (del orden de cada 2 años — a confirmar).
- Una parada intermedia pertenece a una ruta origen→destino y a su espejo destino→origen
  (`Huajuapan-CDMX` vs `CDMX-Huajuapan`); no a rutas distintas con tarifas distintas.
