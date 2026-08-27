# Esquema de base de datos — Donaji

Blueprint v0.2. Diseño en [`docs/architecture/`](../../docs/architecture/README.md).

## Principio

> **Las migraciones se aplican IDÉNTICAS en el nodo local y en Supabase.**

Esa es la razón de usar PostgreSQL 16 en la sucursal y no SQLite: un solo dialecto,
una sola migración y las mismas garantías (`EXCLUDE USING gist`, tipos de rango,
columnas generadas, transacciones). La única diferencia entre ambos entornos es la
bandera `sync.nodo.es_nube`, que decide si una instancia alimenta el outbox de subida
o el log de bajada.

## Orden de aplicación

| Archivo | Contenido |
|---|---|
| `0001_fundamentos.sql` | Esquemas, extensiones, `uuid_v7()`, reloj híbrido (HLC), columnas estándar de auditoría/sync, outbox genérico |
| `0002_core_organizacion.sql` | Agencia, sucursales, roles, usuarios, vistas de vigencia |
| `0003_core_flota.sql` | Tipo de unidad con mapa declarativo, unidades, conductores (D-7) |
| `0004_core_rutas_salidas.sql` | Rutas, paradas, horarios, tarifas, salidas materializadas, cupos offline, auditoría de cambio de conductor |
| `0005_core_ventas_asientos.sql` | Clientes, ventas, boletos, **`EXCLUDE USING gist`**, leases, pagos |
| `0006_core_caja_folios.sql` | Cortes de caja, movimientos, servicio de folios particionado |
| `0007_core_eventos_config.sql` | Eventos append-only, impresión, configuración, parámetros |
| `0008_sync.sql` | Cursores, idempotencia de lotes, log de cambios, excepciones, checksums, salud |
| `0009_auth_local_vistas.sql` | Auth offline, vistas derivadas, andamiaje del esquema `api` |

Semillas, después de las migraciones:

| Archivo | Contenido |
|---|---|
| `seed/0001_tipo_unidad_sprinter18.sql` | **Mapa real de la Sprinter de 18 plazas** (`knowledge/esquema.JPG`) |
| `seed/0002_parametros_y_roles.sql` | Parámetros operativos y matriz de permisos |

## Aplicar

```bash
# Local (nodo de sucursal)
for f in src/db/migrations/*.sql src/db/seed/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
psql "$DATABASE_URL" -c \
  "UPDATE sync.nodo SET es_nube = false, sucursal_id = '<uuid>';"

# Nube (Supabase) — se despliega SIEMPRE ANTES que los nodos
psql "$SUPABASE_URL" -c "UPDATE sync.nodo SET es_nube = true;"
```

## Reglas de migración — no negociables

Derivadas del delta **D-8**: un humano actualiza las 4 terminales a mano por TeamViewer
en ventanas de madrugada, y una sucursal puede estar apagada por día no laboral y
saltarse el turno. Consecuencia: **los nodos N y N−1 conviven contra la misma nube
durante días, no horas.**

1. **Solo aditivo** en la release que expande: columnas nuevas siempre nullable o con
   `DEFAULT`.
2. **Nunca** renombrar ni borrar en la misma release. Un `DROP COLUMN` rompe al nodo
   N−1 en producción, a 6 horas de distancia y sin nadie que sepa revertirlo.
3. La fase *contract* va **una release después**, solo cuando las 4 terminales
   reportaron la versión N.
4. La nube se despliega **primero**. Debe entender N y N−1 simultáneamente.
5. Backfills en la nube, idempotentes y reejecutables.
6. Criterio de aceptación: un nodo N−1 opera **≥ 14 días** sin degradación funcional.
   Si una migración no puede cumplirlo, se parte en dos releases.

## Convenciones

- **PK siempre `uuid` v7** generado localmente. Prohibido `serial`/`identity` como PK
  de dominio: obligaría a coordinar con la nube y rompería la operación offline.
- **Borrado lógico universal** (`activo`). No hay `DELETE` físico en el dominio, y por
  eso tampoco hace falta una tabla de tombstones: un borrado es un `UPDATE` que se
  replica como cualquier otro cambio.
- **Ningún estado que cruce sucursales se guarda como campo mutable.** Se deriva de
  hechos append-only: `venta.pagado` no existe (es `SUM(pago)`), `boleto.abordo` no
  existe (es `EXISTS(evento_abordaje)`).
- `core.registrar_entidad('core.tabla')` aplica columnas estándar + trigger de outbox.
- Los supuestos numéricos viven en `core.parametro`, nunca en constantes de código.

## Estado de verificación

Las 9 migraciones y las 2 semillas se aplicaron end-to-end contra una instancia real de
PostgreSQL (18.4; el objetivo de producción es 16, y no se usa ninguna construcción
posterior a 14). Se verificaron los invariantes, no solo que el DDL compile:

| # | Verificación | Resultado |
|---|---|---|
| T1 | Mapa Sprinter sembrado: 18 asientos, 6 bloques | ✔ |
| T2 | El validador rechaza un mapa cuyos bloques no cubren los asientos | ✔ rechazado |
| T3 | Folios particionados: `A00000`, `A00001`, `B00000` | ✔ sin colisión |
| T4 | Alfabeto base32 sin `I`, `L`, `O`, `U` | ✔ |
| T5 | Reparto de cupos: 18 repartidos, 18 distintos, capacidad 18 | ✔ disjunto y completo |
| **T6** | **Sobreventa: mismo asiento, tramos solapados** | **✔ RECHAZADA por la constraint de exclusión** |
| T7 | Mismo asiento revendido en un tramo que no se solapa | ✔ permitido |
| T8 | Segundo corte de caja abierto en la misma sucursal | ✔ rechazado por la base, no por la UI |
| T9 | Saldo derivado: transferencia sin verificar no cuenta como pagada | ✔ |
| T10 | Borrado lógico sella fecha, sube `version`, alimenta el outbox | ✔ |
| T11 | `uuid_v7()` produce versión 7 y es monotónico | ✔ |
| T12 | `api.v1_boleto` responde con acentos y `ñ` correctos | ✔ |

**Bug encontrado y corregido durante la verificación**: la columna estándar de sync se
llamaba `sucursal_origen_id`, que colisiona con la columna de negocio `core.ruta.
sucursal_origen_id`. El `ADD COLUMN IF NOT EXISTS` se saltaba en silencio y el trigger de
auditoría sobrescribía el origen real de la ruta con la sucursal del nodo. Renombrada a
`sync_sucursal_id`; toda columna de infraestructura lleva prefijo `sync_`/`hlc_` para que no
pueda volver a chocar con el vocabulario del dominio.

## Lo que hay que verificar al aplicar en Supabase

- `CREATE EXTENSION btree_gist` debe tener éxito. **Sin ella no existe la garantía
  anti-sobreventa**, que es la pieza más importante del sistema. Confirmado viable: el
  proyecto es del proveedor (P6).
- La restricción de exclusión de `core.asiento_ocupacion` debe quedar creada. Verificar:

```sql
SELECT conname, contype FROM pg_constraint
 WHERE conrelid = 'core.asiento_ocupacion'::regclass AND contype = 'x';
```
