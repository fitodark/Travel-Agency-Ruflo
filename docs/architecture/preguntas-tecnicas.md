# Preguntas Técnicas — Estado v0.2

> **Las cuatro preguntas bloqueantes (P1–P4) están cerradas.** No queda nada que impida
> diseñar en firme ni empezar a construir.
>
> Cerradas: **P1, P2, P3, P4, P5, P6, P9, P11**.
> P10 dejó de ser pregunta: es un **requisito confirmado**.
> Abiertas no bloqueantes: **P7 (parcial), P8, P12** y dos ítems menores.
>
> Las respuestas del usuario se conservan íntegras. Cada pregunta cerrada lleva la
> **resolución adoptada** y el delta correspondiente del [CHANGELOG](CHANGELOG.md).

| # | Tema | Estado | Delta |
|---|---|---|---|
| P1 | Hardware por sucursal, cajas, volumen | ✅ **Cerrada** | D-1, D-2, D-3 |
| P2 | LAN, IPs fijas, salida HTTPS | ✅ **Cerrada** | D-4 |
| P3 | Modelo de impresora, ancho, ESC/POS, QR | ✅ **Cerrada** | D-4 |
| P4 | SO y políticas de TI | ✅ **Cerrada** | D-5 |
| P5 | Stack del equipo | ✅ **Cerrada** | — |
| P6 | Supabase: plan, región, titularidad | ✅ **Cerrada** (con riesgo registrado) | — |
| P7 | El "otro sistema" que consume la nube | 🟡 **Parcial** | — |
| P8 | Conectividad y duración de cortes | 🔴 Abierta | — |
| P9 | Despliegue y actualizaciones | ✅ **Cerrada** | D-8 |
| P10 | Respaldo local | ✅ **Requisito confirmado** (ya no es pregunta) | D-2 |
| P11 | Unidades y mapa de asientos | ✅ **Cerrada** | D-6, D-7 |
| P12 | Zona horaria y NTP | 🟡 **Parcial** (NTP resuelto) | D-5 |

---

## ✅ P1. Hardware por sucursal — CERRADA

**Respuesta del usuario**: *"de momento solo existe una PC con el sistema instalado y que
funcionara como caja de venta."*
*"[…] las sucursales estan activas 24/7, salvo algunas excepciones por dias no laborales."*

**Resolución adoptada (D-1, D-2, D-3)**
- **Una sola PC por sucursal**, que es simultáneamente nodo y caja. Desaparece la
  sincronización intra-sucursal: la consistencia es una transacción de PostgreSQL en
  `localhost`.
- Se **conserva la arquitectura cliente-servidor sobre `localhost`** (no app monolítica),
  justificada en [blueprint §4.2](blueprint.md): el servicio debe correr con la UI
  cerrada (ventana de madrugada, drenaje de outbox, respaldo, cola de impresión), y agregar
  una segunda caja debe ser apuntar otro Chrome, no un rediseño.
- Esa PC es **SPOF total** → R2 en [04 §2](04-riesgos-roadmap.md). Consecuencias:
  **respaldo local pasa a crítico y a F0** (D-2) y **UPS pasa de recomendación a requisito**
  (D-3).
- Piso de hardware: **8 GB RAM + SSD**.
- **Volumen cerrado por cálculo, no se vuelve a preguntar**: 18 plazas × ~20 salidas/día
  ≈ **360 boletos/día** como cota superior por sucursal. Irrelevante para dimensionar
  PostgreSQL.
- Sucursales 24/7 → la máquina está encendida en la ventana de madrugada, lo que cierra la
  dependencia que P9 tenía sobre P1.

---

## ✅ P2. Red LAN de la terminal — CERRADA

**Respuesta del usuario**: *"cada terminal tiene su red propia; la IP de la PC/Caja puede
estar habilitada por DHCP pero la IP de la impresora via Ethernet no, esta si es fija dada
la configuracion de la impresora; en caso de que sea un tema complejo su manejo por IP fija,
es una impresora que esta a lado de la PC y podria conectarse por USB como ultimo caso."*

**Resolución adoptada (D-4)**
- La impresora tiene **IP fija por su propia configuración** → **TCP:9100 funciona tal como
  estaba diseñado**. No hace falta reserva DHCP para ella.
- La IP de la PC por DHCP es **inofensiva hoy** porque todo es `localhost` (D-1).
  **Condición futura registrada**: deja de serlo en cuanto haya una segunda caja; ahí hará
  falta reserva DHCP o un nombre de host estable para el nodo.
- Se acepta el ofrecimiento de USB, pero **como transporte alternativo de primera clase**,
  no como "último caso": ver P3.

---

## ✅ P3. Impresora térmica — CERRADA

**Respuesta del usuario**: *"si se contara con una unidad fisica marca Enduro 80mm Usb Y Red
Ethernet para las pruebas."*

**Resolución adoptada (D-4)**
- **80 mm confirmado → 48 columnas** fuente A. Se elimina la incertidumbre del ancho, que
  era la parte del diseño que no se podía dejar para después.
- Unidad física disponible → la **PoC de impresión se hace en F0**, antes de escribir el
  resto: `GS ( k` (QR nativo), code page, acentos y `ñ`, velocidad.
- **Se introduce la interfaz `EscPosTransport`** con `TcpTransport` y `UsbTransport` detrás
  de la misma capa ESC/POS, **desde el día uno**. La capa de formato no sabe por dónde sale
  el papel; cambiar de transporte es una fila en `config_impresora`, no un redeploy. Ver
  [03 §2.1](03-auth-impresion-config.md).
- **Efecto en riesgos**: R15 baja de severidad alta a media.

---

## ✅ P4. Sistema operativo y políticas de TI — CERRADA

**Respuesta del usuario**: *"se tiene acceso de administrador para instalar lo necesario
para el sistema y poder hacer ajustes a la configuracion del SO."*

**Resolución adoptada (D-5)**
- Empaquetado cerrado: **PostgreSQL 16 + servicio de Windows vía NSSM, sin Docker.**
- El instalador además deja la máquina configurada, cada ajuste por un modo de falla
  concreto ([03 §5](03-auth-impresion-config.md)): servicio con arranque automático,
  **NTP activo**, plan de energía "nunca suspender", **Windows Update diferido a la
  ventana**, excepciones de antivirus para el directorio de datos de PostgreSQL, y regla de
  firewall local para el puerto del servicio.
- NTP no es cosmético: la expiración de cupos de asientos depende de que los relojes no
  deriven. Esto cierra la mitad de P12.

**Ítem abierto menor, no bloqueante**: no se especificó **Windows 10 vs 11**. PostgreSQL 16
corre en ambos. **Nota de seguridad para el cliente: Windows 10 ya está fuera de soporte.**

---

## ✅ P5. Stack del equipo — CERRADA

**Respuesta del usuario**: *"El equipo de desarrollo dara mantenimiento a largo plazo, es
decir existira un equipo que llevara a la par la contruccion y tendra el conocimiento para
realizar ajustes al sistema y poder actualizar las terminales en tiempo y forma."*

**Resolución adoptada**
- La respuesta confirma que habrá equipo propio de mantenimiento, pero **no declara dominio
  previo de .NET**. La decisión vuelve a arquitectura y se toma el default:
  **TypeScript end-to-end — Node 22 + Fastify + React.**
- **Revertible hasta el inicio de F1, no después.** Si aparece experiencia previa fuerte en
  .NET antes de F1, la decisión debe reabrirse; después del esquema y el motor de sync, no.

### Ratificación al cerrar F0 (2026-08-26)

Se reabrió deliberadamente antes de arrancar F1, que es el punto de no retorno.

**Aclaración del usuario**: *"el equipo puede sostener ambas, pero para que esté todo
homologado, es decir FE con React […] entonces podemos decidir que el motor de
sincronización tenga que ser de igual manera con TypeScript"*.

Es decir, la restricción no era capacidad del equipo sino **homologación**. Eso convierte
el argumento de unificación —que en v0.1 era una preferencia— en el criterio decisivo.

**Evidencia acumulada durante F0.** El único argumento vivo a favor de .NET era su mejor
integración con Windows. De los tres puntos concretos, dos quedaron resueltos
empíricamente en TypeScript:

| Preocupación | Estado |
|---|---|
| Impresión ESC/POS cruda en Windows | **Resuelto**: `winspool.drv` por P/Invoke desde PowerShell, sondeado con éxito contra dos colas reales |
| Tareas programadas como SYSTEM | **Resuelto**: script de `Register-ScheduledTask` escrito y parametrizado |
| Servicio de Windows | **Sin verificar**: se asume NSSM; no se ha instalado todavía |

**Costo que sí conserva TypeScript, registrado como riesgo.** .NET produce un ejecutable
autocontenido; Node exige runtime más `node_modules` en cada terminal. Bajo D-8 —cuatro
equipos actualizados a mano por TeamViewer en la madrugada— eso es más superficie por
copiar y más que puede quedar a medias. **Mitigación a evaluar en F1**: empaquetar el nodo
con Single Executable Application de Node para volver el despliegue un archivo.

**Argumento adicional que inclina la balanza y no estaba en v0.1**: hay contratos que
cruzan la frontera cliente/servidor —el mapa de asientos (`mapa_snapshot`), el formato de
texto del QR, el lote de `sync.ingest_batch`— y con un solo lenguaje son **una definición
de tipos compartida**. Con dos lenguajes son dos definiciones que divergen, y el mapa de
asientos es justo donde una divergencia silenciosa cuesta un pasajero sin lugar.

**Estado: cerrada y ya no reversible.** TypeScript end-to-end.

---

## ✅ P6. Supabase — CERRADA, con riesgo registrado

**Respuesta del usuario**: *"el proyecto queda a nombre del proveedor; el cliente unicamente
cubre el costo del plan Pro ya que el proveedor tiene a su cargo el mantenimiento y resolver
detalles que surgan en la operacion."*

**Resolución adoptada**
- **Cierra el bloqueo técnico principal**: el proveedor controla la cuenta, así que puede
  habilitar `btree_gist` y `plpgsql`. **La garantía dura anti-sobreventa
  (`EXCLUDE USING gist`) es viable y confirmada**, no un supuesto.
- Plan **Pro** confirmado.
- **Falta elegir región.** No existe región de Supabase en México; la más cercana es
  **East US**, que se adopta como default.
- **Riesgo de continuidad registrado (R11), sin cambiar la decisión.** La operación del
  cliente, los **datos personales de sus pasajeros** (nombre, teléfono, email) y los
  **sueldos de sus empleados** viven en una cuenta que el cliente no controla. Es el modelo
  de negocio del proveedor y es coherente con que él dé el mantenimiento. Dos mitigaciones
  concretas y exigibles:
  1. **Export automático periódico** (`pg_dump` completo, semanal) entregado al cliente, en
     formato restaurable sin el proveedor. Entra en F8.
  2. **Procedimiento de handover documentado en el contrato**: qué se entrega, en cuánto
     tiempo y bajo qué condiciones se transfiere el proyecto.

---

## 🟡 P7. El "otro sistema" que consume la BD en la nube — PARCIAL

**Respuesta del usuario**: *"si sera un sistema de solo lectura para visualizar reportes."*

**Qué queda confirmado**: es **solo lectura**, para reportes. Eso descarta el escenario más
caro: no hay que tratarlo como un escritor ni meterlo en el modelo de conflictos.

**Qué falta**: el **mecanismo de acceso** (API REST de Supabase, conexión PostgreSQL
directa, replicación, exportaciones), **qué campos necesita** y **quién lo desarrolla**.

**Por qué no bloquea**: bloquea *congelar* el esquema `api`, no arrancar `core`. Se sigue con
el andamiaje: vistas versionadas `api.v1_*` desde F1, documentadas como el único contrato
soportado. Si ese sistema se conectara directo a las tablas operativas, cualquier cambio de
esquema nuestro lo rompería — por eso el esquema `api` existe desde el principio aunque no
esté cerrado.

**Cuándo hace falta la respuesta**: antes de F8.

---

## 🔴 P8. Conectividad de cada sucursal — ABIERTA

**Pregunta**: ¿Qué tipo de enlace tiene cada terminal (fibra, cable, antena, 4G/LTE)?
¿Ancho de banda aproximado, cada cuánto se cae y por cuánto tiempo?

**Por qué importa**: **calibra dos parámetros del diseño**: cuánto puede durar un cupo de
asientos apartado antes de devolverse (S5, hoy T−4 h) y a partir de cuántas horas sin
sincronizar la sucursal entra en modo degradado (S9, hoy 72 h). Con cortes de horas los
defaults sirven; con cortes de días hay que repartir cupos más generosos y alargar el umbral.

**Aliviada parcialmente**: P9 confirma que hay **respaldo 4G/LTE** disponible al menos
durante la ventana de actualización.

**Se asume mientras tanto**: cortes de hasta 24 h, excepcionales de hasta 72 h. Ambos
parámetros viven en `core.parametro` y se ajustan con una fila, sin desplegar.

---

## ✅ P9. Despliegue y actualizaciones — CERRADA

**Respuesta del usuario**: *"unicamente se actualizara via TeamViewer en la ventana de tiempo
establecida por las madrugadas. Migraciones de esquema retrocompatibles (se despliega la nube
primero, los nodos después)."*
Y de P1: *"para los updates y migraciones del sistema se tiene contemplado tener una ventana
amplia para poder actualizar las 4 sucursales […] un respaldo dada la conexion que pudiera
llegar a fallar en la ventana de tiempo es conectar un dispositivo 4G/LTE, todo esto
programado con el cliente."*

**Resolución adoptada (D-8)**
- **Solo TeamViewer, sin auto-actualización.** Un humano actualiza 4 terminales a mano, y
  una puede saltarse la noche por día no laboral.
- Consecuencia dura: **los nodos N y N−1 conviven contra la misma nube durante días, no
  horas.** Expand/contract endurecido: solo columnas nullable; **nunca** renombrar ni borrar
  en la misma release; la fase *contract* va **una release después**. Criterio: N−1 debe
  operar ≥ 14 días sin degradación. Ver [01 §7](01-sincronizacion.md).
- **Dos canales separados**, explícitos en el diseño ([03 §4](03-auth-impresion-config.md)):

| Canal | Qué viaja | Cómo |
|---|---|---|
| **Datos** | Horarios, altas/bajas de usuario, tarifas, salidas, cupos | Automático, filas con `effective_from` |
| **Binarios** | Ejecutable del nodo y migraciones de esquema | Manual, TeamViewer, ventana |

  **La configuración nunca depende de que alguien entre por TeamViewer.** Solo el software.
- Procedimiento de ventana definido, incluida la regla de **no actualizar una terminal cuyo
  respaldo de la última hora no exista**.

---

## ✅ P10. Respaldo local — REQUISITO CONFIRMADO (ya no es pregunta)

Consecuencia directa de D-1: con **una sola PC**, el respaldo local es la **única**
mitigación contra perder la operación completa de una terminal.

**Requisito adoptado (D-2)**
- `pg_dump` **horario a USB o disco externo dedicado** — **nunca al mismo disco**, que es
  precisamente el que puede morir.
- Retención 7 días; verificación de restauración.
- **Movido en el roadmap de F5 a F0**: se instala antes de que exista un solo dato que
  perder.
- Sube en la tabla de riesgos: es la mitigación #1 de R2, ahora severidad crítica.

**Recomendación adicional al cliente, fuera del alcance de arquitectura**: una **segunda PC
de repuesto**, al menos en la matriz. Es la mitigación que falta y no la puede resolver el
software.

---

## ✅ P11. Unidades y mapa de asientos — CERRADA

**Respuesta del usuario**: *"los modelos son sprinter pero si debe poder asociarse otro
esquema y cargarlo ya sea en una tabla de configuracion o una tabla especifica de esquemas;
se deja un ejemplo en la siguiente ruta: knowledge/esquema.JPG; el catalogo de conductores
debe asociarse el tipo de unidad manejan y esquema a utilizar; cuando se seleccione un
horario asociado al conductor o a la unidad se mostrara el esquema asociado."*

**Resolución adoptada (D-6, D-7)**

**Mapa real — 18 plazas, no 19**: configuración 1+2; singles **1, 4, 7, 10, 13**; pares
**(2,3), (5,6), (8,9), (11,12)**; banca trasera de 4 **14–17**; asiento **18** al frente
junto al acceso. Layout declarativo en `tipo_unidad.mapa` (JSON), sembrado en
`src/db/seed/0001_tipo_unidad_sprinter18.sql`.

**Reparto de cupos rehecho sobre la geometría real**: se reparten **bloques contiguos
completos** (filas o banca), nunca asientos sueltos de filas distintas — de lo contrario
una pareja que compra en una sucursal intermedia quedaría separada aunque la unidad vaya
casi vacía. Ver [01b §3](01b-consistencia-asientos.md).

**Cadena conductor → unidad → tipo_unidad → esquema** implementada, con una corrección de
diseño importante: **el mapa de una salida se congela por snapshot al materializarla**, no
se resuelve en vivo por el conductor. Si se resolviera en vivo, un cambio de conductor
—que es **cotidiano**— invalidaría silenciosamente asientos ya vendidos en otras sucursales.

**Regla de cambio de conductor** formalizada en [02 §5](02-modelo-datos.md), basada en
**compatibilidad del mapa con los asientos realmente vendidos**, no en igualdad de tipo de
unidad: es más segura (dos unidades del mismo tipo pueden tener mapas distintos si el
catálogo se editó) y menos restrictiva (permite sustituciones seguras que la regla por tipo
bloquearía sin razón).

**Cierra además** el pendiente del requerimiento sobre si conductores vive dentro del módulo
de horarios: queda como **catálogo propio**.

---

## 🟡 P12. Zona horaria y NTP — PARCIAL

**NTP: resuelto por D-5** — queda activo como parte del instalador, no como recomendación.
Esto era la mitad crítica de la pregunta, porque la devolución automática de cupos de
asientos depende de que los relojes no deriven más de 15 minutos.

**Falta confirmar**: ¿las 4 sucursales están en la misma zona horaria? ¿Se planea abrir
alguna en otra zona (Baja California, Sonora, franja fronteriza)?

**Se asume**: todas en `America/Mexico_City`. Cada sucursal **ya guarda su zona horaria como
dato** (`sucursal.zona_horaria`), así que abrir una en otra zona no requiere rediseño. Alerta
de deriva a los 2 minutos, modo degradado a los 5.

**No bloquea**: con NTP activo y la zona muerta de 15 min, el riesgo residual es bajo.

---

## Ítems abiertos menores

| Ítem | Default adoptado | Cuándo hace falta |
|---|---|---|
| Región de Supabase | East US (no hay región en México) | Antes de crear el proyecto de producción |
| Windows 10 vs 11 | PostgreSQL 16 corre en ambos. **Windows 10 está fuera de soporte** — nota de seguridad para el cliente | Antes de F9 |
| Layout físico exacto del acceso (lado de la puerta) | Se modela según `knowledge/esquema.JPG`; solo afecta el render visual, ningún invariante | Antes de F4 |
