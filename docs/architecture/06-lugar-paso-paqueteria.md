# 06 — Abordaje en lugar de paso + Paquetería (Etapa 2)

> **Estado (2026-11-03): reglas cerradas con el PO; plan por fases aprobado.**
> **Todas las fases hechas (A–G, `0079`–`0088`).** Pendiente: nube + terminales, validación en la Enduro física, retro del PO.
> Requerimiento del cliente: MOD-1..MOD-7 (lugar de paso) y REQ-1..REQ-13 (paquetería).

---

## 1. Reglas de negocio (validadas con el PO)

### 1.1 Abordaje en lugar de paso (MOD)

| # | Regla |
|---|---|
| L1 | Una venta puede indicar **lugar de abordaje en texto libre** (no catálogo, máx. 80 caracteres). Uno **por venta**: todos los pasajeros de esa venta suben ahí. |
| L2 | La sucursal de **origen sigue siendo obligatoria**; el **precio es origen→destino** (tarifa estricta normal) y el asiento queda ocupado desde el origen. |
| L3 | Se puede reservar desde cualquier sucursal (como hoy, C5) con cualquier origen. |
| L4 | **Reserva telefónica con lugar de paso**: no se imprime boleto. El cobro lo hace el **conductor** al abordar, pero el sistema **lo toma por ingreso en efectivo al reservar**, en el **corte abierto de quien reserva** (método `conductor`). Suma al efectivo esperado: la caja queda descuadrada hasta que el conductor entrega el dinero. |
| L5 | **Venta en taquilla pagada al momento** con lugar de paso: es un boleto normal (se imprime); solo se anota el lugar de abordaje. |
| L6 | Las ventas con lugar de paso **no caducan** (D9) y **no se bloquean en el abordaje** por saldo (S8). |
| L7 | **No-show**: el conductor avisa al origen, que **cancela** la reserva — se permite **aun con la salida en ruta** (excepción a "hasta 1 h antes"). Se registra una **devolución** (egreso) por el monto en el corte abierto de la sucursal que cobró; el corte original no se toca. El asiento se libera y puede venderse en la siguiente terminal. |
| L8 | **Manifiesto por terminal**: cada terminal con sistema imprime **su propio** manifiesto: los pasajeros que suben ahí + las ventas con lugar de paso cuyo origen es esa terminal (+ sus paquetes, Fase F). |
| L9 | Manifiesto **compacto** (fuente B, 64 col.): no repite "sube en" (es la terminal que imprime) salvo en lugar de paso, donde muestra `aborda: X · cobrar $Y`. Siempre muestra "baja en". |

### 1.2 Paquetería (REQ)

| # | Regla |
|---|---|
| P1 | Un **envío** viaja en una **salida** existente. Origen y destino son **terminales con sistema**, el destino después del origen en la ruta; nunca paradas. |
| P2 | Datos: remitente (nombre + celular), destinatario (nombre completo + celular), **una descripción general**, número de **bultos** (≥ 1), **importe > $0** capturado por el vendedor (acordado con su supervisor, sin autorización en sistema). |
| P3 | Modalidad: **pagado completo en origen** o **por cobrar completo en destino**. Sin anticipos. |
| P4 | Pago en efectivo o transferencia; la transferencia **no detiene la pantalla**: queda "por confirmar" y suma al corte al confirmarse (mismo flujo que boletos). |
| P5 | Folio con el **mismo generador** que los boletos (`[S][CCCCC]`): nunca colisiona con un boleto. |
| P6 | Se registra hasta **5 minutos antes** de que la salida pase por la terminal de origen. |
| P7 | Impresión: **recibo** con QR firmado (datos + cobro; incluye monto si es por cobrar) y **un ticket por bulto** (`n/N`, destino, destinatario, POR COBRAR si aplica, QR firmado). Rollo normal de la Enduro, se pega con cinta. |
| P8 | Estados: `registrado` → `en_ruta` (sale la unidad) → `en_sucursal` (lo recibe el destino) → `entregado`, o `cancelado`. |
| P9 | Entrega solo al **destinatario registrado**: el vendedor verifica el nombre completo contra la credencial de elector. **Nunca** se captura el número de la credencial. Si es por cobrar, se cobra en el corte del destino antes de entregar. |
| P10 | Se puede **mover a otra salida** antes de que salga (debe pasar por su origen y su destino). |
| P11 | **Cancelación** antes de la salida; **reembolso solo si se pagó en efectivo**, en el corte de la sucursal que cobró. |
| P12 | Manifiesto: segunda sección con **folio, descripción, monto (marca POR COBRAR) y destino**. Sin QR ni numeración. |
| P13 | Corte e historial muestran la paquetería como ingresos con su detalle. |

---

## 2. Fases y migraciones

### Fase A — Lugar de paso · `0079`, `0080`
- ✅ `0079_lugar_abordaje.sql`: `core.venta.lugar_abordaje text` (CHECK 1..80, recortado); `core.pago.metodo` += `'conductor'` (verificado, entra al corte como efectivo, L4); `registrar_venta` recibe `p_lugar_abordaje`, exige pago completo o `conductor` y **no imprime** con `conductor`. Como toda venta con lugar de paso queda saldada, D9/S8 no aplican por construcción (no se tocó `reservas_caducas`).
- ✅ `0080_cancelacion_no_show.sql`: `cancelar_boleto` sin ventana de 1 h para ventas con lugar de paso (aun en ruta, no finalizada/cancelada); la devolución sale del corte abierto de la sucursal que cobró (L7).
- **Runbook**: aplicar `0079` a TODOS los nodos antes de usar `conductor` (un nodo viejo rechaza el `core.pago` replicado por CHECK, como pasó con `corresponsal`).
- SPA: casilla "Aborda en lugar de paso" + campo en Vender; cancelación por no-show en Viajes.

### Fase B — Manifiesto por terminal y compacto · `0081`, `0082`
- ✅ `0081_manifiesto_por_terminal.sql`: `core.terminal_que_cubre(salida, orden)` — un pasajero va en el manifiesto de la terminal con sucursal más cercana en orden ≤ su punto de ascenso (lugar de paso → origen; parada sin sistema → la terminal anterior). `salidas_del_dia` gana `es_origen`/`hora_paso`/`boletos_aqui` y lista también las salidas que **pasan** por mi terminal con ascenso ("de paso"). `datos_manifiesto`/`generar_manifiestos` ganan `p_sucursal_id`; cada terminal encola SUS dos copias en su impresora.
- ✅ Plantilla en fuente B (64 col. a 80 mm); "sube en" solo si es otro punto; lugar de paso con `aborda: X - COBRAR $Y` y total "COBRA EL CONDUCTOR".
- ✅ `0082_venta_en_ruta_intermedias.sql`: hasta hoy la venta exigía `programada`, así que en cuanto el origen marcaba EN RUTA las intermedias ya no vendían. `core.salida_vendible(estado, orden)`: en ruta se vende desde orden > 0 (el tiempo lo cuida `cierre_venta_en`). Re-emite `registrar_venta`, `adquirir_lease`, `vender_asiento_extra`, `buscar_salidas`.
- SPA Viajes: chip "de paso", hora de paso y "suben aquí"; conductor/unidad/en ruta/finalizar solo en el origen.
- Pendiente: validar la letra en la Enduro física.

### Fase B2 — Réplica de bajada transaccional · `0083`
- Hallazgo (3 nov): la nube solo bajaba configuración; ventas/boletos/pagos de una terminal nunca llegaban a las otras (decisión abierta del historial "replicación hacia las sucursales"). Rompía el manifiesto por terminal, el cobro de reservas de otra sucursal (C5) y la entrega de paquetes en destino. El PO eligió réplica de bajada (funciona sin internet al usarlo).
- ✅ `sync.cambio_log.destinatarios` (NULL = todos). `sync.trg_bajada` (solo nube) publica cliente/corte_caja (a todas las sucursales con sistema) y venta/boleto/pago (a las terminales de su salida), también lo que llega replicado, menos a la que lo escribió. `sync.destinatarios_bajada` es el punto de extensión.
- ✅ `sync.trg_outbox` recupera la guarda `replicando()` (0014) que 0032 perdió: lo que baja no sube.
- ✅ Pull filtra por sucursal del nodo; tolera una nube sin la columna. Relleno inicial en la nube (salidas de ayer en adelante).
- Fuera a propósito: `asiento_ocupacion` (clase D sigue con cupos + leases + arbitraje), `movimiento_caja`, `print_job`.
- **Deploy: nube PRIMERO.**

### Fase C — Paquetería núcleo · `0084`
- ✅ `core.envio` (B, dueña origen), `core.pago_envio` (C; → `movimiento_caja` `'pago_paqueteria'`), `core.evento_envio` (C, custodia; estado por precedencia en `core.v_envio_estado`, no por reloj).
- ✅ `core.registrar_envio`: destino = terminal con sistema posterior; cierre `minutos_cierre_paqueteria` (5) antes del paso por el origen; folio del mismo contador que boletos; pagado completo (efectivo / transferencia por confirmar) o por cobrar. `core.verificar_transferencia_envio`.
- ✅ `core.v_corte_saldo`: la transferencia de paquetería tampoco cuenta como efectivo.
- ✅ Réplica: envío, pagos y eventos bajan a origen y destino.
- ✅ Backend `src/paqueteria/envio.ts` + `/paqueteria` (registrar, por folio, por salida, verificar transferencia). Sin pantallas todavía (Fase G).

### Fase D — Impresión de paquetería · `0085`
- ✅ `core.print_job` += `envio_id`, `bulto_num`; plantilla `recibo_envio` (la `etiqueta_paquete` existía desde 0007). `core.snapshot_envio`, `core.encolar_impresion_envio` (recibo + un ticket por bulto, sin duplicar), `core.reimprimir_envio` (recibo / todas las etiquetas / una, con motivo). `registrar_envio` encola al registrar, también por cobrar y transferencia por confirmar.
- ✅ QR firmado con la misma clave HMAC del boleto: `DONAJI-ENV` (recibo, con monto por cobrar) y `DONAJI-BUL` (bulto, `N:2/5`). Plantillas `src/printing/templates/envio.ts`; spooler las renderiza. `POST /paqueteria/:id/reimprimir`.
- ✅ De paso: `procesarCola` gana `soloSucursal`; la prueba del spooler era intermitente porque barría jobs que `servicio.test.ts` confirma en paralelo.
- Pendiente: validar en la Enduro física (largo del ticket, tamaño del QR).

### Fase E — Recepción y entrega · `0086`
- ✅ `core.despachar_envios(salida, sucursal)` → `en_ruta`. `marcar_en_ruta` despacha solo los envíos del origen; una terminal intermedia despacha los suyos (`POST /paqueteria/salida/:id/despachar`).
- ✅ `core.recibir_envio` (solo la sucursal destino; desde registrado o en ruta) → `en_sucursal`.
- ✅ `core.entregar_envio`: exige estar en sucursal y `nombreVerificado` (nombre completo contra la credencial; el evento guarda `verificado_contra: credencial_elector`, nunca un número). Por cobrar ⇒ cobro completo en el corte del destino (transferencia queda por confirmar y no detiene); ya pagado ⇒ sin cobro.
- ✅ `GET /paqueteria/destino?estado=por_recibir|por_entregar`.

### Fase F — Cambios, manifiesto y corte · `0087`, `0088`
- ✅ `0087`: `core.mover_envio` (solo origen, antes de despachar; la nueva salida pasa por origen y destino, vendible y antes del cierre; reimprime recibo + tickets) y `core.cancelar_envio` (antes de despachar; reembolso solo del efectivo, egreso en el corte abierto de quien cobró; **pagado por transferencia ⇒ se rechaza la cancelación**, porque el reembolso quedó limitado a efectivo; por cobrar ⇒ sin dinero).
- ✅ `0088`: `datos_manifiesto` gana `paquetes` (folio, descripción, monto con POR COBRAR, destino; los que se cargan en esa terminal; sin cancelados) + sección PAQUETES en la plantilla. El ingreso de paquetería lleva descripción ("Envío F · contenido → destino"), visible en Caja e Historial; `movimientos_corte_detalle` gana `envio` y el método del pago de paquetería.
- ✅ Rutas `POST /paqueteria/:id/mover`, `/:id/cancelar`.

### Fase G — SPA Paquetería
- ✅ Pantalla `/paqueteria` (menú "Paquetería"): pestañas **Registrar envío** (destino → salidas del día que pasan por aquí y llegan ahí, con "registro cerrado" a los 5 min; remitente/destinatario/descripción/bultos/importe; paga aquí en efectivo con cambio o transferencia, o por cobrar), **Por recibir** y **Por entregar** (bandeja del destino), y **buscar por folio**.
- ✅ Detalle del envío con acciones según mi sucursal: destino → recibir / entregar (casilla "verifiqué el nombre completo contra la credencial", cobro si es por cobrar); origen → reimprimir (recibo, todos los tickets o uno), mover de salida, cancelar; confirmar transferencia pendiente.
- ✅ Caja: bloque "Transferencias de paquetería por verificar". Viajes: botón "Despachar paquetes" en salidas de paso. Historial: el envío en el detalle del movimiento.
- ✅ Backend de apoyo: `GET /paqueteria/salidas`, `GET /paqueteria/transferencias-por-verificar`, `pagoPorConfirmarId` en el envío.

### Despliegue
Cada fase: LOCAL + NUBE con pruebas; las terminales las migra el usuario por TeamViewer. Las terminales intermedias que estrenen sistema deben llegar a `0088`.
