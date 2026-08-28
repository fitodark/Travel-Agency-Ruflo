# 04 — Riesgos, Extensión a Etapa 2 y Roadmap

> Blueprint v0.2. Riesgos reordenados por el delta D-1 (una sola PC por sucursal).
> Respaldo local movido a F0 (D-2). Impresión baja de severidad (D-4).

---

## 1. Puntos de extensión para la Etapa 2 (paquetería)

El requerimiento exige que la Etapa 2 *"solo sume un nuevo módulo al sistema"*, sin
rediseño. Eso no se logra escribiendo el módulo después; se logra dejando **cinco costuras
genéricas desde la Etapa 1**. Ninguna añade esfuerzo significativo ahora y todas serían
caras de retrofitear.

| # | Costura | Cómo queda en Etapa 1 | Qué hace la Etapa 2 |
|---|---|---|---|
| E1 | **Servicio de folios** | Generador particionado por sucursal (`02b §1`), no acoplado a `boleto` | Pide un folio para el número de control del paquete. Cero código nuevo. |
| E2 | **Movimiento de caja polimórfico** | `movimiento_caja.origen_tipo` + `origen_id`, con `'pago_paqueteria'` ya en el CHECK | El cobro del envío suma al corte sin tocar el módulo de caja. Cubre "cobro en origen o destino" igual que la reservación. |
| E3 | **Spooler por plantilla** | `print_job.template_key` como texto; el renderer se resuelve por tabla y el transporte está abstraído (D-4) | Añade `template_key='etiqueta_paquete'`. La etiqueta con QR usa el mismo camino ESC/POS y el mismo transporte. |
| E4 | **Manifiesto genérico de salida** | `salida` no depende de `boleto`; el manifiesto se construye por consulta | Los paquetes se asocian a una `salida` como otro tipo de ítem. El conductor lleva una sola lista. |
| E5 | **Eventos append-only de custodia** | El patrón ya existe y está probado con `evento_abordaje`, `evento_salida` y `cambio_conductor` (clase C) | `evento_custodia` (enviado / en ruta / recibido / entregado) es la misma forma. Converge sin conflicto entre origen y destino, que es **exactamente** el problema de la paquetería. |

Adicionalmente:
- El **escáner de código de barras** de la propuesta es un dispositivo HID (se comporta como
  teclado). No requiere arquitectura nueva: un campo con foco.
- La clase D (capacidad compartida) **no aplica** a paquetería: un paquete no compite por un
  recurso finito identificado como el asiento. Si más adelante se limita el cupo de carga
  por unidad, se reutiliza `cupo_offline` con otro tipo de recurso.

**Lo que sí habrá que revisar en Etapa 2**: si el paquete puede cambiar de unidad a medio
camino (transbordo), aparece un estado que cruza sucursales — se resuelve con E5 (un evento),
no con un campo mutable.

---

## 2. Riesgos, ordenados por severidad

### Severidad crítica

**R1 — Sobreventa del mismo asiento entre sucursales desconectadas.**
*Impacto*: pasajero con boleto pagado e impreso sin lugar en la unidad. Daño reputacional
directo al cliente final y a la agencia.
*Mitigación*: cupo offline particionado en **bloques contiguos disjuntos** (imposibilita el
conflicto offline) + lease en línea + `EXCLUDE` constraint en local y nube + arbitraje
determinista + reasignación automática + marca en el manifiesto de abordaje. Ver
[01b-consistencia-asientos.md](01b-consistencia-asientos.md).
*Riesgo residual*: deriva de reloj u override manual → cola de excepciones.
*Estado v0.2*: **`btree_gist` confirmado disponible** (P6). La garantía dura deja de ser un
supuesto.

**R2 — La sucursal tiene una sola PC: es SPOF total.** *(reformulado por D-1)*
*Impacto*: si muere el disco o la fuente, la terminal **no vende** y se pierden todas las
ventas aún no sincronizadas. No hay segunda máquina a la cual mover la operación.
*Mitigación*, en orden de efectividad:
1. **`pg_dump` horario a medio externo dedicado** (D-2) — nunca al mismo disco. Es la única
   defensa real. **Movido a F0.**
2. **UPS obligatorio** (D-3): PostgreSQL escribiendo durante un corte de luz puede corromper
   la base. Sin UPS no se instala.
3. Indicador permanente en la UI con el número de operaciones pendientes de subir, para que
   el operador sepa cuánto está en riesgo en ese momento.
4. Procedimiento de contingencia en papel: venta manual contra el manifiesto impreso y
   captura posterior. Runbook entregado en F9.
5. Restauración documentada en < 30 min sobre una máquina limpia, probada en F9.
*Riesgo residual*: hasta 1 h de operación entre respaldos. **Se recomienda formalmente al
cliente una segunda PC de repuesto por sucursal** o al menos una en la matriz; es la
mitigación que falta y no es decisión de arquitectura.

**R3 — Pérdida silenciosa de datos entre local y nube.**
*Impacto*: el peor modo de falla de un sistema de sync: nadie lo nota hasta el cierre de
mes, y para entonces la evidencia física ya no existe.
*Mitigación*: reconciliación diaria por checksum de bloques, tablero de salud, alerta por
outbox estancado, y outbox append-only que nunca se purga sin ACK.

**R4 — Usuario dado de baja sigue operando en una sucursal incomunicada.**
*Mitigación*: fecha efectiva como dato + stale-guard a 72 h + código de revocación HOTP
fuera de banda ([03 §1.5](03-auth-impresion-config.md)).
*Riesgo residual*: ventana entre la baja y la siguiente sincronización o llamada.

### Severidad alta

**R5 — Deriva de reloj rompe la expiración de cupos.**
*Mitigación*: **NTP activo es parte del instalador** (D-5), HLC para orden causal, zona
muerta de 15 min, alerta a los 2 min, modo degradado a los 5.
*Estado v0.2*: mitigado a nivel de instalación, ya no depende de la buena voluntad del sitio.

**R6 — Cambio de conductor invalida asientos vendidos.** *(nuevo, D-7)*
*Impacto*: el cambio de conductor es **cotidiano**; si arrastra el mapa de asientos, un
relevo rutinario puede dejar sin asiento a boletos ya impresos en otras sucursales.
*Mitigación*: el mapa se **congela por snapshot al materializar la salida** y no se resuelve
en vivo por el conductor; regla de compatibilidad basada en los asientos realmente vendidos;
el caso incompatible exige conexión y reutiliza la cola de reasignación de R1. Ver
[02 §5](02-modelo-datos.md).

**R7 — Convivencia prolongada de versiones N y N−1.** *(nuevo, D-8)*
*Impacto*: un humano actualiza 4 terminales a mano en madrugadas; una puede saltarse la
noche por día no laboral. Una migración destructiva rompería esa terminal en producción, a
horas de distancia y sin nadie que sepa revertirla.
*Mitigación*: expand/contract estricto, *contract* una release después, la nube se despliega
primero, `ingest_batch` tolera campos desconocidos, el nodo declara su versión en cada lote
y el tablero muestra qué terminal quedó atrás. Criterio: N−1 debe operar ≥ 14 días sin
degradación ([01 §7](01-sincronizacion.md)).

**R8 — Cronograma: 4 meses prometidos vs. 5–6 meses estimados.**
*Mitigación*: recortar el MVP por donde la propuesta ya declara "se libera después"
(dashboard y reportes avanzados en nube). Ver C3 en el blueprint.

**R9 — Contrato roto con "el otro sistema" que consume la nube.**
*Mitigación*: esquema `api` con vistas versionadas desde el día 1.
*Estado v0.2*: P7 parcialmente respondida — es **solo lectura, para reportes**. Falta el
mecanismo de acceso y los campos. El esquema `api` queda andamiado pero no congelado.

### Severidad media

**R10 — Política de TI o antivirus interfiere con PostgreSQL.**
*Estado v0.2*: **muy reducido** (P4: hay acceso de administrador). Queda la parte de
antivirus, cubierta por las excepciones que aplica el instalador (D-5).

**R11 — Continuidad: la cuenta de Supabase es del proveedor.** *(nuevo, P6)*
*Impacto*: la operación del cliente, los **datos personales de sus pasajeros** (nombre,
teléfono, email) y los **sueldos de sus empleados** viven en una cuenta que el cliente no
controla. Si la relación comercial termina o el proveedor desaparece, el cliente no tiene
acceso directo a su propia información.
*Decisión*: **no se cambia**. Es el modelo de negocio del proveedor y es coherente con que
él dé el mantenimiento.
*Mitigaciones concretas y exigibles*:
1. **Export automático periódico** (`pg_dump` completo, semanal) entregado al cliente en un
   formato que pueda restaurar sin el proveedor.
2. **Procedimiento de handover documentado en el contrato**: qué se entrega, en cuánto
   tiempo y bajo qué condiciones se transfiere el proyecto de Supabase.

**R12 — QR de texto plano falsificable.** → HMAC truncado en el mismo texto
([03 §2.4](03-auth-impresion-config.md)). Propuesta a validar; su ausencia no bloquea nada.

**R13 — Colisión de folios.** → Imposible por construcción con el particionamiento de
[02b §1](02b-modelo-transaccional.md); `UNIQUE` en nube como detector de bug. Límite
conocido y documentado: 32 sucursales.

**R14 — Duplicación de clientes entre sucursales.** → No se fusionan automáticamente; se
genera un reporte de posibles duplicados por teléfono normalizado.

**R15 — La impresora no soporta `GS ( k` (QR nativo), o el code page corrompe acentos.**
*Estado v0.2*: **baja de severidad alta a media.** 80 mm confirmado, unidad física
disponible, y el fallback raster más la abstracción TCP/USB (D-4) están en el diseño desde
F0. Queda solo la verificación empírica en la PoC.

### Severidad baja

**R16 — Escalar más allá de 32 sucursales.** → Requiere folio de 7 caracteres o alfabeto
mayor. Documentado, no mitigado; la agencia tiene 4.

**R17 — Rutas con 5+ paradas vendedoras agotan los bloques de reparto.** → Con 6 bloques y
5 paradas el origen quedaría con uno solo, lo cual es operativamente absurdo. Se degradaría
a reparto por fila partida o a mayor dependencia del lease. Documentado en
[01b §3.5](01b-consistencia-asientos.md); no se alcanza con 4 sucursales.

**R18 — Windows 10 fuera de soporte.** → Ítem abierto menor; PostgreSQL 16 corre igual.
Nota de seguridad para el cliente.

---

## 3. Roadmap de implementación

Estimación con 2 desarrolladores. F1–F4 son secuencialmente dependientes; F5–F8 admiten
paralelización parcial.

### F0 — Descubrimiento técnico, PoCs y **respaldo** (1–2 semanas)

**Objetivo**: eliminar las incógnitas empíricas y dejar instalada la única defensa contra
R2 antes de que exista un solo dato que perder.

- **PoC de impresión con la Enduro física**: ticket real con QR. Verificar `GS ( k`, ancho
  de 48 columnas, code page y acentos, velocidad. **Probar los dos transportes**
  (`TcpTransport` y `UsbTransport`) — la abstracción se construye aquí, no después (D-4).
- **PoC de sync**: dos instancias PostgreSQL locales + un Supabase de prueba; outbox, pull y
  una `EXCLUDE USING gist` funcionando end-to-end con 2 escritores.
- **Respaldo local operativo** (D-2, movido desde F5): `pg_dump` horario a medio externo
  dedicado, con verificación de restauración.
- Instalador base con la configuración de SO de D-5 (servicio, NTP, energía, Windows Update,
  excepciones de antivirus).
- Definición andamiada del esquema `api`.

**Criterio de aceptación**: un ticket físico impreso correctamente por ambos transportes; una
escritura que viaja de local a nube y vuelve a otra réplica; y un respaldo restaurado con
éxito en una máquina limpia. Si esto no ocurre en F0, no se avanza a F1.

### F1 — Núcleo de datos y motor de sincronización (3–4 semanas)

- Esquema completo `core` + `sync`, migraciones **compartidas** local/nube (ya iniciado en
  `src/db/migrations/`).
- Outbox, cursores, `ingest_batch` idempotente, HLC, clases A/B/C.
- Sync unidireccional de configuración (nube → sucursal).
- Reconciliación por checksum y tablero de salud, incluyendo **versión de esquema por nodo**
  (D-8).

**Criterios de aceptación**
- 500 escrituras locales con red caída 72 h → 100% presentes en nube tras reconectar.
- Reenvío del mismo lote 3 veces → cero duplicados.
- Checksum idéntico local/nube tras convergencia.
- Un cambio de configuración en la nube aparece en las 4 sucursales.
- **Un nodo simulado en versión N−1 opera contra la nube N sin errores.**

> **Punto de no retorno del stack**: la decisión de TypeScript vs .NET (P5) es reversible
> hasta el inicio de F1 y no después.

### F2 — Auth, sucursales, clientes, configuración (2 semanas)

- Login offline con Argon2id, selección de sucursal, RBAC por tabla, sesiones.
- CRUD de sucursales, usuarios, clientes, configuración de impresora y de ticket.
- Aplicador de configuración con `effective_from` y ventana nocturna.
- Stale-guard y modo degradado.

**Criterios de aceptación**
- Login exitoso con la red desconectada y con la nube caída.
- Baja programada a las 03:00 → el usuario no puede entrar al día siguiente.
- Baja recibida con `effective_from` ya vencido → se aplica al recibirla.
- Sin sync por 73 h → banner de degradación y bloqueo de primer login.

**Entregado en F2**: login offline, aplicador de configuración, stale-guard y
modo degradado, y **solo el CRUD de clientes** (clase B, la terminal es su
dueña). El CRUD de la configuración clase A —usuarios, sucursales, tarifas,
impresora, ticket— se difirió a "el dashboard en nube"; F8 se construyó como
reportes de solo lectura y ese alcance quedó sin hacer. Se retoma en F2b.

### F2b — Consola de administración en la nube (2.5–3 semanas) — **HECHA**

> Añadida tras el cierre de F8. Es el CRUD de configuración clase A que F2 no
> entregó, reordenado para hacerse **antes de endurecer la venta**: sin él no se
> pueden dar de alta usuarios reales con roles repartidos entre sucursales, y sin
> eso no se prueban en serio los permisos, la caja, los viajes ni los cierres.
>
> **Cerrada el 2026-08-28** (PRs #21–#30, migraciones 0034–0038). `src/admin/` con
> los cuatro slices + la deuda (rol `donaji_consola`, `rbac.activo`) + la UI web
> (`consola.html`/`consola.js`, 5 pestañas). `npm run admin`. Solo falta el
> despliegue: `ALTER ROLE donaji_consola ... LOGIN PASSWORD` y las variables de
> entorno de la consola. Ver `docs/historial.md` §"F2b — CERRADA".

**Ya está y no se rehace**: `sync.publicar_a_nodos`, `sync.ingest_fila` sin
efectos locales (0014), el aplicador de configuración, las vistas `v_*_vigente`
con `effective_from`, `src/sync/bootstrap.ts` y el RBAC replicado. Falta solo la
superficie de autoría y tres huecos de cableado.

- **Slice 1 · Cimientos**. Servicio Node aparte (`src/admin/`), desplegado junto
  a la nube. Auth del administrador con **Supabase Auth** (GoTrue) — aquí sí
  sirve, el internet es prerrequisito en la nube (03 §1.1). Rol de Postgres de
  escritura dedicado, distinto del de reportes, acotado a las tablas clase A y a
  auditoría (P6). Helper `escribirConfig(tabla, fila, { modo })` con los tres
  modos de §3.2 (ventana / inmediato / programado) y el filtro expand/contract de
  D-8. Migración: registrar `auth_local.credencial` en el pipeline clase A
  (`publicar_a_nodos` + columnas de sync + `clases.ts` + `bootstrap.ts`) — hoy no
  baja, y 03 §1.2 lo da por hecho.
- **Slice 2 · Sucursales**. CRUD `core.sucursal` (código único, tope 32;
  dirección, teléfono, `zona_horaria`), baja con `effective_until`. Al alta:
  generar la semilla `auth_local.revocacion_hotp`; el nodo crea su
  `core.folio_secuencia` en el bootstrap.
- **Slice 3 · Usuarios y accesos**. CRUD `core.usuario` y asignación a sucursales
  (`core.usuario_sucursal`) con vigencia. Provisión de credencial: contraseña
  temporal + `debe_cambiar`, hash Argon2id calculado en la nube; reset de
  contraseña. Baja de usuario en modo inmediato (recomendado, §3.4). **Capa 3 de
  revocación (03 §1.5)**, que quedó pendiente de F2: generador de código HOTP
  fuera de banda en la consola + validador nuevo en el nodo, consumido en el login.
- **Slice 4 · Impresora, ticket, tarifas, parámetros, permisos**.
  `core.config_impresora` (IP/transporte, modo inmediato — cierra el pendiente de
  F0), `core.config_ticket`, `core.tarifa` (siempre ventana, nunca a media
  venta), `core.parametro`, `core.rol_permiso`.

**Criterios de aceptación**
- Los cuatro criterios de F2 que quedaron sin superficie de autoría (arriba) se
  pueden ejercitar de punta a punta desde la consola.
- Un usuario dado de alta en la consola entra en una terminal tras un pull.
- Una baja inmediata cierra la sesión viva de ese usuario en la siguiente pasada
  del aplicador.
- Un código de revocación dictado por teléfono desactiva al usuario con la
  terminal sin internet.
- Cambiar la IP de una impresora en la consola surte efecto en el nodo sin
  desplegar nada.
- Un nodo nuevo hace bootstrap completo, credenciales incluidas.

**Dependencias**: P12 (zona horaria de las 4 sucursales) fija la hora exacta de
la ventana nocturna; si sigue abierta, arranca con `America/Mexico_City`. P7 no
bloquea: la consola trae su propia auth (Supabase Auth), separada del bearer de
solo lectura del tablero.

### F3 — Flota, conductores, rutas, horarios, salidas y cupos (3 semanas)

- Catálogo de `tipo_unidad` con mapa declarativo; **Sprinter 18 sembrada y renderizada**.
- Catálogo de conductores con la cadena conductor → unidad → tipo_unidad → esquema (D-7).
- Rutas con paradas intermedias, horarios por parada.
- Job de materialización a 90 días **con snapshot del mapa**.
- Algoritmo de reparto de `cupo_offline` **por bloques contiguos**.

**Criterios de aceptación**
- Un horario con dos paradas intermedias genera 90 salidas con paradas, horas de paso,
  `mapa_snapshot` y cupos.
- Los cupos de las paradas suman exactamente los 18 asientos vendibles, sin traslape, y
  **cada sucursal intermedia recibe una fila completa**.
- **Cambio de conductor caso 1** (compatible) no altera el mapa ni los cupos.
- **Cambio de conductor caso 2** (incompatible) queda bloqueado para vendedor, exige
  conexión, y encola los boletos huérfanos.

### F4 — Venta en 6 pasos, mapa de asientos y consistencia (4 semanas) — **fase crítica**

- Flujo de 6 pasos como máquina de estados.
- Mapa de asientos renderizado desde `salida.mapa_snapshot`, con estados: libre / ocupado /
  mi cupo / requiere conexión / en lease.
- Búsqueda de horarios con disponibilidad real por tramo (paso 2, con la regla de no
  seleccionable si no caben N pasajeros).
- Leases, arbitraje determinista, reasignación automática, cola de excepciones.
- Venta y reservación con abono parcial; pagos append-only.

**Criterios de aceptación** — los más importantes del proyecto
- Dos sucursales offline venden a la vez: **imposible que colisionen** (cupos disjuntos),
  verificado en UI y en BD.
- S1 offline + S2 online con override de gerente sobre el mismo asiento → **ambos nodos
  calculan el mismo ganador**; el perdedor se reasigna solo; reimpresión encolada;
  excepción visible en ambas cajas.
- **Una pareja que compra en una sucursal intermedia estando offline queda junta.**
- Reloj adelantado 10 min → sin doble venta. Adelantado 45 min → modo degradado.
- Red caída entre el lease y la confirmación → la venta se completa igual.
- Salida `en_ruta` → no se puede vender ni reservar.

### F5 — Impresión térmica y folios (1–2 semanas)

Se acorta respecto de v0.1: la abstracción de transporte y la PoC ya se hicieron en F0.

- Renderer ESC/POS, plantillas, QR (nativo + fallback raster), spooler con reintentos.
- Servicio de folios particionado.
- Reimpresión auditada.

**Criterios de aceptación**
- Venta de 5 boletos → 5 tickets separados, correctos, con acentos.
- QR escaneado con un lector comercial devuelve el texto esperado y el HMAC valida.
- Impresora apagada → job en reintento, alerta en caja, e imprime solo al encenderla.
- Matar el proceso a media impresión → **no** se duplica el ticket.
- Cambiar `transporte` de `tcp` a `usb` en configuración → imprime igual, sin redeploy.
- 100 000 folios generados en 4 sucursales → cero colisiones.

### F6 — Cortes de caja, ingresos y egresos (2–3 semanas)

- Apertura con saldo inicial; un solo corte abierto por sucursal (constraint).
- Movimientos de ingreso por pago y de egreso por insumo con descripción.
- Borrado lógico con retorno al corte; visibilidad diferenciada por rol.
- Verificación posterior de transferencias.
- Cierre de turno con saldo declarado vs. calculado.

**Criterios de aceptación**
- Intentar abrir un segundo corte → rechazado por la base de datos, no por la UI.
- Egreso desactivado → el monto regresa al corte y el registro sigue visible **solo** al
  administrador.
- Gerente no ve registros inactivos; administrador sí.
- Reservación cobrada en destino suma al corte de la sucursal que cobra.

### F7 — Viajes efectuados y checklist de abordaje (1–2 semanas)

- Listado de salidas del día, impresión de los dos manifiestos.
- Captura de abordaje como eventos append-only; marcado de `en_ruta` con conductor y hora
  del sistema.

**Criterios de aceptación**
- Ambos manifiestos impresos con el contenido correcto.
- Boletos en conflicto marcados en negritas en el manifiesto de terminal.
- Abordaje capturado se refleja en la nube y en el dashboard.

### F8 — Dashboard en nube y reportes (2 semanas)

- Reportes diario/semanal/mensual, cortes por sucursal, auditoría de registros inactivos,
  salud de sincronización, excepciones abiertas, gastos (incluye sueldos).
- Esquema `api` publicado y documentado.
- **Export automático semanal entregado al cliente** (mitigación R11).

**Criterios de aceptación**
- El administrador ve datos de las 4 sucursales con el desfase esperado de sync.
- Los reportes distinguen explícitamente "ventas de la sucursal" de "corte de caja de la
  sucursal" (C5).
- El export se genera y se entrega sin intervención manual.

### F9 — Endurecimiento, piloto y despliegue (2–3 semanas)

- Pruebas de caos: cortes de red, **apagones sin y con UPS**, reloj desviado, disco lleno,
  impresora muerta, **restauración completa desde respaldo en máquina limpia**.
- **Ensayo de la ventana de actualización** con una terminal quedándose en N−1.
- Piloto en la matriz durante 2 semanas en paralelo al proceso actual.
- Instalador definitivo, procedimiento de alta de sucursal, **runbook de contingencia en
  papel** (R2) y runbook de soporte por TeamViewer.
- Despliegue a las 4 terminales y capacitación.

**Criterio de salida**: 2 semanas de operación real en la matriz sin pérdida de datos, sin
sobreventa no resuelta y sin intervención manual en la base de datos.

### Resumen

| Fase | Semanas | Acumulado |
|---|---|---|
| F0 Descubrimiento, PoCs y respaldo | 1–2 | 2 |
| F1 Datos y sincronización | 3–4 | 6 |
| F2 Auth y configuración | 2 | 8 |
| F3 Flota, conductores, rutas y cupos | 3 | 11 |
| F4 Venta y consistencia de asientos | 4 | 15 |
| F5 Impresión y folios | 1–2 | 17 |
| F6 Cortes de caja | 2–3 | 20 |
| F7 Viajes efectuados | 1–2 | 21 |
| F8 Dashboard y reportes | 2 | 23 |
| F2b Consola de administración | 2.5–3 | 25.5–26 |
| F9 Endurecimiento y despliegue | 2–3 | **28–29** |

F2b se listó fuera de orden a propósito: se planeó en F2, se descubrió sin hacer
tras F8, y se ejecuta cuando aparece en el listado —antes de F9— para que el
piloto pruebe la operación con usuarios y sucursales dados de alta desde la
consola, no sembrados a mano.

**≈ 6–7 meses**, contra los ~4 meses de la propuesta comercial (R8). Con F8 diferido a la
renta —como la propuesta ya contempla— y paralelización entre F5/F6/F7, la Etapa 1 operativa
cae en el rango de **20–22 semanas (~5 meses)**, que es lo más cerca de lo prometido que
este alcance permite sin comprometer el motor de sincronización.
