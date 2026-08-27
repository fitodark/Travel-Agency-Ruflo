# Arquitectura — Donaji Travel Agency

**Blueprint de arquitectura v0.2.** Todas las preguntas bloqueantes (P1–P4) están
cerradas. El diseño está en firme y la construcción puede arrancar.

Fuentes: `knowledge/requerimiendo-donaji.md` (requerimiento del cliente, autoritativo),
`knowledge/esquema.JPG` (mapa real de asientos, Sprinter 18 plazas) y
`knowledge/propuesta_donaji_v3_2.md` (propuesta comercial, contexto no autoritativo).

## Índice

| Documento | Contenido |
|---|---|
| [blueprint.md](blueprint.md) | Drivers, validación del requerimiento, vistas C4, stack, topología de despliegue |
| [01-sincronizacion.md](01-sincronizacion.md) | Motor de sincronización: clases de propiedad, identidad, transporte, convergencia |
| [01b-consistencia-asientos.md](01b-consistencia-asientos.md) | **El problema central**: asientos compartidos entre sucursales offline |
| [02-modelo-datos.md](02-modelo-datos.md) | Modelo de dominio: organización, flota, conductores, rutas, horarios, salidas |
| [02b-modelo-transaccional.md](02b-modelo-transaccional.md) | Ventas, boletos, pagos, caja, folios, eventos, configuración |
| [03-auth-impresion-config.md](03-auth-impresion-config.md) | Auth/autz offline, impresión térmica ESC/POS, ventana de propagación de configuración |
| [04-riesgos-roadmap.md](04-riesgos-roadmap.md) | Riesgos por severidad, puntos de extensión Etapa 2, roadmap con criterios de aceptación |
| [preguntas-tecnicas.md](preguntas-tecnicas.md) | Preguntas técnicas: 8 cerradas, 4 abiertas no bloqueantes |
| [CHANGELOG.md](CHANGELOG.md) | **Registro de cambios v0.1 → v0.2** con los 8 deltas y su impacto |

El nombre de archivo `blueprint.md` es deliberadamente neutro respecto de la versión: es
la entrada enlazada desde el resto de los documentos y no cambia entre revisiones. La
versión vigente se declara en su encabezado y su historia en [CHANGELOG.md](CHANGELOG.md).

## Implementación

| Ruta | Contenido |
|---|---|
| `src/db/migrations/` | Esquema SQL versionado (`core`, `sync`, `auth_local`, `api`) |
| `src/db/seed/` | Datos semilla: plantilla Sprinter 18, roles, parámetros |
| `src/db/README.md` | Cómo aplicar las migraciones en local y en Supabase |

## Estado

- Versión: **v0.2 — diseño en firme**
- Preguntas cerradas: P1, P2, P3, P4, P5, P6, P9, P11
- Abiertas no bloqueantes: P7 (parcial), P8, P12, y dos ítems menores (región de Supabase,
  versión exacta de Windows)
- P10 dejó de ser pregunta: es un **requisito confirmado** (respaldo local, ver CHANGELOG D-2)

## Convenciones de este blueprint

- **SUPUESTO** — decisión por defecto tomada por arquitectura; requiere validación con el cliente.
- **CONTRADICCIÓN** — inconsistencia detectada entre requerimiento y propuesta, o interna.
- **VACÍO** — información faltante que no bloquea el diseño pero sí la implementación.
- **PREGUNTA** — pregunta técnica abierta; ver `preguntas-tecnicas.md`.
- **D-n** — delta confirmado en la v0.2; ver `CHANGELOG.md`.
