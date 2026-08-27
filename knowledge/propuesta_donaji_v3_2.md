<!-- Slide number: 1 -->

PROPUESTA DE SOLUCIÓN TECNOLÓGICA

Sistema de Reservaciones,
Boletos y Paquetería

Plataforma a la medida para una agencia de viajes con 4 sucursales
interconectadas — arquitectura híbrida con operación sin conexión.

Preparado por Ing. Adolfo López López · Fi.TechServices
fito.techservices@gmail.com    ·    Cel: 9535409577

Modelo: desarrollo inicial a la medida  +  licencia por renta mensual
Etapa 1: Tickets y reservaciones (MVP)   ·   Etapa 2: Paquetería

<!-- Slide number: 2 -->

PUNTO DE PARTIDA
El contexto del cliente y su necesidad
Una agencia de viajes con 4 sucursales que hacen viajes entre sí, venden boletos, reservan asientos y envían paquetes de una sucursal a otra. Hoy todo se maneja de forma manual o con herramientas aisladas.

4

3–6 h

P

!
4 sucursales
Distancias largas
Paquetería
Conexión variable
Todas venden y reservan; necesitan ver la misma información y evitar sobreventa.
Las sucursales están a 3 a 6 horas entre sí: el soporte presencial rápido no es viable.
Envío y rastreo de paquetes entre las 4 sucursales (segunda etapa).
Internet deficiente o intermitente: el sistema debe seguir operando igual.

<!-- Slide number: 3 -->

ALCANCE
Un proyecto en dos etapas, arrancando con un MVP
Primero liberamos un MVP operativo de tickets y reservaciones; las funciones secundarias se van liberando dentro de la renta. La paquetería llega como segunda etapa sobre la misma plataforma.

1

2
ETAPA 1 · MVP OPERATIVO
ETAPA 2 · POSTERIOR
Tickets y Reservaciones
Envío de Paquetería
Venta de boletos e impresión de ticket
Registro de envío con número de control

Reservación con mapa visual de asientos
Recepción por código de barras en destino

Rutas y viajes entre las 4 sucursales
Consulta interna de estatus del envío

Usuarios, roles y corte de caja
Cobro en sucursal de origen o destino

Operación sin conexión + sincronización
Reportes de paquetería

Duración estimada: ~4 meses
Pago único adicional + incremento de renta

<!-- Slide number: 4 -->

ENFOQUE
Desarrollo a la medida, diseñado para operar sin conexión
Los sistemas comerciales no cubren reservaciones entre sucursales, paquetería interna y conectividad limitada a la vez. Construimos una solución propia, ajustada al proceso real del cliente.

Cada módulo se ajusta al flujo real del negocio, no al revés.

01
A la medida

Vive instalado en cada sucursal y funciona aunque el internet falle; la nube sincroniza.

02
Offline-first

Boletos, reservaciones y paquetería comparten la misma base y crecen por etapas.

03
Una sola plataforma

Preparado para sumar sucursales o módulos sin rehacer el sistema.

04
Escalable y mantenible

<!-- Slide number: 5 -->

ARQUITECTURA DE LA SOLUCIÓN
Cómo se conecta todo
Base de datos maestra en la nube · sistema instalado localmente en cada sucursal · réplica y respaldo local para operar sin conexión.

BASE DE DATOS MAESTRA — NUBE
Fuente única de verdad · respaldos automáticos · alta disponibilidad

Sucursal 1
Sucursal 2
Sucursal 3
Sucursal 4

PC local + sistema
PC local + sistema
PC local + sistema
PC local + sistema

Réplica + respaldo
Réplica + respaldo
Réplica + respaldo
Réplica + respaldo
Sincronización bidireccional: con conexión cada sucursal sube y baja cambios de la nube; sin conexión opera con su réplica local y sincroniza al reconectar.

<!-- Slide number: 6 -->

CONTINUIDAD OPERATIVA
El sistema no se detiene si falla el internet
Con sucursales a 3–6 horas de distancia, no podemos depender de la conexión ni del soporte presencial inmediato. La operación siempre corre en local; la nube es el punto de consolidación.

1

2

3

4
→
→
→
Opera en local
Cola de sincronización
Sincroniza al reconectar
Evita la sobreventa
Cada venta o reserva se guarda al instante en la base local de la sucursal.
Los cambios se acumulan en una cola pendiente cuando no hay conexión.
Al volver el internet, la cola sube a la nube y baja los cambios de otras sedes.
Inventario autoritativo por viaje; la reserva entre sucursales se confirma en línea (ver siguiente lámina).

<!-- Slide number: 7 -->

PUNTO CRÍTICO PARA EL CLIENTE
Reservaciones entre sucursales

Ejemplo: un cliente en Huajuapan reserva asientos de un viaje que sale de CDMX. Así funciona el flujo de reserva entre sucursales:

!

1

2

3
La reserva aparta el asiento al instante
Notificación y confirmación automática
El cobro queda en la sucursal que reserva
La sucursal que hace la reserva no requiere confirmación en línea: al reservar, el asiento queda apartado de inmediato.
La sucursal de origen del viaje solo ve una notificación de que se hizo la reserva; ésta queda confirmada automáticamente.
El pago puede cobrarse en la misma sucursal donde se hizo la reserva; ese efectivo entra en su corte de caja, no en la del viaje.

Resultado: flujo simple — el asiento se aparta al instante, la sucursal de origen se sincroniza por notificación y el cobro queda en la sucursal que reservó.

<!-- Slide number: 8 -->

ALCANCE DE LA ETAPA 1
Qué incluye el MVP y qué se libera después
Arrancamos con lo esencial para operar. Las funciones secundarias se liberan sin costo extra dentro de la renta mensual.

✓

+
Incluido en el MVP (pago único)
Se libera después (dentro de la renta)
Motor de sincronización offline-first

Reportes avanzados y tableros de indicadores

Venta de boletos + impresión de ticket

Programación avanzada de horarios

Reservación con mapa visual de asientos

Rutas/viajes entre sucursales + horarios
Exportación y filtros avanzados de reportes

Usuarios, roles y permisos

Mejoras continuas del sistema

Corte de caja básico

Registro de ingresos, egresos, tickets y reservaciones

<!-- Slide number: 9 -->

SEGUNDA ETAPA
Módulo de paquetería (Etapa 2)
Sobre la misma plataforma se agrega un manejo de envíos simple entre sucursales, basado en un número de control interno. Pago único adicional + incremento de renta.

Registro de envío
Recepción por código de barras
Estatus del envío (interno)

1

2

3
Genera un número de control, registra la hora de salida de la sucursal origen y el operador que lleva el envío.
La sucursal destino escanea el paquete y lo marca como recibido.
Los usuarios consultan el número de control para ver si fue recibido, entregado o se encuentra en ruta.

Cobro en origen o destino
Etiqueta con QR
Reportes de paquetería

4

5

6
El pago se registra en el corte de caja de la sucursal que cobra.
Etiqueta imprimible con los datos del envío codificados; sin servidor externo.
Enviados, recibidos, en curso y entregados.

Después de la puesta en operación de la Etapa 2, se podrán ir implementando mejoras continuas al sistema.

<!-- Slide number: 10 -->

INFRAESTRUCTURA RECOMENDADA
Hardware por sucursal — a cargo del cliente
El hardware es propiedad del cliente: él lo adquiere directamente con las especificaciones que sugerimos. La instalación del sistema en las 4 terminales va incluida sin costo.

PC de negocio
$14,000
Monitor 22"
$2,500
No-break / UPS
$1,800

1

2

3
Core i5, 16 GB RAM, SSD 512 GB, Windows 11 Pro
Pantalla para operación de mostrador
1000 VA — protege ante cortes de energía

Impresora térmica
$2,200
Lector de código
$1,200
Router con respaldo 4G
$2,500

4

5

6
Tickets 80 mm para boletos y comprobantes
Escáner de código de barras / QR
Conexión de respaldo LTE ante fallas

Inversión del cliente en hardware (4 sucursales): ~ $116,000 MXN, compra directa     ·     Instalación del sistema: INCLUIDA sin costo

<!-- Slide number: 11 -->

MODELO COMERCIAL
Cómo funciona el esquema de pago
El cliente financia la construcción del sistema y luego paga una licencia por renta para usarlo, con soporte y mejoras incluidas.

1

2
Pago único — Desarrollo inicial
Licencia por renta mensual
Cubre la mano de obra de construir el sistema a la medida (MVP de la Etapa 1), su configuración en nube y la puesta en marcha. Es un pago por el servicio de desarrollo.
Tras la instalación, una mensualidad da el derecho de uso del sistema e incluye soporte y actualizaciones menores. Módulos nuevos se cotizan aparte.

Propiedad del sistema
La propiedad y los derechos del software permanecen con el proveedor (Fi.TechServices). El pago de desarrollo financia la construcción a la medida; no transfiere la titularidad. El cliente recibe un derecho de uso mediante la licencia por renta.

<!-- Slide number: 12 -->

LICENCIA POR RENTA
Qué incluye la renta mensual
Una sola mensualidad cubre el uso del sistema, su operación en la nube, el soporte y las mejoras menores.

Licencia de uso
Soporte 8h/día · 7 días
Infraestructura en nube
Actualizaciones menores
Derecho de uso del sistema mientras esté activa la renta.
Franja flexible. Telefónico/remoto para sucursales lejanas; presencial en la matriz. El cliente reporta la incidencia para ser atendido.
Base de datos maestra, respaldos automáticos y disponibilidad.
Correcciones y liberación de funciones secundarias sin costo extra.

Renta mensual estimada:  ~ $30,000 MXN / mes
Módulos nuevos = pago único adicional + incremento de renta

<!-- Slide number: 13 -->

CONTINUIDAD Y PROTECCIÓN DE DATOS
Qué pasa si se suspende el pago de la renta
Un esquema escalonado y transparente: el cliente nunca pierde su información de golpe y siempre puede exportarla.

Mes 1
Mes 2
Mes 3
Mes 4
Mes 5

1

2

3

4

5
Uso completo
Solo consulta
Solo administrador
Exportación
Acceso denegado
Periodo de gracia: el sistema sigue funcionando con normalidad.
Acceso de solo lectura a la información.
Únicamente el administrador consulta la información.
Se habilita la exportación de toda su data.
Se suspende el acceso al sistema.

<!-- Slide number: 14 -->

PLAN DE TRABAJO
Cronograma y tiempos de entrega
Mes 1
Mes 2
Mes 3
Mes 4
Mes 5
Mes 6
Mes 7
Mes 8
Descubrimiento y diseño

Arquitectura + motor de sincronización

Venta de boletos y reservación de asientos

Rutas/horarios, usuarios y corte de caja

Pruebas, piloto en matriz y despliegue (4 suc.)

Paquetería: registro + etiqueta/QR

Recepción por código y estatus

Cobro en caja, reportes y despliegue

Etapa 1 — MVP tickets y reservaciones (~4 meses)
Etapa 2 — Paquetería (~3 meses)
Total: ~7 meses

<!-- Slide number: 15 -->

INVERSIÓN
Resumen de costos
Cifras estimadas en MXN, sin IVA. Se afinan tras la fase de descubrimiento.

PAGO ÚNICO · DESARROLLO INICIAL (Etapa 1 · MVP)
RENTA MENSUAL · LICENCIA DE USO

Desarrollo del sistema (MVP, offline-first)
$920,000

Licencia de uso del sistema
$10,000

Configuración de nube e infraestructura (DevOps)
$50,000

Soporte 8h/día × 7 días (tel. + matriz)
$12,000

Capacitación, puesta en marcha e instalación
$80,000

Infraestructura en nube (BD + respaldos)
$3,500

Total pago único
$1,050,000

Actualizaciones menores incluidas
$4,500

Renta mensual
$30,000

A cargo del cliente / posterior
Hardware 4 sucursales: ~$116,000 (compra directa; instalación incluida gratis)
Etapa 2 – Paquetería (simplificada): pago único ~$450,000 + incremento de renta

+ renta ~$30,000/mes
INVERSIÓN INICIAL DEL CLIENTE
Desarrollo $1,050,000  +  Hardware ~$116,000

<!-- Slide number: 16 -->

¿Arrancamos con la Etapa 1?

Proponemos una sesión de descubrimiento para afinar procesos, cerrar el alcance del MVP
y confirmar tiempos, pago único y renta mensual.

Ing. Adolfo López López · Fi.TechServices

fito.techservices@gmail.com    ·    Cel: 9535409577