# Registro de cambios — Blueprint v0.1 → v0.2

Fecha: 2026-08-26. Origen: respuestas del usuario a `preguntas-tecnicas.md`
(P1–P6, P9, P11) más el mapa real de asientos en `knowledge/esquema.JPG`.

**Estado general**: las cuatro preguntas bloqueantes quedaron cerradas. El diseño pasa de
"borrador con supuestos de infraestructura" a **diseño en firme**, y arranca el esquema de
datos con migraciones versionadas.

---

## D-1 · Topología: una sola PC por sucursal — **cambio mayor**

**Confirmado (P1)**: *"de momento solo existe una PC con el sistema instalado y que
funcionará como caja de venta"*. Nodo y caja son la misma máquina. Sucursales activas
24/7 salvo días no laborales.

**Qué cambia**
- Desaparece la sincronización intra-sucursal: la consistencia entre "cajas" es una
  transacción de PostgreSQL en `localhost`. El problema de conflictos se reduce
  **exclusivamente** al plano inter-sucursal, que es donde el diseño ya lo concentraba.
- **Se conserva la arquitectura cliente-servidor sobre `localhost`**, no se colapsa a una
  app de escritorio monolítica. Decisión explícita, justificada en
  [blueprint §4.2](blueprint.md).
- Esa PC pasa a ser **SPOF total de la sucursal**. Reordena la tabla de riesgos: R2 deja
  de ser "¿existe un nodo?" y pasa a ser "el nodo es la única máquina".
- Piso de hardware documentado: 8 GB RAM + SSD (Postgres + servicio + Chrome a la vez).

**Volumen: cerrado por cálculo, no se vuelve a preguntar.** Unidades de 18 plazas × ~20
salidas/día ≈ **360 boletos/día** como cota superior por sucursal. Irrelevante para
dimensionar PostgreSQL. Sustituye el supuesto previo de ~200 boletos/día.

**Impacto**: `blueprint.md` §4, §6; `04-riesgos-roadmap.md` §2.

---

## D-2 · Respaldo local: de prioridad media a **crítica**, y de F5 a **F0**

**Consecuencia directa de D-1.** Con una sola PC, el respaldo local es la *única*
mitigación contra perder la operación de una terminal completa.

- `pg_dump` horario a **USB o disco externo dedicado** — nunca al mismo disco, que es
  precisamente el que puede morir.
- Se mueve en el roadmap de F5 a **F0**: se instala antes que cualquier otra cosa.
- P10 deja de ser una pregunta abierta y se convierte en **requisito de instalación**.

**Impacto**: `04-riesgos-roadmap.md` §2 (R2), §3 (F0); `preguntas-tecnicas.md` P10.

---

## D-3 · UPS: de recomendación a **requisito**

Esa PC corre PostgreSQL. Un corte de luz a media escritura sin no-break puede corromper
la base de datos de la sucursal. Deja de ser una sugerencia de la propuesta comercial y
pasa a ser **requisito de instalación**: sin UPS, no se instala.

**Impacto**: `blueprint.md` §6.1; `04-riesgos-roadmap.md` §2 (R2).

---

## D-4 · Abstracción de transporte de impresión (TCP | USB) desde F0

**Confirmado (P2/P3)**: cada terminal tiene red propia; la IP de la PC puede ir por DHCP,
pero **la impresora tiene IP fija por su propia configuración**. Modelo:
**Enduro 80 mm, USB y Ethernet**, disponible físicamente para pruebas. Se ofrece USB como
alternativa porque la impresora está junto a la PC.

**Qué cambia**
- Se introduce una interfaz `EscPosTransport` con dos implementaciones, `TcpTransport` y
  `UsbTransport`, **detrás de la misma capa ESC/POS**, desde el día uno. La capa de
  formato de ticket no sabe por dónde sale el papel.
- TCP:9100 sigue siendo el transporte primario (la IP fija de la impresora lo hace viable
  tal como estaba diseñado); USB es fallback configurable, no un rediseño.
- 80 mm confirmado → 48 columnas fuente A. Se elimina la incertidumbre del ancho.

**Condición futura documentada**: la IP de la PC por DHCP es inofensiva **hoy** porque
todo es `localhost`. Deja de serlo en cuanto se agregue una segunda caja — ahí hará falta
reserva DHCP o un nombre de host para el nodo.

**Impacto**: `03-auth-impresion-config.md` §2; `04-riesgos-roadmap.md` (R6 baja de severidad).

---

## D-5 · Configuración del sistema operativo como parte del instalador

**Confirmado (P4)**: hay acceso de administrador local para instalar y ajustar el SO.
Empaquetado cerrado: **PostgreSQL 16 + servicio de Windows vía NSSM, sin Docker**.

El instalador debe además dejar la máquina en estas condiciones, cada una por una razón
operativa concreta:

| Ajuste | Por qué |
|---|---|
| Servicio con arranque automático | La terminal debe vender tras un corte de luz sin que nadie sepa iniciar nada |
| **NTP activo** | La expiración de cupos de asientos depende de que los relojes no deriven. No es cosmético: es una pieza de la garantía anti-sobreventa. Cierra la mitad de P12 |
| Plan de energía "nunca suspender" | Si la PC se duerme se cae el sync y TeamViewer no entra en la ventana de madrugada |
| Windows Update diferido a la ventana | Que no reinicie a media venta |

**Ítem abierto menor, no bloqueante**: no se especificó Windows 10 vs 11. PostgreSQL 16
corre en ambos. Nota de seguridad para el cliente: **Windows 10 ya está fuera de soporte**.

**Impacto**: `blueprint.md` §6.1; `03-auth-impresion-config.md` §4.

---

## D-6 · Mapa real de asientos: **18 plazas, no 19**

Fuente: `knowledge/esquema.JPG`. Sprinter de **18 plazas**, configuración **1+2**:

- Singles (lado del pasillo único): **1, 4, 7, 10, 13**
- Pares: **(2,3), (5,6), (8,9), (11,12)**
- Banca trasera de 4: **14, 15, 16, 17**
- Asiento **18** al frente, junto al acceso

**Qué cambia**
- Se corrige el ejemplo de reparto de cupos, que usaba 19 plazas.
- **El reparto de cupos se rehace sobre la geometría real**, con una regla nueva:
  se reparten **bloques contiguos completos** (filas o banca), nunca asientos sueltos de
  filas distintas. Consecuencia: un grupo de hasta 3 personas nunca queda separado dentro
  del cupo de su sucursal, y un grupo de 4 cabe en la banca. Ver
  [01b §3.2](01b-consistencia-asientos.md).
- Se define el formato declarativo JSON del layout y se siembra esta Sprinter como primera
  plantilla en `src/db/seed/`.

**Impacto**: `01b-consistencia-asientos.md` §3; `02-modelo-datos.md` §3;
`src/db/seed/0001_tipo_unidad_sprinter18.sql`.

---

## D-7 · Cadena conductor → unidad → tipo_unidad → esquema — **cambio de modelo**

**Confirmado (P11)**: los modelos son Sprinter, pero debe poder cargarse otro esquema desde
tabla de configuración. **El catálogo de conductores lleva asociado el tipo de unidad y el
esquema**; al seleccionar un horario asociado al conductor/unidad se muestra el esquema
correspondiente.

**Qué cambia**
- En v0.1 la unidad se asignaba al crear el horario. Ahora la cadena de resolución del mapa
  de asientos pasa por el conductor.
- **Corrección de diseño importante**: el mapa de asientos de una `salida` se
  **congela por snapshot al materializarla**, no se resuelve en vivo a través del conductor.
  Si se resolviera en vivo, un cambio de conductor —que es un evento **cotidiano**
  (enfermedad, cambio de turno)— invalidaría silenciosamente asientos ya vendidos en otras
  sucursales. El snapshot desacopla el evento operativo diario del invariante de datos.
- Se formaliza la **regla de cambio de conductor** (ver
  [02-modelo-datos.md §5](02-modelo-datos.md)), basada en **compatibilidad del mapa con los
  asientos ya vendidos**, no en igualdad de tipo de unidad.
- Cierra el pendiente del requerimiento sobre si conductores vive dentro del módulo de
  horarios: queda como **catálogo propio** con relación a unidad y esquema.

**Impacto**: `02-modelo-datos.md` §3–§5; `src/db/migrations/0003_core_flota.sql`.

---

## D-8 · Convivencia de esquemas N y N−1 medida en **días, no horas**

**Confirmado (P9)**: **solo TeamViewer**, en ventana de madrugada, **sin
auto-actualización**, migraciones retrocompatibles (nube primero, nodos después).
Respaldo 4G/LTE durante la ventana. Días no laborales pueden dejar una sucursal apagada y
saltarse una noche.

**Qué cambia**
- Un humano actualiza 4 terminales a mano: no todas quedan en la misma versión la misma
  noche, y una puede saltarse el turno por completo.
- **Expand/contract endurecido**: nodos N y N−1 deben convivir contra la misma nube durante
  **días**. Solo columnas nullable; **nunca** renombrar ni borrar en la misma release. La
  fase *contract* va **una release después**, no en la misma.
- Se deja escrita la distinción de **dos canales completamente separados**:

| Canal | Qué viaja | Cómo | Frecuencia |
|---|---|---|---|
| **Datos** | Horarios, altas/bajas de usuario, tarifas, salidas materializadas, cupos | Automático, como filas con `effective_from` | Continua |
| **Binarios** | Ejecutable del nodo y migraciones de esquema | Manual por TeamViewer en la ventana | Por release |

La configuración **nunca** depende de que alguien entre por TeamViewer. Solo el software
lo hace.

**Impacto**: `03-auth-impresion-config.md` §4; `04-riesgos-roadmap.md` §2 (R-nuevo), §3 (F9).

---

## Deltas adicionales validados

### P5 → stack cerrado: **TypeScript end-to-end**

La respuesta confirma que habrá **equipo propio de mantenimiento**, formado a la par de la
construcción, pero no declara dominio previo de .NET. La decisión vuelve a arquitectura y
se toma el default: **Node 22 + Fastify + React**.

**Revertible hasta F1, no después.** Si aparece experiencia previa fuerte en .NET antes de
que arranque F1, la decisión debe reabrirse; después del esquema y el motor de sync, no.

### P6 → Supabase a nombre del proveedor, plan Pro pagado por el cliente

**Cierra el bloqueo técnico principal**: el proveedor controla la cuenta, así que puede
habilitar `btree_gist` y `plpgsql`. La garantía dura anti-sobreventa
(`EXCLUDE USING gist`) es **viable y confirmada**.

Dos pendientes registrados:

1. **Falta elegir región.** No existe región de Supabase en México; la más cercana es
   East US. Default adoptado: **East US**.
2. **Riesgo de continuidad — registrado, sin cambiar la decisión.** La operación del
   cliente, los datos personales de sus pasajeros (nombre, teléfono, email) y los sueldos
   de sus empleados viven en una cuenta que el cliente no controla. Es el modelo de negocio
   del proveedor y es coherente con que él dé el mantenimiento. Dos mitigaciones concretas:
   - **Export automático periódico** (`pg_dump` completo) entregado al cliente.
   - **Procedimiento de handover documentado en el contrato**.

   Ver R11 en `04-riesgos-roadmap.md`.

---

## Pendientes abiertos que no bloquean

| # | Estado | Nota |
|---|---|---|
| P7 | **Parcialmente respondido** | Confirmado que es de **solo lectura, para visualizar reportes**. Falta el mecanismo de acceso y qué campos necesita. Bloquea *congelar* el esquema `api`, no arrancar `core`. |
| P8 | Abierto | Calibración de umbrales de sync. El respaldo 4G/LTE lo alivia parcialmente. |
| P12 | Medio cerrado | NTP resuelto por D-5. Falta confirmar zona horaria de las 4 sucursales. |
| — | Abierto menor | Región de Supabase (default East US) y versión exacta de Windows. |
