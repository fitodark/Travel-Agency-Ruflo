# 05 · Paradas autorizadas y tarifa por parada — Plan de implementación

> **Estado: P-1..P-9 y N-1..N-12 RESPONDIDAS (2026-09-07). N-13/N-14 RESUELTAS (2026-09-09). N-15 RESUELTA (2026-09-10). Plan cerrado a nivel de decisiones.**
> Fecha de apertura: 2026-09-03 · Blueprint v0.2
>
> Este plan se construyó a partir de cinco sesiones con el cliente sobre el flujo real
> de rutas. Las **decisiones fijadas** (§2, D1..D13) incorporan las respuestas a
> P-1..P-9 y N-1..N-15. Fases 0–6 completas (backend + SPA); falta solo el deploy a
> las 4 terminales físicas (§ "Estado del deploy").
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

## 2. Decisiones fijadas (validadas con el cliente · P-1..P-9 respondidas 2026-09-07)

| # | Decisión | Consecuencia / detalle |
|---|---|---|
| **D1** | Catálogo nuevo `core.punto_ruta`, `tipo ∈ ('terminal','parada')`. `ruta_parada` y `salida_parada` dejan de apuntar a `core.sucursal` y apuntan a un punto. `terminal` ⇒ `sucursal_id` NOT NULL. | Una parada no consume `sucursal.codigo` ni aparece en CRUD de sucursales/usuarios/caja. |
| **D2** | **(P-1)** La bandera ascenso/descenso vive en `ruta_parada` como dos booleanos `permite_ascenso` / `permite_descenso`, **por ruta** (no global). Terminal en la ruta ⇒ ambos `true`. Parada de solo descenso ⇒ solo `permite_descenso`. Parada de solo ascenso (típica del retorno) ⇒ solo `permite_ascenso`. `CHECK (permite_ascenso OR permite_descenso)`. | El mismo lugar físico (p. ej. Cuautla) es descenso en la ida y ascenso en el retorno. Una venta puede **originar** en un punto sii `permite_ascenso`. |
| **D3** | **(P-3)** El boleto guarda **dos rangos**: `tramos` (viaje: tarifa, impresión, manifiesto) y `tramos_ocupacion` (EXCLUDE, disponibilidad, cupo). `upper(tramos_ocupacion)` = `destino` si el destino es terminal; `n-1` (fin de ruta) si es parada de descenso. `lower(tramos_ocupacion)` = orden de la terminal que sostiene el asiento: **su propio orden** si la venta la origina una terminal con POS y cupo; **`0`** (origen de la ruta) si la origina una parada de ascenso **sin POS** (el asiento lo aparta el origen y ya no lo vende). | El tramo `[origen, parada_de_ascenso)` **no** queda vendible cuando el ascenso es en parada sin POS. |
| **D4** | **(P-2, N-12)** `core.registrar_venta` valida el importe contra `core.tarifa` de forma **estricta**: sin tarifa vigente para el par ⇒ rechaza; cada `pasajero.importe` debe igualar la tarifa de su `categoria`. `core.tarifa` gana `categoria_pasajero` (`general` \| `inapam` \| `menor`) y `tope_asientos smallint NULL`. Descuento (`categoria ≠ general`) **solo válido terminal-extremo → terminal-extremo** (Huajuapan↔CDMX); nunca en paradas intermedias. Montos fijos (INAPAM $300, menor ídem). **No hay cortesías ni importe 0** hoy (futuro: operaciones con PIN de autorización). **No hay "viaje redondo"**: son dos boletos independientes, cada uno con su tarifa. La **edad del menor** queda a criterio del vendedor — el sistema no la valida contra fecha de nacimiento. | Interruptor `core.parametro` `validar_tarifa_estricta` (default `true`). Sin tope de asientos con descuento hoy; el campo existe para el futuro. |
| **D5** | **(P-5, P-9)** Cambiar las paradas de una ruta = **baja lógica + alta nueva**, altas independientes por sentido (sin espejo automático). La ruta nueva se configura con antelación con `horario.vigente_desde` futuro y ya permite vender esas fechas; a la vieja se le pone `horario.vigente_hasta` = día previo. `core.ruta` gana `vigente_hasta date` y `reemplaza_a uuid`. **No debe existir traslape** de fechas entre la vieja y la nueva para el mismo par. **No** se mueven fechas para cubrir retrasos: es responsabilidad del admin configurar con ventana suficiente. `materializar_salidas` ya respeta `horario.vigente_desde/hasta`. No se re-llavea `tarifa` / `horario_parada`; la ruta nueva trae su propio `core.tarifa`. | Sigue sin existir "editar paradas de ruta". |
| **D6** | **(P-6, P-8)** Solo las **terminales con POS** reciben cupo offline propio (`[su_orden, destino)`). Las **paradas de ascenso sin POS** tienen `hora_paso` (para el boleto) pero **no** cupo: venden vía reserva contra el cupo del origen. Las **paradas de descenso** tienen fila en `salida_parada` con `hora_paso_programada = NULL` y `cierre_venta_en = NULL`, sin cupo. | El boleto a una parada de descenso cierra su venta cuando cierra la terminal de origen. |
| **D7** | **(P-4, P-7, N-4)** El boleto impreso a una parada muestra **nombre de la parada + tarifa + punto de ascenso del pasajero**, sin `referencia` y sin hora para el descenso. La **reimpresión** lleva exactamente el mismo contenido que el original **más una leyenda** que indica que es reimpresión; el texto se configura en `config_ticket` (`leyenda_reimpresion`). La impresión original (al cerrar el wizard) va sin leyenda. | — |
| **D8** | **(P-4, N-1, N-2, N-3)** **Cobro descentralizado dentro de alcance.** `core.pago.sucursal_cobro_id` (ya existe) puede ≠ sucursal de origen. Tercer método `metodo = 'corresponsal'`: lo cobra una sucursal **sin sistema** (`core.sucursal.sin_sistema = true`, p. ej. Tamazulapan) o una parada de ascenso sin POS. **No** se guarda referencia de la llamada, pero **sí** queda marcado el `sucursal_cobro_id`. `corte_caja_id` = el corte abierto del **vendedor de origen** que registró la reserva (para agruparlo); `trg_pago_a_ingreso` (`0025`) **omite** los `corresponsal` — **no** crean `movimiento_caja`, así que **no** entran al total de efectivo. El **corte de la sucursal de origen** muestra un **apartado adicional**: "cobrado en corresponsal" con conteo, suma y detalle (`SELECT … FROM core.pago WHERE corte_caja_id = … AND metodo = 'corresponsal'`), identificando la sucursal de cobro. Así el corte "cuadra" (efectivo real) y a la vez el origen sabe cuánto se cobró afuera. La llamada de confirmación lo marca pagado (`verificado = true`, `saldo_pendiente = 0`, boleto imprimible). Rol: `vendedor`, sin tope. | No es un tablero nuevo: es una sección del corte existente. |
| **D9** | **(P-4, P-6, N-5, N-6)** **Reserva sin pagar** (`es_reservacion = true`, `saldo_pendiente > 0`) **caduca 1 h antes de `salida.hora_salida`** (hora de salida **del origen** de la ruta); el asiento se libera y vuelve al cupo del origen. **Liberación perezosa** (al buscar/vender/materializar), no job nocturno. **Cancelación / reembolso** también hasta **1 h antes**: si la reserva **estaba pagada**, se registra un **reembolso** (egreso) en el corte abierto **de la sucursal donde se cobró** (N-13); si el cobro fue en una sucursal `sin_sistema` (`corresponsal`), el sistema no registra nada y el reembolso se hace a mano allá; si **no** estaba pagada, solo se libera el asiento. Las reservas pagadas no caducan solas — requieren cancelación explícita. | N-13 **resuelta** (§7.3). |
| **D10** | **(P-6, N-7)** La **transferencia** la valida el `vendedor` a mano (preguntando a administración) antes de imprimir el manifiesto. Si al imprimir **sigue sin validar**, el manifiesto **se imprime igual** con el estatus del pasajero como **"pendiente"** (no se bloquea la impresión ni se libera el asiento). El estatus de pago por pasajero es visible en pantalla. Guía de negocio: validarla ≥ 20 min antes del abordaje. | — |
| **D11** | **(P-7, N-8, N-9)** El **manifiesto** es una **lista única** por pasajero con: **nombre, asiento, "sube en" (punto de ascenso), "baja en" (parada / terminal de descenso) y estatus de pago**. **Sin importe/tarifa**, sin hora para descensos. El **abordaje digital de F7 (`marcar_abordaje`) se mantiene y se usa en la terminal de origen**; en las terminales de ascenso intermedias el **checador** marca **a mano** sobre el impreso y esa info **se captura después** en el sistema (debe permanecer el registro). | — |
| **D12** | **(P-5, N-10, N-11)** **Boletos huérfanos** (vendidos en la ruta vieja para viajar tras el corte, antes de configurar la nueva): poner `core.ruta.vigente_hasta` / `horario.vigente_hasta` **no se bloquea** aunque existan boletos vendidos después. El sistema produce un **listado/reporte** (folio, pasajero, contacto, fecha/hora de la salida vieja, asiento, origen→destino, importe). El usuario negocia con el pasajero y **reubica a mano**: la reubicación es **cancelar el boleto viejo + reemitir** (folio nuevo) en la ruta nueva. **Si el huérfano ya pagó ⇒ se mantiene el precio pagado** (el pago se traspasa al folio nuevo, sin mover efectivo aunque cambie la tarifa); **si no pagó ⇒ se cobra la tarifa vigente de la ruta nueva** (N-14). Des-materializar salidas viejas ≥ corte = manual. Mismo mapa de asientos si la unidad es la misma. | N-14 **resuelta** (§7.3). |
| **D13** | **(P-4)** **Sucursales sin sistema.** `core.sucursal` gana `sin_sistema boolean`. Una sucursal así: no tiene `corte_caja` en el sistema, no aparece en `ruta_parada`, solo figura como `sucursal_cobro_id` en pagos `corresponsal`. Reserva comunicándose con la terminal de origen (el `vendedor` del origen registra). | Tamazulapan es una sucursal nueva de este tipo. |

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

-- P-1 (D2): bandera de ascenso/descenso POR RUTA
ALTER TABLE core.ruta_parada ADD COLUMN permite_ascenso  boolean NOT NULL DEFAULT false;
ALTER TABLE core.ruta_parada ADD COLUMN permite_descenso boolean NOT NULL DEFAULT false;
ALTER TABLE core.ruta_parada ADD CONSTRAINT ruta_parada_rol_chk
  CHECK (permite_ascenso OR permite_descenso);
-- backfill: toda parada actual proviene de una sucursal ⇒ permite_ascenso = permite_descenso = true

-- P-4 (D8/D13): tercer método + sucursal sin sistema
ALTER TABLE core.sucursal ADD COLUMN sin_sistema boolean NOT NULL DEFAULT false;
-- core.pago.metodo CHECK: 'efectivo' | 'transferencia' | 'corresponsal'
-- core.pago.corte_caja_id SIGUE NOT NULL: para 'corresponsal' = corte abierto del
--   vendedor de origen (agrupa el pago en ese corte).
-- trg_pago_a_ingreso (0025): si metodo='corresponsal' NO crea movimiento_caja
--   (no suma al efectivo); el reporte del corte lo lista en un apartado adicional.
-- registrar_venta con metodo='corresponsal' ⇒ verificado=true, saldo_pendiente=0.
-- config_ticket (por sucursal, migr. 0046): ADD leyenda_reimpresion text.

-- P-2 (D4): categoría de pasajero para descuentos de monto fijo
ALTER TABLE core.tarifa ADD COLUMN categoria_pasajero text NOT NULL DEFAULT 'general';
ALTER TABLE core.tarifa ADD COLUMN tope_asientos      smallint;      -- NULL = sin tope (futuro)
-- la llave lógica de tarifa pasa a (ruta, origen_orden, destino_orden, categoria_pasajero, effective_*)
-- descuento válido solo si origen_orden y destino_orden son terminales extremos de la ruta

-- P-5 (D5): baja lógica de ruta por vigencia (la partición de venta la da horario.vigente_desde/hasta)
ALTER TABLE core.ruta ADD COLUMN vigente_hasta date;                 -- NULL = vigente
ALTER TABLE core.ruta ADD COLUMN reemplaza_a   uuid REFERENCES core.ruta(id);
-- poner vigente_hasta NO se bloquea aunque haya boletos vendidos después (D12).

-- P-4 (D9): caducidad + cancelación/reembolso de reserva — sin columna nueva.
--   caducidad: deadline = salida.hora_salida - interval '1 hour'; liberación perezosa
--     de reservas con saldo_pendiente > 0 al buscar / vender / materializar.
--   cancelación (hasta 1 h antes): si estaba pagada ⇒ core.movimiento_caja tipo
--     'reembolso' (egreso) en el corte activo + libera asiento; si no ⇒ solo libera.
```

**Regla de `tramos_ocupacion`** (con `n` paradas, orden `0 … n-1`):

| Caso | `tramos` (viaje) | `tramos_ocupacion` |
|---|---|---|
| origina terminal con POS · destino terminal | `[origen, destino)` | `[origen, destino)` |
| origina terminal con POS · destino parada de descenso | `[origen, destino)` | `[origen, n-1)` |
| origina parada de ascenso **sin POS** (la aparta el origen) · destino terminal | `[ascenso, destino)` | `[0, destino)` |
| origina parada de ascenso **sin POS** · destino parada de descenso | `[ascenso, destino)` | `[0, n-1)` |

El origen de una venta debe permitir ascenso (`ruta_parada.permite_ascenso`). Una parada
de solo descenso nunca origina. Una parada de ascenso sin POS no vende localmente: la
reserva la registra la terminal de origen, que aparta el asiento desde el orden `0`.

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

### Fase 0 — Catálogo de puntos y re-cableado estructural  ·  `0048`  ✅ ENTREGADA (commit `92b17fe`, rama `f-paradas-fase0`)

- Crear `core.punto_ruta` + wiring de sync (`clases.ts` → `'A'`, `escribir-config.ts`).
- Backfill: un `punto_ruta` tipo `terminal` por cada `core.sucursal` activa, **id determinista**
  `md5('core.punto_ruta:'||sucursal_id)::uuid` (converge en los 5 nodos sin replicar, patrón `0039`).
- `ruta_parada.punto_id` y `salida_parada.punto_id`: `ADD COLUMN` → backfill vía el
  mapeo sucursal→punto. **`punto_id` se deja NULLABLE en `0048`** (la nube sigue en `0047`
  y `tests/sync/*` hace `bootstrap()` real contra ella; con `NOT NULL` el ingest revienta).
  **Trigger de compatibilidad `trg_aa_compat_punto`** (BEFORE INSERT en ambas tablas,
  `WHEN punto_id IS NULL AND sucursal_id IS NOT NULL`): find-or-create del punto terminal.
  **Dispara también dentro de `sync.ingest_fila`** porque el gate es la GUC `donaji.replicando`
  (no `session_replication_role`), así que los nodos que hacen pull desde la nube-`0047`
  quedan con `punto_id` poblado. `ruta_parada.sucursal_id` → `DROP NOT NULL` y se quita
  `UNIQUE (ruta_id, sucursal_id)` (para poder sembrar una parada de descenso sin sucursal).
- `permite_ascenso` / `permite_descenso` en `ruta_parada` (`DEFAULT false`, backfill `true/true`,
  `CHECK (permite_ascenso OR permite_descenso)`) — estructural; la lógica llega en `0049`.
- `hora_paso_programada` / `cierre_venta_en` de `salida_parada` → nullables.
- Re-cablear `core.materializar_salidas` (versión vigente en `0019`): join por `punto_ruta`
  con `LEFT JOIN core.sucursal`; zona horaria desde `punto_ruta.zona_horaria`.
- Código: `clases.ts`, `escribir-config.ts`, `src/admin/horarios.ts`
  (`listarRutasDetalle`, `listarHorarios`), `src/admin/tarifas.ts` (`listarRutas`),
  `scripts/qa-comun.ts`, `scripts/limpiar-dev.ts`.
- Seed nuevo `src/db/seed/0003_puntos.sql` (puntos terminal de las 4 sucursales) para QA.
- Fixture: opción `paradaDescensoEnOrden` en `tests/fleet/fixture.ts` + `tests/fleet/puntos.test.ts`.
- **Refactor puro, 0 regresiones:** verificado con baseline mismo-DB (código `main` vs rama
  dan las mismas 70 fallas idénticas — polución preexistente del DB dev, ninguna en lo que
  `0048` toca). Las FKs nuevas son `DEFERRABLE` (invariante del repo).
- **Diferido a `0049` / Fase 1** (documentado en la cabecera de `0048`): `SET NOT NULL` de
  `punto_id`, wiring de `bootstrap.ts` / `ORDEN_TOPOLOGICO`, `DROP COLUMN sucursal_id`,
  retiro de los triggers de compat — todo en la ventana coordinada donde el usuario migra
  nube + 4 terminales a mano y (red de seguridad) se backfillea `punto_id` en los nodos.

### Fase 1 — Bandera ascenso/descenso en búsqueda y venta  ·  `0049`

- **Ventana coordinada 5 nodos** (el usuario migra nube + 4 terminales a `0048` **antes** de
  aplicar `0049`): antes del `SET NOT NULL`, backfillear `punto_id` en cada nodo (red de
  seguridad; el compat trigger ya lo puebla vía `donaji.replicando`). Luego `SET NOT NULL`
  en `ruta_parada.punto_id` / `salida_parada.punto_id` y wiring de `bootstrap.ts` /
  `ORDEN_TOPOLOGICO` (`core.punto_ruta` antes de `ruta_parada`/`salida_parada`).
- **`DROP COLUMN core.ruta_parada.sucursal_id`** + retiro de `trg_ruta_parada_compat_punto`.
  Verificado seguro por el `architect`: todos los lectores terminal-side de esa columna
  migraron en Fase 0 (`listarRutasDetalle`/`listarHorarios` en `horarios.ts`, `listarRutas`
  en `tarifas.ts`), `sync.ingest_fila` (`0031`) tolera la columna ausente en el payload, y
  ya era nullable desde `0048`.
- **`salida_parada.sucursal_id` NO se dropea en Fase 1** — lo leen `snapshot_boleto` (`0046`),
  `datos_manifiesto` / `salidas_del_dia` (`0026`), vistas `api.*` (`0030`) y
  `src/fleet/abordaje.ts` (blast radius = Fase 5). Solo `DROP NOT NULL` (para las paradas de
  descenso de Fase 4). Su compat trigger (`trg_salida_parada_compat_punto`) **se queda**;
  `materializar_salidas` sigue poblando `punto_id` **y** `sucursal_id` en paralelo.
  El `DROP COLUMN` + retiro de ese trigger + re-cableo de `snapshot_boleto`/manifiesto/
  `api`/`abordaje` van **juntos en Fase 5** (o un `0053b`).
  *(La cabecera de `0048` dice "se elimina en 0049" — cierto solo para `ruta_parada`; la de
  `0049` lo aclara. No se re-edita `0048`, ya mergeado.)*
- Helper `core.asegurar_punto_terminal(sucursal_id uuid)` — find-or-create del punto
  terminal por id determinista `md5('core.punto_ruta:'||sucursal_id)`. Reemplaza al compat
  trigger de `ruta_parada` (que se retira): es el camino de escritura para `crearRuta` /
  `seedRuta` ahora que `ruta_parada` ya no tiene `sucursal_id`.
- `crearRuta` (`src/admin/horarios.ts`) y `seedRuta` (`tests/fleet/fixture.ts`) → insertan
  `ruta_parada` con `punto_id` (vía `asegurar_punto_terminal`) + banderas explícitas.
- `core.buscar_salidas` (versión vigente en `0043`) → `p_origen` / `p_destino` pasan a ser
  **punto ids**; origen debe tener `ruta_parada.permite_ascenso`; destino cualquier punto
  posterior; join a `core.punto_ruta` para `origen_nombre` / `destino_nombre` / `escalas`.
- `core.registrar_venta` (`0023`) y `core.adquirir_lease` (`0022`) → `RAISE` si el punto de
  origen de la venta NO tiene `permite_ascenso` (una parada de solo descenso nunca origina).
- Código: `src/ventas/busqueda.ts`, `src/api/rutas/ventas.ts` (querystring
  `origen`/`destino` = punto ids), `web/src/api/catalogos.ts` (`listarPuntos`),
  `web/src/paginas/Vender.tsx` (selector Origen = puntos con `permite_ascenso`, Destino = puntos posteriores).
- **P-1 RESUELTA:** la bandera es `ruta_parada.permite_ascenso` / `permite_descenso` (D2).
  Origen válido = `permite_ascenso`. Añadir fixture con parada de solo ascenso (retorno).
- **`crearRuta` / `seedRuta` setean `permite_ascenso`/`permite_descenso` explícito** en cada
  `INSERT INTO core.ruta_parada` — obligatorio ahora que `ruta_parada` no tiene `sucursal_id`
  ni compat trigger: el `DEFAULT false/false` de `0048` viola `ruta_parada_rol_chk` sin las
  banderas. (Hallazgo del review de Fase 0, D3.)
- **Fixture:** `seedRuta` (`tests/fleet/fixture.ts`) reescribe su `INSERT` de `ruta_parada`
  para usar `asegurar_punto_terminal` + banderas; `RutaFixture` gana `puntos: string[]`;
  nueva opción `paradaAscensoEnOrden` (parada de solo ascenso del retorno). Los tests de
  `buscar_salidas` pasan `fx.puntos[...]` en vez de `fx.sucursales[...]`. Arrastre a arreglar:
  `fleet`, `ventas`, `api/admin`, `caja`.
- **Bloqueante:** ninguno.

### Fase 2 — Semántica de ocupación del asiento  ·  `0050`  ✅ ENTREGADA (rama `f-paradas-fase2`)

- **`core.tramo_ocupacion(salida, desde, hasta)`** (nuevo helper): deriva el rango de
  ocupación del de viaje — `lower = 0` si el punto de origen es `tipo='parada'`;
  `upper = max(orden)` si el punto de destino es `tipo='parada'` con `permite_descenso`.
- `ADD COLUMN tramos_ocupacion` en `boleto` / `asiento_ocupacion` / `asiento_lease`;
  backfill `= tramos`; `SET NOT NULL`.
- **`trg_aa_tramos_ocupacion_compat`** (BEFORE INSERT en las 3 tablas): `tramos_ocupacion
  := tramos` cuando el insertador no lo da. Load-bearing para la ventana de despliegue —
  una terminal en `0049` que vende empuja `boleto`/`asiento_ocupacion` a la nube en `0050`
  sin la columna (`sync.ingest_fila` toma columnas reales). `registrar_venta` /
  `adquirir_lease` (`0050`) siempre lo calculan.
- El `EXCLUDE USING gist (… tramos WITH &&)` pasa a `tramos_ocupacion WITH &&` en
  `asiento_ocupacion` y `asiento_lease` (constraints renombradas a `*_no_solapa` /
  `*_vivo_no_solapa`).
- `core.asientos_libres` (`0021`) → `&&` contra `tramos_ocupacion` del rango que TENDRÍA la
  venta pedida (`core.tramo_ocupacion`), no el viaje pelado. `asientos_ofrecibles` no cambia
  (delega en `asientos_libres`).
- `core.adquirir_lease` (`0049`) y `core.registrar_venta` (`0049`) → re-emitidas + calculan
  `v_ocup`/`v_tramo_ocup` y lo guardan en `asiento_lease.tramos_ocupacion` /
  `boleto.tramos_ocupacion` + `asiento_ocupacion.tramos_ocupacion`. El `tramos` (viaje) no
  cambia; los checks de lease y cupo siguen sobre el viaje.
- `core.snapshot_boleto` no cambia. **Cero cambios de `src/` o `web/`**: verificado que toda
  la API y la SPA seleccionan `b.tramos` (viaje) explícito, nunca `SELECT *`.
- **Dependencia con Fase 4:** el camino de venta completo a una parada de descenso necesita
  que `materializar_salidas` emita `salida_parada` para las paradas no-terminal (Fase 4).
  Los tests de Fase 2 (`tests/ventas/tramos-ocupacion.test.ts`) insertan esa fila a mano.
- **P-3 RESUELTA:** el asiento se aparta desde el origen (orden `0`) cuando la venta la
  origina una parada `tipo='parada'`; una terminal lo aparta desde su propio orden (D3).
- **Bloqueante:** ninguno. Verificado: 0 regresiones (mismas 70 fallas preexistentes),
  `tests/ventas` + `tests/fleet` verdes, +4 casos nuevos.

### Fase 3 — Validación de tarifa en la venta  ·  `0051`  ✅ MERGEADA (PR #65, `569c0d5`)

- `core.tarifa` → `categoria_pasajero` (`general`|`inapam`|`menor`, en la llave) + `tope_asientos`
  (nullable, inerte). `core.v_tarifa_vigente` recreada (DROP+CREATE; una vista `SELECT *`
  congela columnas). `core.boleto` → `categoria_pasajero` (no se imprime, D7).
- `core.buscar_salidas` (DROP+CREATE) → 17ª col `tarifas jsonb` = `{categoria: importe}` del
  tramo (subquery escalar correlacionada, `{}` si no hay); `importe` escalar = tarifa `general`.
- `core.registrar_venta` (re-emitida desde `0050`) → cada pasajero lleva `categoria`; valida
  `importe` vs la tarifa vigente de su `(ruta, tramo, categoria)`; sin tarifa o importe ≠
  tarifa ⇒ `RAISE` (salvo `validar_tarifa_estricta = false`). Descuento (`categoria ≠ general`)
  solo si `origen_orden = 0 AND destino_orden = n-1`. Guarda `categoria` en `core.boleto`.
- `validar_tarifa_estricta` (`core.parametro`, default `true`, vía la migración). El interruptor
  off = **no valida el importe**; el CHECK de categoría y el guard de descuento siguen activos.
- Web (opción 1): selector de categoría por asiento en `Vender.tsx` paso 4; `importe` por
  pasajero desde `salida.tarifas[categoria]`. `ventaSchema` (JSON schema fastify) += `categoria`
  enum. `crearTarifa` cierra solo la tarifa `general` previa.
- **Sin compat trigger** — el `DEFAULT 'general'` es el valor correcto para todo dato pre-Fase-3.
- **F3-D1 (runbook de deploy):** `validar_tarifa_estricta='true'` es efectivo en cuanto aterriza
  `0051`. **Antes del deploy nube+4 terminales, auditar que cada `(ruta, tramo vendible)` en
  producción tenga fila `core.tarifa` vigente `general`.** *Auditado 2026-09-08: `HJP - CDMX`
  6/6 tramos cubiertos — OK.* Si en el futuro hay hueco: sembrar el param en `'false'`, llenar
  tarifas, flipear a `'true'`.
- **F3-D2 — ✅ RESUELTO en 5c (`0056`):** el guard de descuento de `registrar_venta` pasa de
  "por `orden` contra `v_n_paradas`" a "origen y destino son `tipo='terminal'` y los extremos
  de la ruta (`ruta_parada.orden` 0 y máx)".
- **F3-D3 — ✅ RESUELTO en 5d:** `crearTarifa` gana `categoria` (`general`|`inapam`|`menor`),
  valida terminal↔terminal para el descuento (D4) y solo cierra la anterior de la misma
  categoría; `Tarifas.tsx` tiene el selector + columna; `Vender.tsx` ya mostraba el selector
  de categoría solo cuando el tramo tiene tarifa de descuento (`salida.tarifas`). Los
  descuentos INAPAM/menor quedan **operativos**.
- **P-2 RESUELTA:** montos fijos, sin cortesías ni importe 0, sin tope hoy (campo listo).
- **Bloqueante:** ninguno.

### Fase 4 — Materialización y cupo offline con paradas de descenso  ·  `0052`  ✅ ENTREGADA (rama `f-paradas-fase4`)

- `core.materializar_salidas` re-emitida: el `INSERT INTO core.salida_parada` pasa de
  `core.horario_parada` a `core.ruta_parada rp JOIN core.punto_ruta pr LEFT JOIN
  core.horario_parada hp` — **una fila por cada `ruta_parada` de la ruta** (`AND rp.activo`).
  Las que tienen `horario_parada` llevan `hora_paso_programada` / `cierre_venta_en`; las
  no-terminal (sin `horario_parada`) entran con ambos en `NULL` (D6). `orden` = `rp.orden`,
  contiguo `0..n-1`.
- `core.repartir_cupo_offline` (`0019`) re-emitida: **solo las terminales con ascenso venden**
  (`punto_ruta.tipo='terminal' AND ruta_parada.permite_ascenso AND orden < max(orden)`). Se
  arma `v_ordenes smallint[]` con esas órdenes; el `FOR` itera sobre ellas (no `0..n-2`).
  `v_n_intermedias = v_n_vendedoras - 1`. Los índices de bloque se calculan sobre las
  vendedoras reales. Las paradas `tipo='parada'` no reciben cupo → nunca se intenta
  `INSERT` con `sucursal_id = NULL` (`core.cupo_offline.sucursal_id` es NOT NULL — hallazgo
  de Fase 1, resuelto por exclusión, sin `DROP NOT NULL`).
- **F2-Q1 verificado:** con las paradas ya materializadas, `core.tramo_ocupacion` queda vivo
  por venta real. `max(orden)` en el helper = última `salida_parada` = terminal destino (D5),
  así que el rango de ocupación de un boleto a una parada de descenso llega al fin real de
  la ruta. Test `tramos-ocupacion.test.ts` migrado del insert-a-mano a `seedSalida({paradaDescensoEnOrden})`.
- **F3-D2 — ✅ RESUELTO en 5c (`0056`):** el guard de descuento de `registrar_venta` se
  reescribió por `tipo='terminal'` + extremo de ruta, junto con `crearRuta`.
- **F4-D3 — ✅ RESUELTO en 5d:** `tests/sync/arbitraje.test.ts` gana el caso cross-node —
  dos ocupaciones que solapan en `tramos_ocupacion` (`[0,3)` y `[1,3)`) pero cuyos viajes
  (`[0,1)` y `[1,3)`) son disjuntos: `resolverConflictoAsiento` sí dispara y elige ganador.
- **Review de Fase 4 — a resolver en Fase 5:**
  - **F4-D1 (must-fix) — ✅ RESUELTO:** `snapshot_boleto` / `datos_manifiesto` /
    `salidas_del_dia` / `generar_manifiestos` / `abordaje.ts` → `core.punto_ruta` en 5a
    (`0053`); `datos_manifiesto` rehecha en 5a-2 (`0054`); `api.v1_*` + `DROP COLUMN
    salida_parada.sucursal_id` en 5b (`0055`).
  - **F4-D2 (invariante) — ✅ RESUELTO en 5c:** `ruta_parada.orden` contiguo `0..n-1` (load-bearing
    para `materializar_salidas` / `registrar_venta` / `tramo_ocupacion` / `repartir_cupo_offline`
    / `datos_manifiesto`). `crearRuta` lo garantiza por construcción — `orden` = índice del
    arreglo de paradas; no hay camino de escritura que inserte un `orden` con hueco.
  - **F2-D3:** retirar `trg_aa_tramos_ocupacion_compat` (BEFORE INSERT en `boleto` /
    `asiento_ocupacion` / `asiento_lease`) — es no-op tras la ventana de deploy `0050+`.
    Va con la limpieza de `salida_parada.sucursal_id` / manifiesto.
- **Bloqueante:** ninguno (depende de Fase 0 y 1).

### Fase 5 — Impresión, manifiesto y alta de rutas  ·  `0053`–`0056` + admin + SPA  ·  ✅ CERRADA (5a–5e)

- `core.snapshot_boleto`: `origen` / `destino` desde `punto_ruta.nombre`; sin `referencia`;
  añadir **punto de ascenso** del pasajero (D7).
- **Re-cablear a `punto_ruta` todo lo que aún lee `sucursal_id`** de `ruta_parada` /
  `salida_parada` — `core.snapshot_boleto` (`0046`), `core.datos_manifiesto` /
  `core.salidas_del_dia` (`0026`), vistas `api.*` (`0030`), `src/fleet/abordaje.ts` — y recién
  entonces `DROP COLUMN` en **ambas** tablas + retirar **ambos** `trg_aa_compat_punto` +
  dejar que `materializar_salidas` pueble solo `punto_id`.
  **✅ 5a (`0053`)** hizo `snapshot_boleto` / `datos_manifiesto` / `salidas_del_dia` /
  `generar_manifiestos` / `abordaje.ts`. **✅ 5a-2 (`0054`)** rehízo `datos_manifiesto`.
  **✅ 5b (`0055`, rama `f-paradas-fase5b`)** cerró el eje `salida_parada`: re-emite
  `materializar_salidas` (deja de escribir `sucursal_id`) y `repartir_cupo_offline` (lee la
  sucursal de la terminal vía `punto_ruta`), recrea `api.v1_boleto` / `api.v1_salida` /
  `api.v1_venta` con el nombre de origen/destino desde `punto_ruta`, retira
  `trg_aa_compat_punto` + `core.trg_salida_parada_compat_punto()` y hace
  `ALTER TABLE core.salida_parada DROP COLUMN sucursal_id`. **Precondición de deploy:** los 5
  nodos en `0054` antes de aplicar `0055` a la nube. **Fuera de 5b:** el retiro de
  `trg_aa_tramos_ocupacion_compat` (F2-D3, precondición propia: los 5 nodos ≥ `0050`).
- **Reimpresión** de boleto (`src/printing/templates/boleto.ts`): parámetro `reimpreso`
  que agrega la leyenda tomada de `config_ticket.leyenda_reimpresion` (N-4); mismo contenido
  que el original. La original del wizard va sin leyenda. Acción de reimpresión en Viajes /
  terminal de origen.
- Manifiestos (`0026` `datos_manifiesto` / `salidas_del_dia`): **lista única** por pasajero:
  **nombre, asiento, *sube en*, *baja en*, estatus de pago**. Sin importe (N-8), sin hora
  para descensos. El abordaje digital de F7 sigue en uso en la terminal de origen (N-9).
  **✅ ENTREGADO como sub-PR 5a-2 (`0054`, rama `f-paradas-fase5-2`):** `core.datos_manifiesto`
  emite `pasajeros[]` plano (`folio, asiento, nombre, sube_en(+orden), baja_en(+orden),
  estatus_pago, conflicto`) ordenado por punto de ascenso y luego asiento; se van `ascensos[]`,
  `ocupacion_por_tramo` e `importe`/`saldo` por pasajero. Las dos copias (conductor/terminal)
  quedan con contenido idéntico (difieren solo en encabezado + firma). `core.generar_manifiestos`
  cuenta `jsonb_array_length(datos->'pasajeros')`. `renderManifiesto` reescrito (de paso corrige
  el `paradas[].sucursal`→`.punto` que 0053 dejó desalineado). Deploy: solo `CREATE OR REPLACE`,
  sin DDL, aplicable en caliente sobre nodos en 0053.
- **✅ ENTREGADO como sub-PR 5c (`0056`, rama `f-paradas-fase5c`):**
  - `src/admin/puntos.ts` (nuevo) — CRUD `core.punto_ruta`: `crearPunto` (`parada` exige
    nombre + zona horaria; `terminal` es idempotente vía `asegurar_punto_terminal`),
    `editarPunto`, `darDeBajaPunto` (rechaza si el punto está en una ruta activa),
    `listarPuntos` (con `enUso`). Rutas `/admin/puntos` (GET/POST/PATCH/POST-baja).
  - `crearRuta` gana el contrato `{ nombre, paradas: [{ puntoId, permiteAscenso,
    permiteDescenso }] }` **junto al `{ sucursalIds }` actual** (no rompe la SPA ni los
    tests). Valida: extremos `tipo='terminal'` + ascenso **y** descenso; sin punto repetido;
    `orden` = índice del arreglo (contiguo 0..n-1, **F4-D2**).
  - `crearHorario`: rechaza un `paso` sobre una `ruta_parada` sin `permite_ascenso` (una
    parada de solo descenso viaja sin hora).
  - `src/admin/rutas-reemplazo.ts` (nuevo): `reemplazarRuta` (D5) — cierra la vieja por
    vigencia (`ruta.vigente_hasta` + `horario.vigente_hasta` = `vigenteDesde - 1`), rechaza
    fecha no futura y traslape (horario de la vieja que arranca ≥ `vigenteDesde`), crea la
    nueva con `reemplaza_a`, devuelve el listado de huérfanos. `boletos_huerfanos(ruta, desde)`
    (SQL, D12) + `GET /admin/rutas-detalle/:id/huerfanos` + `POST .../:id/reemplazar`.
  - `0056`: `core.ruta` += `vigente_hasta` / `reemplaza_a`; `core.boletos_huerfanos`;
    **F3-D2** — el guard de descuento de `registrar_venta` pasa a "`tipo='terminal'` + extremo
    de ruta" (antes por `orden` contra `v_n_paradas`). Deploy sin ventana coordinada.
  - `listarRutasDetalle` ahora expone `tipo` / `permiteAscenso` / `permiteDescenso` por
    parada y `vigenteHasta` / `reemplazaA` por ruta.
- **`punto_ruta.zona_horaria` es copia point-in-time** de `sucursal.zona_horaria` (backfill
  de `0048`); NO se re-propaga en vivo si el admin cambia la tz de la sucursal — la tz
  operativa se edita en el punto (`editarPunto`). (Hallazgo del review de Fase 0, D2.)
- Reubicación de huérfano = **cancelar + reemitir** (folio nuevo) en la ruta nueva (D12, N-11).
- **✅ 5d (rama `f-paradas-fase5d`, sin migración):** `src/admin/tarifas.ts` `crearTarifa` +=
  `categoria`, valida terminal↔terminal para el descuento (D4), cierra solo la anterior de la
  misma categoría; `listarTarifas`/`listarRutas` re-cableadas a `punto_ruta.nombre`. Ruta
  `/admin/tarifas` schema += `categoria` enum. Web: `Tarifas.tsx` con selector de categoría +
  columna + guard de descuento válido; `web/src/api/admin.ts` tipos. `tests/admin/config.test.ts`
  +3, `tests/sync/arbitraje.test.ts` +1 (F4-D3). **F3-D3 y F4-D3 CERRADOS.**
- **✅ 5e (rama `f-paradas-fase5e`, solo frontend):** `web/src/paginas/admin/Puntos.tsx` (nuevo,
  pestaña `Puntos` + ruta `/admin/puntos`): alta/edición/baja de paradas, lista de terminales.
  `Horarios.tsx` — `NuevaRuta` reescrito: filas terminal/parada con banderas ascenso/descenso,
  resuelve terminales a `puntoId` con `crearPunto` idempotente; el form de horario solo pide
  hora para paradas con ascenso; la lista de rutas marca `(baja)` las paradas no-terminal y
  `hasta <fecha>` la vigencia. `<ReemplazarRuta>` (modal, D5): arma la ruta nueva partiendo de
  las paradas de la vieja, fecha futura, y muestra la tabla de boletos huérfanos que devuelve
  el endpoint. typecheck + build verdes; backend intacto (0 regresiones).
- **Limpieza pendiente de Fase 1** (hallazgos del review):
  - `src/ventas/busqueda.ts` — renombrar `sucursalOrigenId` / `sucursalDestinoId` a
    `puntoOrigenId` / `puntoDestinoId` (desde `0049` llevan `core.punto_ruta.id`; se dejó el
    nombre viejo para no tocar el typecheck de tests). (F1-D1)
  - `web/src/paginas/Vender.tsx` — el selector de destino muestra todo punto ≠ origen,
    incluidos los inalcanzables; apretar a "puntos posteriores al origen en la ruta". (F1-D3)
  - `core.asegurar_punto_terminal` copia `sucursal.zona_horaria` al punto en la creación
    (misma copia point-in-time que F0-D2 / D2 arriba).
- **Bloqueante:** ninguno.

### Fase 6 — Tercer método de pago (`corresponsal`), caducidad y cancelación de reservas  ·  `0057`–`0062`  ·  ✅ completa (incl. review `0061` + reubicación de venta completa `0062`)

> Migración corrida: `0054` = 5a-2 (manifiesto lista única), `0055` = 5b
> (`DROP COLUMN salida_parada.sucursal_id`), `0056` = 5c (alta de rutas + F3-D2).

- **✅ 6a — `corresponsal` (`0057`, rama `f-paradas-fase6a`):**
  - `core.sucursal` += `sin_sistema boolean` (D13). `v_sucursal_vigente` recreada para exponerla.
  - `core.pago.metodo` CHECK += `'corresponsal'`; `pago_check` acepta `corresponsal` verificado
    sin `verificado_por`. `corte_caja_id` sigue NOT NULL = corte del vendedor de origen.
  - `core.registrar_venta`: `metodo='corresponsal'` ⇒ `sucursal_cobro_id` = una sucursal
    `sin_sistema` activa (se valida), cubre el total (sin abonos), entra `verificado=true` y
    cuenta como pagado (venta liquidada, boleto imprimible). `referencia_transferencia` NULL.
  - `core.trg_pago_a_ingreso`: **omite** `corresponsal` — no crea `movimiento_caja`, no suma
    al efectivo del corte.
  - **D8:** `core.pagos_corresponsal(corte)` + `src/caja/corte.ts` `cobradoEnCorresponsal` +
    `GET /caja/corte/:id/corresponsal`; apartado "cobrado en corresponsal" en `<Caja>` (bajo
    los movimientos del corte).
  - `pagoSchema` / `PagoInput` += `metodo:'corresponsal'` + `sucursalCobroId`; `Vender.tsx`
    gana la opción + selector de sucursal de cobro (solo si hay sucursales `sin_sistema`).
  - `tests/ventas/pago-corresponsal.test.ts` (+4). Deploy sin ventana coordinada.
- **✅ 6b — Caducidad (D9) (`0058`, rama `f-paradas-fase6b`):** una reserva **sin ningún pago**
  (`es_reservacion`, `pagado = 0`) caduca 1 h antes de `salida_parada` orden 0
  (`hora_paso_programada - 1h <= ahora`). **Liberación perezosa** (sin job):
  - `core.reservas_caducas(salida, ahora)` (STABLE) lista las ocupaciones a liberar;
  - `core.liberar_reservas_caducas(salida, ahora)` (VOLATILE) las materializa —
    `asiento_ocupacion.estado='liberado'`, `boleto.estado='cancelado'`,
    `venta.estado='cancelada'` (si no le quedan boletos vivos); guarda contra `sync.replicando()`;
  - `core.asientos_libres` deja de contar la ocupación caduca (lado LECTURA, sin escribir);
  - `core.adquirir_lease` y `core.registrar_venta` llaman a `liberar_reservas_caducas` antes de
    tocar el asiento (lado ESCRITURA).
  - Determinista del reloj ⇒ sin ventana coordinada (como la expiración de leases).
  - **Reserva con abono parcial: NO se auto-libera** — el reembolso del abono es 6c.
  - `tests/ventas/caducidad-reservas.test.ts` (+3).
- **✅ 6c-1 — Cancelación / reembolso (`0059`, rama `f-paradas-fase6c-1`):**
  - Permiso nuevo `reserva.cancelar` → `administrador` + `gerente`.
  - `core.cancelar_boleto(boleto, usuario, sucursal, motivo, ahora)`: hasta 1 h antes de la
    salida del origen; libera el asiento (`estado='liberado'`), cancela boleto + venta (si
    queda sin boletos vivos). **Reembolso (N-13):** solo en la sucursal donde se cobró —
    `LEAST(boleto.importe, pagado)` como egreso `origen_tipo='devolucion'` en su corte abierto
    (sin corte abierto ahí ⇒ error); si esa sucursal es `sin_sistema` (`corresponsal`) ⇒ **sin
    movimiento**, la función devuelve `reembolso_pendiente_en` = nombre de la sucursal para la
    devolución manual. `nota_auditoria` tipo `cancelacion`.
  - `src/fleet/abordaje.ts` `cancelarBoleto` + `POST /viajes/boleto/:id/cancelar`
    (`exige({ permiso: 'reserva.cancelar' })`, 422 en error de negocio).
  - Web: botón "Cancelar boleto" en `<ModalDetalleBoleto>` (solo si `estado='emitido'`) con
    confirmación + motivo; muestra dónde queda el reembolso.
  - **D10 — ✅ ya venía con 5a-2** (`datos_manifiesto` marca `estatus_pago='pendiente'` para una
    transferencia sin verificar y `generar_manifiestos` no bloquea); +1 test que lo fija.
  - `tests/ventas/cancelar-boleto.test.ts` (+7), `tests/fleet/manifiesto.test.ts` (+1).
    Deploy sin ventana coordinada.
- **✅ 6c-2 — Reubicación de huérfanos (`0060`, rama `f-paradas-fase6c-2`, N-14):**
  - `core.reubicar_huerfano(boleto_viejo, salida_nueva, origen_orden, destino_orden, asiento,
    usuario, sucursal, ahora)`: valida la salida nueva (programada, venta abierta, asiento
    vendible, origen con ascenso); emite el boleto nuevo; **huérfano ya pagado** ⇒ importe =
    el pagado, `UPDATE core.pago SET venta_id = <nueva>` (traspaso, sin mover efectivo, sin
    diferencia); **sin pagar** ⇒ importe = `v_tarifa_vigente` de la ruta nueva (RAISE si no
    hay), venta `pendiente`. Boleto viejo → `estado='reasignado'`, su asiento `liberado`,
    venta vieja `cancelada`. `nota_auditoria` tipo `reubicacion`.
  - `src/fleet/abordaje.ts` `reubicarHuerfano` + `POST /viajes/boleto/:id/reubicar`
    (`exige({ permiso: 'reserva.cancelar' })`, 422 en negocio). Cliente `reubicarBoleto` en
    `web/src/api/viajes.ts`.
  - `tests/ventas/reubicar-huerfano.test.ts` (+4). Deploy sin ventana coordinada.
  - **✅ Asistente SPA (`f-paradas-fase6d-spa-reubicar`):** `<ReubicarBoleto>` dentro de
    `<ModalDetalleBoleto>` en `web/src/paginas/Viajes.tsx` (junto a "Cancelar boleto", solo si
    `estado='emitido'`). Flujo: fecha + origen/destino (puntos) → `buscarSalidas` → elegir
    salida → elegir asiento (`asientosOfrecibles`) → `reubicarBoleto`. El resultado muestra el
    folio nuevo y si se mantuvo el precio pagado o se aplicó la tarifa vigente + saldo. La
    reimpresión queda deshabilitada para un boleto `reasignado`. Solo web, sin migración.

### Notas del review de Fase 6 (`0057`–`0060`)

Review independiente hecho al cierre (las fases 5–6 se mergearon con el patrón de agentes
caído por límite de cuenta). El esquema ya está en nube + dev; eran bugs de lógica. **`0061`
corrige F6-D1..D4 y F6-D6** (`CREATE OR REPLACE` de `cancelar_boleto` y `reubicar_huerfano`;
sin ventana coordinada). Ordenados por severidad.

- **F6-D1 (must-fix, alto) — ✅ RESUELTO en `0061`.** El boleto viejo reubicado seguía en el
  manifiesto / checklist / conteo / reporte de huérfanos. `core.reubicar_huerfano` (`0060`)
  marcaba el boleto viejo `estado='reasignado'` sin tocar `activo`; en el resto del código
  `reasignado` = "mismo boleto, asiento nuevo, sigue viajando" (`src/sync/reasignacion.ts`),
  así que `core.datos_manifiesto` (`0054`), `core.salidas_del_dia` (`0053`),
  `core.v_checklist_abordaje` (`0027`) y `core.boletos_huerfanos` (`0056`) —que solo excluyen
  `'cancelado'`— lo dejaban pasar. **Fix:** `UPDATE core.boleto SET estado='reasignado',
  activo=false` (esos lectores ya filtran `AND b.activo`). `abordaje.ts` `detalleBoleto` dejó
  de filtrar `b.activo` para que la modal siga mostrando el boleto tras reubicarlo.
- **F6-D2 (bug, alto) — ✅ RESUELTO en `0061` (rechazo) + `0062` (soporte real).**
  `core.boletos_huerfanos` devuelve un renglón por boleto; una familia de 3 asientos en una
  venta son 3 huérfanos de la MISMA venta. `reubicar_huerfano` movía **todos** los
  `core.pago` y cancelaba la venta vieja en la 1ª reubicación → los otros boletos quedaban en
  venta cancelada sin pago y se les cobraba de nuevo. **`0061`:** `reubicar_huerfano` rechaza
  una venta con más de un boleto `emitido` vivo. **`0062`:** `core.reubicar_venta_huerfana(
  venta_vieja, salida_nueva, asignaciones jsonb, usuario, sucursal, ahora)` reubica la venta
  **entera** en una operación — una venta nueva con todos los boletos al precio pagado
  (traspasa el pago una vez) o a la tarifa vigente si no había pago; las asignaciones deben
  cubrir exactamente los boletos vivos. `POST /viajes/venta/:id/reubicar` + `GET
  /viajes/venta/:id/reubicables`; el wizard `<ReubicarBoleto>` conmuta al modo multi-boleto
  (un asiento por pasajero, mismo tramo) cuando la venta tiene >1 boleto.
- **F6-D3 (bug, medio) — ✅ RESUELTO en `0061`.** Doble reembolso al cancelar boleto por
  boleto una venta multi-boleto con abono parcial: `core.cancelar_boleto` (`0059`) calculaba
  `LEAST(boleto.importe, pagado)` sin descontar reembolsos previos ni desactivar el pago
  (2×$450 sobre $500 pagados; el pago completo salía bien solo por aritmética). **Fix:**
  `v_reembolso := GREATEST(0, LEAST(importe, pagado − Σ egresos 'devolucion' activos de los
  pagos de la venta))`.
- **F6-D4 (menor) — ✅ RESUELTO en `0061`.** `reubicar_huerfano` no liberaba las reservas
  caducas de la salida destino antes del check de asiento (a diferencia de `registrar_venta`
  / `adquirir_lease`). **Fix:** `PERFORM core.liberar_reservas_caducas(p_salida_nueva_id,
  p_ahora)` antes del INSERT de la ocupación.
- **F6-D6 (menor) — ✅ RESUELTO en `0061`.** `cancelar_boleto` / `reubicar_huerfano` no
  abortaban bajo `sync.replicando()` (a diferencia de `liberar_reservas_caducas`). **Fix:**
  `IF sync.replicando() THEN RAISE` al inicio de ambas.
- **F6-D5 (menor) — NO se toca.** `reubicar_huerfano` no valida categoría/tarifa en la rama
  "precio mantenido": un boleto INAPAM con descuento se reubica en un tramo parcial
  manteniendo el descuento, algo que `registrar_venta` prohíbe. Impacto bajo (acción de
  admin, conciliación manual) — se deja documentado.
- **F6-D7 (menor / UX) — NO se toca.** Pago `corresponsal` (o `efectivo`/`transferencia`)
  sin corte abierto en el origen → `v_corte_id` NULL → el INSERT en `core.pago`
  (`corte_caja_id` NOT NULL) revienta con constraint genérico en vez de un mensaje claro.
  Mismo patrón preexistente; la SPA ya bloquea vender sin corte, el impacto real es solo el
  mensaje.
- **F6-D8 (menor / perf) — NO se toca.** `core.reservas_caducas` se re-ejecuta por asiento
  dentro del `NOT IN (...)` de `core.asientos_libres` (`0058`). Impacto bajo (~18 asientos,
  join chico por salida).

**Correcto en el review:** `0057` (los dos CHECK, `trg_pago_a_ingreso` omitiendo
corresponsal, `pagos_corresponsal`, validación `sin_sistema` + total sin abonos, expand-safe);
`0058` (caducidad determinista del reloj, guard `sync.replicando()`, CTE con snapshot
correcto, lectura vs escritura bien separadas); `0059` (ventana D9, reembolso solo en la
sucursal de cobro N-13, corresponsal → `reembolso_pendiente_en`, `nota_auditoria`); `0060`
(validaciones de la salida destino, `EXCLUDE` con mensaje limpio, traspaso del pago para el
caso single-boleto).

### Orden de entrega

| PR | Fase | Bloquea a | Notas |
|---|---|---|---|
| #A | 0 (`0048` + wiring) | todo | refactor; reversible |
| #B | 1 (`0049`) | #C, #E | P-1 resuelta (booleanos en `ruta_parada`) |
| #C | 2 (`0050`) | — | P-3 resuelta; backfill, probar en staging |
| #D | 3 (`0051`) | — | estricta + categoría de pasajero |
| #E | 4 (`0052`) | — | — |
| #F | 5 (`0053` + admin + SPA) | — | 5a `0053` (impresión/manifiesto→punto, reimpresión) ✅ · 5a-2 `0054` (manifiesto lista única) ✅ · 5b `0055` (`DROP COLUMN salida_parada.sucursal_id` + `api.*`) ✅ · 5c `0056` (CRUD puntos, `crearRuta`/`crearHorario` con banderas, reemplazo D5 + huérfanos, F3-D2, F4-D2) ✅ · 5d tarifas por categoría (`crearTarifa` + `Tarifas.tsx`, F3-D3, F4-D3) ✅ · 5e SPA (`Puntos.tsx`, `Horarios.tsx` con puntos+banderas, modal de reemplazo + huérfanos) ✅ |
| #G | 6 (`0057`–`0062`) | — | 6a `0057` (`corresponsal` + D8) ✅ · 6b `0058` (caducidad D9) ✅ · 6c-1 `0059` (cancelación + reembolso N-13 + D10) ✅ · 6c-2 `0060` (reubicación de huérfanos N-14) ✅ · 6d asistente SPA ✅ · review `0061` (F6-D1..D4/D6) ✅ · `0062` reubicación de venta completa (F6-D2) ✅ |

Cada PR: `npm run build && npm test` verde antes de merge. Los tests de sync no deben
`TRUNCATE sync.*` (deadlock con `hlc_estado`). Migraciones a nube + 4 terminales en la
misma ventana.

### Estado del deploy (`0048`–`0063`) — 10 sep 2026

| Nodo | Versión | Estado |
|---|---|---|
| **NUBE** (Supabase) | `0063` | ✅ el usuario migró `0053`–`0056` el 9 sep 23:04, `0057`–`0060` el 10 sep 01:41, `0061` 05:23, `0062` 12:16, `0063` 13:04. `db:migrate:nube --dry` → "nada pendiente", sin drift. |
| **Local dev** | `0063` | ✅ |
| **4 terminales** (Huajuapan / Acatlán / Acatitla / CDMX) | `0049` | ⛔ **pendientes de `0050`→`0063`** — el usuario las migra por TeamViewer en ventana de madrugada (`migrate.ts` solo tiene targets `local` / `nube`). Runbook por terminal: `git pull` → `npm ci` → `npm run build` → `npm run db:status` (confirmar `0049`) → `npm run db:migrate` → `npm run db:status` (verificar `0063`) → reiniciar API / spooler. |

**Ventana de `0055` abierta / con riesgo.** `0055` hizo `DROP COLUMN
core.salida_parada.sucursal_id` en la nube (tabla **clase A**, nube → sucursal) sin que se
cumpliera la precondición "los 5 nodos en `0054` antes de `0055`". Una `salida_parada`
materializada en la nube desde el 9 sep 23:04 puede **atascar el pull** de una terminal que
sigue en `0049` (allá `sucursal_id` es `NOT NULL`); se auto-cura en cuanto esa terminal pasa
`0055`. → Prioridad: migrar las 4 terminales y, tras cada una, verificar que su sync no quedó
"atascado".

Con las 4 terminales en `0050`+ queda **desbloqueado F2-D3** (retiro de
`trg_aa_tramos_ocupacion_compat`, precondición propia "los 5 nodos ≥ `0050`") — migración
chica futura, fuera de este deploy.

---

## 5. Superficie de cambio (resumen)

| Área | Objeto / archivo | Cambio |
|---|---|---|
| Esquema | `0048` `core.punto_ruta`; `ruta_parada.punto_id`; `salida_parada.punto_id` + horas nullables | Fase 0 |
| Búsqueda | `core.buscar_salidas` (`0043`) | punto ids; origen = `permite_ascenso`; liberar reservas vencidas |
| Venta | `core.registrar_venta` (`0023`) | origen `permite_ascenso`; `tramos_ocupacion` (dos extremos); importe vs tarifa por categoría; `corresponsal` |
| Disponibilidad | `core.asientos_libres` / `asientos_ofrecibles` (`0021`) | `&&` contra `tramos_ocupacion` |
| Lease | `core.adquirir_lease` (`0022`) | `tramos_ocupacion` extendido; caducidad 1 h |
| Materialización | `core.materializar_salidas` (`0018`) | `salida_parada` desde `ruta_parada`; descenso sin hora; respeta `ruta.vigente_hasta` |
| Cupo offline | `core.repartir_cupo_offline` (`0019`) | contar solo terminales con POS y ascenso |
| Ruta/vigencia | `core.ruta` (`0004`) | `vigente_hasta`, `reemplaza_a`; sin traslape de fechas |
| Tarifa | `core.tarifa` + `v_tarifa_vigente` (`0004`) | `categoria_pasajero`, `tope_asientos` |
| Impresión | `core.snapshot_boleto` (`0023`/`0046`), `templates/boleto.ts` | nombre de punto; sin referencia; punto de ascenso; leyenda de reimpresión |
| Manifiesto | F7 `datos_manifiesto` (`0026`) | lista única nombre/asiento/*sube en*/*baja en*/estatus; sin importe; descenso sin hora |
| Pago | `core.pago` CHECK + `trg_pago_a_ingreso` (`0025`) | **`corresponsal`** (Fase 6): `corte_caja_id` = corte del origen, trigger lo omite (sin `movimiento_caja`) |
| Corte | `src/caja/` + `<HistorialCortes>` | apartado "cobrado en corresponsal"; `movimiento_caja` tipo `reembolso` |
| Sucursal / ticket | `core.sucursal` (`0002`), `config_ticket` (`0046`) | `sin_sistema`; `leyenda_reimpresion` |
| Sync | `src/sync/clases.ts`, `src/admin/escribir-config.ts` | registrar `core.punto_ruta` |
| Admin API | `src/admin/puntos.ts`, `rutas-puntos.ts` (nuevos); `horarios.ts`, `tarifas.ts` | CRUD puntos; contrato de ruta con banderas; grid de tarifas por categoría; orquestador reemplazar |
| Reportes | `src/dashboard/operacion.ts` | boletos huérfanos (listado para reubicación) |
| SPA | `web/src/paginas/Vender.tsx`; `web/src/paginas/admin/{Puntos,Horarios,Tarifas}.tsx` | selector de puntos; categoría; alta de ruta; matriz; huérfanos |

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

## 7. Preguntas con el cliente

### 7.1 P-1..P-9 — RESUELTAS (sesión 2026-09-07)

| ID | Respuesta del cliente | Dónde quedó |
|---|---|---|
| **P-1** | Una parada **puede** ser descenso en la ida y ascenso en el retorno ("ascenso ida o ascenso retorno"). Aparece la parada de **solo ascenso** por sentido. Confirmado: bandera por `ruta_parada` (`permite_ascenso` / `permite_descenso`), terminales = ambos. La parada de ascenso sin POS **sí vende**: reserva contra la terminal de origen; después tendrá su propio sistema. | D2, D6, Fase 1 |
| **P-2** | Descuentos: **montos fijos** (INAPAM $300, menor ídem), **solo terminal-extremo → terminal-extremo** (HJP↔CDMX), nunca en paradas intermedias. Sin cortesías ni importe 0 hoy (futuro: PIN de autorización). Sin tope de asientos (campo listo). La categoría **no** se imprime — basta el nombre. | D4, Fase 3 |
| **P-3** | El asiento **se aparta desde el origen** y ya no se vende desde el origen (cuando la venta la origina una parada de ascenso sin POS). | D3, Fase 2 |
| **P-4** | **Tamazulapan** = sucursal nueva **sin sistema**, corte manual externo. La base solo reserva y debe identificar que el cobro fue allá ⇒ tercer método `corresponsal` (hay una llamada de confirmación). Boleto: se imprime al cerrar el wizard, o reimpresión en la terminal de origen a la llegada, **con leyenda de pie**. El pasajero sube en la terminal de origen o de ascenso. El asiento **consume el cupo del origen**. Rol `vendedor`, sin tope. Reserva sin pagar **caduca 1 h antes de la salida**. | D7, D8, D9, D13, Fase 6 |
| **P-5** | La ruta nueva **reemplaza** a la vieja por **fecha de vigencia sin traslape**; se preconfigura con antelación (no se mueven fechas por retrasos — es responsabilidad del admin). Boletos vendidos antes de configurar la nueva ⇒ **listado/reporte** para que el usuario contacte al pasajero y lo **reubique a mano**. Des-materializar salidas viejas ≥ corte = manual. Mismo mapa de asientos si la unidad es la misma. Ruta nueva = su propio `core.tarifa`. | D5, D12, Fase 5 |
| **P-6** | Confirmado: el boleto a parada de descenso cierra su venta cuando cierra la terminal de origen. La **transferencia** la valida el `vendedor` a mano; al imprimir el manifiesto ya debe estar validada (el estatus es visible y se pregunta a administración). Reserva sin pagar: 1 h antes de la salida. | D6, D9, D10, Fase 6 |
| **P-7** | Paradas de solo descenso **sin hora**. El manifiesto es **lista única** con *"sube en"* + *"baja en"*. El **chofer no marca abordaje**: el **checador** de cada terminal de ascenso lo marca a mano sobre el manifiesto impreso. El boleto muestra nombre de la parada + tarifa + punto de ascenso; sin hora de descenso. | D7, D11, Fase 5 |
| **P-8** | Confirmado: paradas de descenso **sin cupo**; terminales intermedias con POS y ascenso **con cupo propio** `[su_orden, destino)`. Riesgo señalado por el cliente: que sincronicen a tiempo para no sobrevender (arrastre F1→F4, `it.todo` catch-up de pull). | D3, D6, Fase 4 |
| **P-9** | **Altas independientes** por sentido; el retorno tiene otras paradas. Sin generador de espejo. | D5, Fase 5 |

### 7.2 N-1..N-12 — RESUELTAS (sesión 2026-09-07)

| ID | Respuesta del cliente | Dónde quedó |
|---|---|---|
| **N-1** | No se guarda referencia de la llamada, pero **sí** queda marcado `sucursal_cobro_id`. El corte de la sucursal de origen debe **cuadrar** (efectivo real) y a la vez mostrar en un **apartado adicional** el monto/detalle cobrado en la corresponsal. | D8 |
| **N-2** | Con "corresponsal" basta poder **identificar la sucursal** de cobro. | D8 |
| **N-3** | **No** es tablero ni reporte nuevo: el **corte de caja de la sucursal de origen** debe saber cuántos pagos se hicieron en la corresponsal. | D8, Fase 6 |
| **N-4** | La reimpresión lleva **el mismo contenido** que el original **+ leyenda** de reimpresión. El texto se configura en `config_ticket` (`leyenda_reimpresion`). | D7, Fase 5/6 |
| **N-5** | La caducidad se ancla a la **hora de salida del origen**. | D9 |
| **N-6** | **Sí existe reembolso**, hasta **1 h antes** de la salida: si estaba pagada ⇒ `movimiento_caja` tipo `reembolso` en el corte; si no ⇒ solo se libera el asiento. | D9, Fase 6 |
| **N-7** | El manifiesto **se imprime igual** con el estatus del pasajero como **"pendiente"**. | D10 |
| **N-8** | Manifiesto: **solo nombre, asiento, sube/baja y estatus de pago**. Sin importe. | D11, Fase 5 |
| **N-9** | El abordaje digital de F7 **se usa en la sucursal de origen** y **permanece**; en las intermedias es manual y **se captura después**. | D11, Fase 5 |
| **N-10** | Usar `reemplaza_a`. **No** bloquear `vigente_hasta` con boletos vendidos: definir la ruta nueva, sacar el listado de asientos vendidos y moverlos/reservarlos **a mano** con negociación directa. | D12, Fase 5 |
| **N-11** | Reubicación = **cancelar y volver a emitir** (folio nuevo). | D12, Fase 5 |
| **N-12** | "Viaje redondo" = **dos boletos separados**, cada uno con su tarifa. La **edad del menor** queda a **criterio del vendedor** (sin validación del sistema). | D4, Fase 3 |

### 7.3 Dudas de detalle residuales (N-13..N-15) — Fase 6 · **todas resueltas**

| ID | Respuesta / estado | Toca |
|---|---|---|
| **N-13 — RESUELTA (cliente, 2026-09-09)** | El reembolso **solo existe en la sucursal donde se cobró**. Pago `corresponsal` (cobrado en sucursal `sin_sistema`, p. ej. Tamazulapan): el sistema **NO** registra ninguna línea en el corte del origen — el efectivo nunca entró. La cancelación **procede** (libera el asiento), y el reembolso se hace **a mano en esa sucursal**: Tamazulapan notifica la cancelación y Tamazulapan devuelve. Si el pasajero pide el reembolso en Huajuapan **no se puede** — se cancela igual, pero la devolución es en Tamazulapan. Escenario raro pero se contempla (conciliación manual). *Rol: no se especificó → se asume `administrador` + `gerente` (recomendación no objetada).* | D9, 6c-1 ✅ |
| **N-14 — RESUELTA (cliente, 2026-09-09)** | Reubicación de un huérfano = conciliación con el pasajero + reemitir en la ruta nueva. **Si ya pagó** ⇒ se **mantiene el precio pagado** aunque la tarifa nueva difiera (el pago se traspasa al folio nuevo, sin mover efectivo, sin cobrar/devolver diferencia). **Si no pagó** ⇒ se le cobra el **monto vigente** de la tarifa de la ruta nueva. | D12, 6c-2 |
| **N-15 — RESUELTA (cliente, 2026-09-10)** | Cuando una parada de ascenso "sin POS" **gana su propio sistema** (POS = nodo con PC + app + `core.sucursal` + corte de caja + folios + bloque de cupo offline; **no** es la impresora). **Pasa a `punto_ruta.tipo = 'terminal'` con su `core.sucursal`** — es una operación de catálogo, sin cambio de esquema: se le crea la sucursal, su `punto_ruta` se marca `tipo='terminal'`, y desde la **siguiente materialización** `repartir_cupo_offline` le asigna un bloque disjunto `[su_orden, destino)` (las salidas ya materializadas conservan su reparto). Para **Tamazulapan** (hoy `core.sucursal.sin_sistema=true`, ni en `punto_ruta`): se pone `sin_sistema=false` y se agrega como `punto_ruta` terminal a las rutas que paran ahí. **P1 (cliente):** al volverse terminal es una **sucursal completa** — aparece en la consola de admin, en los cortes y en el tablero, y **debe tener su propio corte de caja**. **P2 (cliente):** el estrechamiento del cupo offline por bloques (R17) es **aceptable** — la estrategia es que el cupo se consulte **siempre online** (lease) cuando hay conexión, así el bloque offline chico no limita la operación normal; requisito duro: **vender el boleto e imprimir el ticket nunca se bloquea**. | D1/D2/D6, R17 |

### Respuestas del cliente ya recibidas (sesión 2026-09-02)

- Una parada etiquetada como descenso **no** se puede ocupar para ascenso, ni para
  venta de boletos "de paradas hacia terminales".
- ~~**No** hay paradas de solo ascenso.~~ **Corregido en P-1 (2026-09-07):** una parada
  puede ser de solo ascenso en el sentido de retorno. La bandera es por `ruta_parada`.
- Una terminal intermedia con bandera de ascenso **sí** puede originar boletos.
- La tarifa de una terminal origen a una parada autorizada **puede ser más alta** que a
  la sucursal destino.
- Cuando un pasajero baja en una parada de solo descenso, ese asiento **ya no se vende**
  para el tramo restante.
- Paradas de descenso: solo `nombre` + `referencia`. El boleto imprime nombre + tarifa,
  **sin** referencia.
- Los pagos se dan en la sucursal de origen (efectivo o transferencia). El **tercer
  método** (`corresponsal`, P-4) **no suma al corte activo** de la sucursal.
- Las paradas intermedias con ascenso tienen horario de paso; las de solo descenso
  **no**.
- Las rutas cambian con muy baja frecuencia (del orden de cada 2 años — a confirmar).
- ~~Una parada intermedia pertenece a una ruta origen→destino y a su espejo.~~
  **Matizado en P-9:** el retorno tiene sus propias paradas; el catálogo `core.punto_ruta`
  se comparte pero cada ruta se configura por separado con sus banderas.
