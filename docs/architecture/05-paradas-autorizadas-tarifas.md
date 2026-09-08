# 05 · Paradas autorizadas y tarifa por parada — Plan de implementación

> **Estado: BORRADOR — P-1..P-9 y N-1..N-12 RESPONDIDAS (2026-09-07). Residuales N-13..N-15 (§7.3), solo Fase 6.**
> Fecha de apertura: 2026-09-03 · Blueprint v0.2
>
> Este plan se construyó a partir de cuatro sesiones con el cliente sobre el flujo real
> de rutas. Las **decisiones fijadas** (§2, D1..D13) ya incorporan las respuestas a
> P-1..P-9 y N-1..N-12. Quedan tres **dudas residuales** (§7.3, N-13..N-15) que solo
> afinan la Fase 6 y no bloquean el modelo de datos. QA pidió que no se retrabaje:
> las Fases 0-5 se pueden construir sin más insumos del cliente.
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
| **D9** | **(P-4, P-6, N-5, N-6)** **Reserva sin pagar** (`es_reservacion = true`, `saldo_pendiente > 0`) **caduca 1 h antes de `salida.hora_salida`** (hora de salida **del origen** de la ruta); el asiento se libera y vuelve al cupo del origen. **Liberación perezosa** (al buscar/vender/materializar), no job nocturno. **Cancelación / reembolso** también hasta **1 h antes**: si la reserva **estaba pagada**, se registra un **movimiento de reembolso** (egreso) en el corte de caja activo y se libera el asiento; si **no** estaba pagada, solo se libera el asiento. Las reservas pagadas no caducan solas — requieren cancelación explícita. | Reembolso de un pago `corresponsal`: **N-13**. |
| **D10** | **(P-6, N-7)** La **transferencia** la valida el `vendedor` a mano (preguntando a administración) antes de imprimir el manifiesto. Si al imprimir **sigue sin validar**, el manifiesto **se imprime igual** con el estatus del pasajero como **"pendiente"** (no se bloquea la impresión ni se libera el asiento). El estatus de pago por pasajero es visible en pantalla. Guía de negocio: validarla ≥ 20 min antes del abordaje. | — |
| **D11** | **(P-7, N-8, N-9)** El **manifiesto** es una **lista única** por pasajero con: **nombre, asiento, "sube en" (punto de ascenso), "baja en" (parada / terminal de descenso) y estatus de pago**. **Sin importe/tarifa**, sin hora para descensos. El **abordaje digital de F7 (`marcar_abordaje`) se mantiene y se usa en la terminal de origen**; en las terminales de ascenso intermedias el **checador** marca **a mano** sobre el impreso y esa info **se captura después** en el sistema (debe permanecer el registro). | — |
| **D12** | **(P-5, N-10, N-11)** **Boletos huérfanos** (vendidos en la ruta vieja para viajar tras el corte, antes de configurar la nueva): poner `core.ruta.vigente_hasta` / `horario.vigente_hasta` **no se bloquea** aunque existan boletos vendidos después. El sistema produce un **listado/reporte** (folio, pasajero, contacto, fecha/hora de la salida vieja, asiento, origen→destino, importe). El usuario negocia con el pasajero y **reubica a mano**: la reubicación es **cancelar el boleto viejo + reemitir** (folio nuevo) en la ruta nueva. Des-materializar salidas viejas ≥ corte = manual. Mismo mapa de asientos si la unidad es la misma. | Traspaso de saldo vs reembolso+cobro al reemitir: **N-14**. |
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
  `web/src/paginas/Vender.tsx` (selector Origen = puntos con `permite_ascenso`, Destino = puntos posteriores).
- **P-1 RESUELTA:** la bandera es `ruta_parada.permite_ascenso` / `permite_descenso` (D2).
  Origen válido = `permite_ascenso`. Añadir fixture con parada de solo ascenso (retorno).
- **Bloqueante:** ninguno.

### Fase 2 — Semántica de ocupación del asiento  ·  `0050`

- `ADD COLUMN tramos_ocupacion` en `boleto` / `asiento_ocupacion` / `asiento_lease`;
  backfill `= tramos`; `SET NOT NULL`.
- Reemplazar el `EXCLUDE USING gist (… tramos WITH &&)` por `tramos_ocupacion WITH &&`
  en `asiento_ocupacion` y `asiento_lease`.
- `core.asientos_libres` / `core.asientos_ofrecibles` (`0021`) → `&&` contra
  `tramos_ocupacion`.
- `core.adquirir_lease` y `core.registrar_venta` → calcular ambos extremos:
  `desde_ocupacion = CASE WHEN origina_parada_sin_pos THEN 0 ELSE origen END`,
  `hasta_ocupacion = CASE WHEN destino_es_descenso THEN n-1 ELSE destino END`.
- `core.snapshot_boleto` no cambia (sigue leyendo `lower/upper(b.tramos)` = viaje).
- Revisar que `src/api/rutas/ventas.ts` (GET venta) y `web` (Viajes,
  `ModalDetalleBoleto`) muestren `tramos` (viaje), no `tramos_ocupacion`.
- **P-3 RESUELTA:** el asiento se aparta desde el origen (orden `0`) cuando la venta la
  origina una parada de ascenso **sin POS**; una terminal con POS lo aparta desde su
  propio orden (D3). El tramo `[origen, ascenso)` no queda vendible en el primer caso.
- **Bloqueante:** ninguno.

### Fase 3 — Validación de tarifa en la venta  ·  `0051`

- `core.tarifa` → `ADD COLUMN categoria_pasajero` (`general`|`inapam`|`menor`), `tope_asientos`.
  Reconstruir `core.v_tarifa_vigente` con la categoría en la llave.
- `core.registrar_venta`: resolver la tarifa para `(ruta, origen_orden, destino_orden,
  pasajero.categoria)`; sin tarifa ⇒ `RAISE`; cada `pasajero.importe` debe igualar esa tarifa.
- Si `categoria ≠ general`: exigir que `origen_orden` y `destino_orden` sean terminales
  extremos de la ruta (descuento solo Huajuapan↔CDMX). En parada intermedia ⇒ `RAISE`.
- Parámetro `validar_tarifa_estricta` (default `true`).
- `pasajeroSchema` / `Vender.tsx`: selector de categoría; el corte y `operacion.ts`
  desglosan por categoría. La categoría **no** se imprime (D7) — solo nombre.
- **P-2 RESUELTA:** montos fijos, sin cortesías ni importe 0, sin tope hoy (campo listo).
- **Bloqueante:** ninguno.

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

- `core.snapshot_boleto`: `origen` / `destino` desde `punto_ruta.nombre`; sin `referencia`;
  añadir **punto de ascenso** del pasajero (D7).
- **Reimpresión** de boleto (`src/printing/templates/boleto.ts`): parámetro `reimpreso`
  que agrega la leyenda tomada de `config_ticket.leyenda_reimpresion` (N-4); mismo contenido
  que el original. La original del wizard va sin leyenda. Acción de reimpresión en Viajes /
  terminal de origen.
- Manifiestos (`0026` `datos_manifiesto` / `salidas_del_dia`): **lista única** por pasajero:
  **nombre, asiento, *sube en*, *baja en*, estatus de pago**. Sin importe (N-8), sin hora
  para descensos. El abordaje digital de F7 sigue en uso en la terminal de origen (N-9).
- `src/admin/puntos.ts` (nuevo) + `src/admin/rutas-puntos.ts` (nuevo) — CRUD
  `core.punto_ruta` vía `escribirConfig` (clase A, ventana nocturna).
- `crearRuta` (`src/admin/horarios.ts`): contrato
  `{ nombre, paradas: [{ puntoId, permiteAscenso, permiteDescenso }] }`; valida que
  primera y última permitan ascenso **y** descenso (son terminales extremos).
- `crearHorario`: `pasos` solo para puntos con `permite_ascenso`.
- `POST /admin/rutas-detalle/:id/reemplazar` (nuevo, orquestador de D5): alta de la ruta
  nueva con `reemplaza_a`, fija `horario.vigente_desde` de la nueva y `horario.vigente_hasta`
  / `core.ruta.vigente_hasta` de la vieja, **rechaza traslape** de fechas. **No** bloquea
  aunque haya boletos vendidos después del corte; genera el **listado de boletos huérfanos**
  (D12) para revisión manual.
- Reubicación de huérfano = **cancelar + reemitir** (folio nuevo) en la ruta nueva (D12, N-11).
- SPA: `web/src/paginas/admin/Puntos.tsx` (nuevo), `Horarios.tsx` (armar ruta con puntos
  + banderas), `Tarifas.tsx` (matriz por par válido y categoría), pantalla / reporte de
  boletos huérfanos (D12).
- **Bloqueante:** ninguno.

### Fase 6 — Tercer método de pago (`corresponsal`), caducidad y cancelación de reservas  ·  `0054`

- `core.pago`: `metodo` CHECK gana `'corresponsal'` (`corte_caja_id` **sigue NOT NULL**).
  `core.sucursal` → `ADD COLUMN sin_sistema`. `config_ticket` → `ADD leyenda_reimpresion`.
- `core.registrar_venta` / registro de pago: `metodo='corresponsal'` ⇒ `sucursal_cobro_id`
  = sucursal `sin_sistema` (o parada de ascenso sin POS), `corte_caja_id` = corte abierto
  del vendedor de origen, `verificado=true`, `saldo_pendiente=0`. El trigger `pago→ingreso`
  (`0025`) **omite** `corresponsal` (no crea `movimiento_caja`).
- **Corte de caja (D8):** `src/caja/` — el reporte del corte gana un apartado
  "cobrado en corresponsal" (conteo + suma + detalle por `sucursal_cobro_id`), sin sumar
  al efectivo. Ver `<HistorialCortes>` / el cierre de corte.
- **Caducidad (D9):** liberación perezosa de reservas con `saldo_pendiente > 0` cuyo
  `salida.hora_salida - 1h < now()` — en `buscar_salidas`, `adquirir_lease`,
  `registrar_venta`, `materializar_salidas` / job de cupo.
- **Cancelación / reembolso (D9):** acción hasta 1 h antes de la salida; si la reserva
  estaba pagada ⇒ `core.movimiento_caja` tipo `reembolso` (egreso) en el corte activo;
  siempre libera el asiento.
- **Manifiesto con transferencia sin validar (D10):** se imprime igual, estatus del
  pasajero = "pendiente"; no bloquea.
- `pagoSchema`, selector en `Vender.tsx`, estatus visible en Viajes.
- **Bloqueante:** ninguno. Dudas de detalle abiertas: **N-13..N-15** (§7.2).

### Orden de entrega

| PR | Fase | Bloquea a | Notas |
|---|---|---|---|
| #A | 0 (`0048` + wiring) | todo | refactor; reversible |
| #B | 1 (`0049`) | #C, #E | P-1 resuelta (booleanos en `ruta_parada`) |
| #C | 2 (`0050`) | — | P-3 resuelta; backfill, probar en staging |
| #D | 3 (`0051`) | — | estricta + categoría de pasajero |
| #E | 4 (`0052`) | — | — |
| #F | 5 (`0053` + admin + SPA) | — | reimpresión, huérfanos, manifiesto |
| #G | 6 (`0054`) | — | `corresponsal` + caducidad + cancelación; ver N-13..N-15 |

Cada PR: `npm run build && npm test` verde antes de merge. Los tests de sync no deben
`TRUNCATE sync.*` (deadlock con `hlc_estado`). Migraciones a nube + 4 terminales en la
misma ventana.

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

### 7.3 Dudas de detalle residuales (N-13..N-15) — Fase 6, no bloquean el modelo

| ID | Duda | Toca |
|---|---|---|
| **N-13** | Reembolso de un pago `corresponsal`: ¿se hace **a mano en la corresponsal** (fuera del sistema, ya que el origen nunca tuvo ese efectivo), o el sistema registra una línea negativa de corresponsal en el corte del origen? ¿Qué rol autoriza cancelación/reembolso — `vendedor` o `gerente`? | D9, Fase 6 |
| **N-14** | Al **cancelar + reemitir** un huérfano ya pagado: ¿el pago se **traspasa** al folio nuevo (sin mover efectivo) o es **reembolso en el corte + cobro nuevo**? ¿Y si la tarifa de la ruta nueva difiere? | D12, Fase 5 |
| **N-15** | Cuando una parada de ascenso sin POS **gana su propio sistema**: ¿pasa a `punto_ruta.tipo = 'terminal'` con su `core.sucursal` (y empieza a tener cupo propio), o sigue siendo `parada` con POS? | D1/D2, Fase 1 |

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
