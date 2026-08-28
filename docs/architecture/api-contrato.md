# Esquema `api` — contrato de solo lectura con el sistema externo

> Blueprint v0.2 · F8. Estado: **andamiado y versionado, no congelado** (P7).

## Qué es

La base de datos en la nube (Supabase) es consumida por otro sistema, fuera de
este alcance, **solo para visualizar reportes**. Ese sistema **nunca** debe
conectarse directo a las tablas de `core`: si lo hiciera, cualquier refactor
nuestro lo rompería y quedaríamos congelados.

Por eso existe el esquema `api` desde el día 1: un conjunto de vistas estables,
versionadas con prefijo `v1_`. El sistema externo lee de ahí y nada más.

## Por qué no está congelado

P7 quedó **parcialmente** respondida:

- ✅ Confirmado: es de **solo lectura**, para reportes.
- ❌ Falta: el **mecanismo de acceso** (¿rol de Postgres dedicado? ¿PostgREST?
  ¿una réplica?) y los **campos exactos** que el reporte externo necesita.

Mientras P7 no se cierre, estas vistas pueden cambiar. Cuando se cierre, lo que
cambie se publica como `v2_` y `v1_` se mantiene un tiempo de convivencia
(parámetro `dias_convivencia_version_minimo`, D-8).

## Vistas publicadas

| Vista | Migración | Contenido |
|---|---|---|
| `api.v1_boleto` | 0009 | Boleto: folio, pasajero, asiento, origen/destino, fecha del viaje, importe, `es_reservacion`, estado |
| `api.v1_corte_caja` | 0009 | Corte: sucursal, saldo inicial, ingresos/egresos, saldo calculado y declarado, estado |
| `api.v1_venta` | 0030 | Venta con su estado económico (`pagado`, `saldo_pendiente`), origen/destino, sucursal de venta |
| `api.v1_pago` | 0030 | Pagos (append-only). El corte lo determina `sucursal_cobro` — ver C5 |
| `api.v1_movimiento_caja` | 0030 | Movimientos de caja, **activos e inactivos** (el sistema externo audita igual que el administrador) |
| `api.v1_salida` | 0030 | Salidas materializadas: fecha, estado, conductor, tipo de unidad, hora real de salida |

Todas filtran `activo = true` salvo `api.v1_movimiento_caja`, que incluye los
inactivos a propósito (la baja lógica es información de auditoría; el saldo ya lo
resuelve `api.v1_corte_caja`, que solo suma activos).

## Nota sobre C5

`api.v1_venta` reporta por la sucursal que **vendió**; `api.v1_pago` y
`api.v1_corte_caja`, por la que **cobró**. Una reservación pagada en destino
aparece en sucursales distintas en cada vista. **No cuadran entre sí y no deben
cuadrar** — es una consecuencia del diseño, no un error. El dashboard propio lo
explica con `reporte.f_ventas_vs_caja`; el consumidor externo debe saberlo.

## Reportes del dashboard propio (`reporte.*`)

Distinto del esquema `api`. El dashboard del administrador (F8) lee del esquema
`reporte`, que ofrece funciones parametrizadas por rango de fechas:

- `reporte.f_ventas(desde, hasta, sucursal?)` — ventas de la sucursal que vende.
- `reporte.f_ingresos_caja(desde, hasta, sucursal?)` — ingresos a la caja de la
  sucursal que cobra.
- `reporte.f_ventas_vs_caja(desde, hasta)` — las dos anteriores lado a lado, con
  la nota de C5.
- `reporte.f_cortes(desde, hasta, sucursal?)` — cortes con declarado vs. calculado.
- `reporte.v_inactivos` — todo lo dado de baja lógicamente.
- `reporte.v_salud_sucursal` — última sync, atraso, deriva, versión, `degradado`.
- `reporte.f_excepciones_abiertas()` / `f_excepciones_resumen()`.
- `reporte.f_gastos(desde, hasta)` — egresos de caja + nómina mensual.

El **export semanal** (`npm run export:semanal`, `src/dashboard/export.ts`)
empaqueta todo esto en JSON por semana ISO. En producción lo dispara una tarea
programada en la nube; la entrega al cliente (correo / SFTP) la cablea F9.
