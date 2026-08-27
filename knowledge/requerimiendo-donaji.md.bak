# Donaji Agency Travel
**Descripcion General del Proyecto**
Quiero construir un sistema para una agencia de viajes que maneje la venta de boletos y reservaciones de asientos, asi como el manejo de envio de paqueteria unicamente entre sucursales nunca a domicilio, cortes de caja y reportes de ventas del dia, semanal y mensual. Dicha agencia de viajes cuenta con 4 sucursales activas en las cuales el origen y destino puede ser entre ellas y posterior poder crecer a mas sucursales. Como requerimiento obligatorio es el manejo de la latencia en la conexion a internet es decir una sucursal pueda seguir operando en la venta de boletos sin necesidad de depender de una conexion a internet estable. 
El sistema consiste en dos etapas.
* Etapa 1:
** login para usuarios
** Registro de usuarios y roles
** Registro de clientes 
** Manejo de sucursales
** Manejo de cortes de caja por sucursal
** Venta de Boletos y Reservaciones
** Sincronizacion por latencia de la conexion
** Consideraciones para los tickets de impresion
** Modulo de viajes efectuados
** Modulo de horarios y conductores
** Modulo de configuracion
* Etapa 2:
** Sistema de paqueteria (su definicion se dara despues pero con lo ya contruido debe poder vivir y solo sumarse un nuevo modulo al sistema)
tomar las siguientes consideraciones o modulos:
## login para usuarios
**Registro de usuarios y roles**
* roles permitidos administrador, gerente, vendedor
* considerar el campo sueldo para cuestiones de reportes de gastos diarios, semanales y mensuales
## Registro de clientes 
* formulario para capturar nombre, telefono, email
## Manejo de sucursales
* la instancia podra dar de alta distintas sucursales que pertenezcan a la agencia, en donde se captura direccion completa, num de telefono principal (datos que se imprimiran en el boleto de viaje).
* la sucursal podra relacionar usuarios gerentes y vendedores que estaran laborando en dicha sucursal.
* los usuarios al iniciar sesion solo podran ingresar al sistema si tienen una sucursal activa y seleccionar la sucursal en donde estaran laborando para poder registrar movimientos como ventas en el caso de un vendedor o altas y cierres de un corte de caja por turno.
## Manejo de cortes de caja por sucursal
* el usuario vendedor, gerente de sucursal o el administrador podran abrir un nuevo corte de caja de la sucursal unicamente se pide el saldo inicial que corresponde al efectivo que debera tener la sucursal en caja para dar cambio o para poder comprar insumos adicionales durante el dia.
* todas las ventas de boletos se registraran como movimientos de ingreso y suman al corte de caja que esta activo en el dia, y en este listado de registros del corte el administrador podra ver el detalle de una venta en particular todos los boletos o reservaciones que se hayan pagado con anticipacion activos e inactivos y que el total corresponda a las ventas activas.
* el usuario de turno podra cerrar el corte de caja a cualquier hora o al finalizar su turno para entregar al administrador o al gerente lo que se vendio en el dia (entradas y salidas), esta operacion corresponde al cambio de turno del usuario o cierre al final del dia.
* durante el dia pueden darse de alta varios cortes de caja de la sucursal pero solo puede existir uno activo en el cual se registran las ventas y movimientos del dia.
* dicho modulo puede registrar movimientos o registros de gastos del dia, es decir si durante el dia se requiere comprar algun insumo que hace falta en la sucursal se registra el movimiento y se resta al corte activo del dia, por ejemplo que falten algun articulo de limpieza, el usuario en caja manda a comprar los productos y a su regreso el usuario registra la descripcion en un campo de texto y el total, es responsabilidad del usuario tener el ticket de compra bajo su resguardo para validar que el egreso que se haya realizado.
* los registros de gastos del dia deberan manejar una bandera de activo e inactivo, es decir al dar de alta un registro queda en estatus activo y el usuario con acceso podra eliminar el registro pero no significa que se elimina de base de datos mas bien regresa el egreso al corte del dia y se queda en estatus inactivo. tanto para insumos como para la venta de boletos (por validar la devolucion con el cliente)
* el gerente solo podra ver los registros activos del corte de caja.
* el administrador podra ver todos los registros activos e inactivos del corte del dia (dichos registros inactivos se mostraran al administrador como parte de su auditoria para visualizar posibles malos manejos).
## Venta de Boletos y Reservaciones
* el sistema debe contar con una pantalla para poder vender los boletos de viaje en el horario que se haya definido (modulo de manejo de horarios)
* el formulario de venta de boletos debe contar con los pasos:
	** paso 1 busqueda: se debe seleccionar el numero de personas, fecha de viaje, terminal origen, terminal destino (si sera una reservacion se debe checkear es un campo opcional que indica que no se pagara en el momento o se puede pagar un adelanto, pero si se debe liquidar antes de abordar en la terminal de origen).
	** paso 2 horarios: dada la fecha seleccionada se deberan mostrar los distintos horarios con asientos disponibles de acuerdo al numero de personas a viajar (ejemplo si un horario ya no tiene asientos disponibles se puede mostrar pero no seleccionar porque no 2 personas que viajan no pueden acomodarse en una suburban que ya no tiene asientos o que solo tiene 1 asiendo disponible) y el usuario seleccionara el horario que el cliente indique.
	** paso 3 asientos: el paso 3 debe contar con un layaout en donde se muestra un mapa de asientos (modelo de mercedes benz sprinter) en el cual el cliente valida el mapa y puede seleccionar los asientos de su preferencia.
	** paso 4 registro de pasajeros: se debe mostrar un formulario con la lista de asientos seleccionados y capturar el nombre completo de la persona asignada a cada asiento.
	** paso 5 confirmacion: se mostrara un resumen completo del viaje con fecha de viaje, horario de salida, sucursal origen, sucursal destino, numero de unidad, lista de pasajeros y su numero de asiento asignado, importe de cada boleto y otro apartado con el total y boton confirmacion para proceder al ultimo paso.
	** paso 6 pago: el cliente debe elegir el metodo de pago ya sea en efectivo o transferencia (en ambos casos se puede finalizar la venta pero la venta por transferencia debe ser verificada posteriormente por el usuario que realizo dicha venta y en ese momento sumar al corte de caja, adicional una transferencia se debe registrar). NOTA: considerar que la reservacion puede pagarse en la terminal de destino, y este ingreso sumara al corte de la sucursal donde esta siendo registrado, en el caso ideal se paga en la sucursal origen y se registra en el corte de dicha sucursal, esta regla adicional da la posibilidad de que en la terminal destino se pague en efectivo, y se debe registrar adicinal al nombre del cliente el numero telefonico.
* el usuario activo que se encuentre en la terminal podra vender boletos de viaje a los usuarios que lleguen de manera presencial dada la pantalla descrita
* el usuario activo que se encuentre en la terminal podra reservar boletos de viaje a los usuarios que se comuniquen via telefonica o de igual manera presencial y si realiza un pago o abono se podra registrar (considerar que el pago puede ser incompleto dado un abono y se debe liquidar en la terminal origen o destino)
* cada venta de boletos debe sumar al corte de caja activo y debe registrar el usuario que vendio, fecha y hora del registro
* pendiente validar con el cliente que pasa cuando un boleto se cancela, si se debe hacer una devolucion o cual es el proceso a seguir.
* una reservacion sin pago se puede dar de baja unicamente con su estatus activo en false, no se elimina el registro ya que el administrador podra ver dichos registros para su auditoria.
* cada boleto debe generar un folio unico de 6 digitos (letras y numeros).
* las reservaciones no generan un ticket.
* la venta de boletos o reservaciones unicamente se daran para aquellos horarios que no esten marcados como "En ruta" y que si tengan disponibilidad dado el numero de pasajeros a consultar.
## Sincronizacion por latencia de la conexion
* uno de los puntos mas importantes del sistema es la sincronizacion es decir una sucursal puede operar (venta y reservacion de boletos) aunque haya una posible caida de la conexion del internet.
* las sucursales registradas por el administrador corresponden a terminales en distintas ciudades las cuales deben estar operando para la atencion al cliente.
* la informacion generada por cada sucursal debe persistir en una base de datos en linea (supabase) pero deben tener su propio respaldo en local dada la premisa del cliente.
* el administrador debe poder visualizar la informacion de la nube para poder visualizar los reportes de ventas, cortes de caja etc (modulo dashboard). dicha informacion es estrategica para el administrador para su toma de decisiones.
* durante una desconexion el sistema de autenticacion debe seguir funcionando contra la base de datos local
* los cambios de parametros por el administrador se veran reflejados en un horario que no interrumpa la operacion, por ejemplo un horario nuevo se dara de alta en la madrugrada para que se vea reflejado al dia siguiente, o tambien la baja de un usuario se dara en el mismo horario para que al dia siguiente al tratar de iniciar sesion no pueda acceder y asi sucesivamente para ajustes por parte del administrador.
## Consideraciones para los tickets de impresion:
* los boletos se deberan imprimir mediante una impresora termica (via ethernet).
* la informacion de cada ticket debe venir separada es decir un ticket por cada persona que viaja (si en una venta se vendieron 5 boletos se deberan imprimir 5 boletos por separado uno para cada persona).
* la informacion a mostrar se compone por el header, body, y footer:
	** informacion del header: datos de la sucursal, usuario de atencion, horario de atencion, folio del ticket
	** informacion del body: nombre de la persona que viaja, numero de asiento, sucursal de origen, sucursal destino, fecha y hora de viaje.
	** informacion del footer: QR con la informacion del mismo ticket, dicho QR mostrara en texto la informacion del ticket nunca una url para redirigir a otro lugar, solo informacion en texto, leyenda personalizada por la agencia (por ejemplo: buen viaje estamos para servirle), numeros de atencion al cliente, y credenciales del proveedor del sistema.
* las reservaciones pueden imprimir un ticket de venta siempre y cuando se liquiden antes de abordar o al momento de reservar (aqui puede existir una confusion en la cual una reservacion que se paga en efectivo o transferencia en el momento ya es una venta en si, pero existe la posibilidad de que una persona reserve o bien compre un boleto para otra persona y esta la pague al momento o bien una persona via telefonica haga una reservacion y pague via transferencia lo cual ya es una venta en si pero si se debe etiquetar que fue por reservacion para efectos de reportes hacia el administrador).
## Modulo de viajes efectuados
* dicho modulo debe poder listar todos los viajes del dia en curso y el objetivo es que el usuario pueda imprimir dos listas de pasajeros en la cual una lista llevara el conductor a cargo y otra lista se quedara el usuario en la terminal origen donde podra marcar que usuarios abordaron la urvan, dicho checklist de momento sera manual es decir el usuario marcara con un lapicero quienes abordaron y lo debera registrar en el sistema (cambiar el estatus del pasajero como abordado).
* este estatus sirve para efectos de validar que usuarios si abordaron en la terminal origen y cuales usuarios no abordaron por alguna circunstancia externa fuera del alcance de la agencia.
* asi mismo el estatus del viaje en cuestion debera registrar el nombre del conductor (modulo de manejo de horarios y conductores) fecha y hora de salida (currentDateTime del sistema) y su estatus a "En camino" o "En ruta"
## Modulo de horarios y conductores
* el administrador debe contar con una pantalla para poder registrar los horarios de los viajes o salidas de la terminal origen y destino
* cada viaje debe estar asignado a un conductor en turno
* los conductores deben tener su registro completo (nombre, direccion, telefono, INE y opcional informacion de una persona de contacto)
* las sucursales origen y destino pueden hacer paradas en sucursales intermedias es decir en principio se cuentan con 4 sucursales y una sucursal origen 1 su destino es la sucursal 4, pero puede pasar en cierto horario por la sucursal 2 y 3 para ascenso y descenso de pasajeros.
* considerar que dichas terminales intermedias tambien cuentan con un horario y personas que pueden abordar dicha unidad, por lo que es importante que al dar de alta un viaje o salida de origen a destino se definan por cuantas sucursales puede pasar dicha urvan y en que horario.
* cabe señalar que los asientos de la sucursal origen tambien pueden ser vistos por la sucursal intermedia y no deben traslaparse o venderse dos veces.
* el punto anterior reafirma la importancia de tener un motor de sincronizacion.
* los horarios unicamente son configurados por el administrador de la agencia.
* validar si en este modulo puede vivir el modulo de conductores o se puede separar en otro modulo similar al de clientes.
## Modulo de configuracion:
* aqui se capturaran los nombres de las impresoras y la direccion IP.
* campos para configurar las leyendas que llevaran los tickets del cliente (logotipo en la cabecera, telefono principal de atencion, leyenda personalizada para el pie de pagina, etc.
## Sistema de paqueteria 
* no se tiene definicion y el alcance no entra en este momento (etapa 2 del proyecto).
* si se debe considerar que cuando se inicie la etapa 2 el sistema soporte este nuevo modulo.
* en principio se maneja envio de paqueteria entre sucursales nunca a domicilio.
* cada paquete debe estar etiquetado con un folio unico, persona que envia, persona que recibe y costo del envio.
## Consideraciones tecnicas:
* el sistema debera estar instalado de manera local contando con una base de datos en linea.
* el sistema sera un sistema web que debe poder imprimir tickets de venta como los ya mencionados.
* el sistema debe contar con un motor de sincronizacion de la base de datos local contra la base de datos en la nube (pieza no negociable e importante para el cliente)
* la base de datos en linea sera consumida por otro sistema fuera de este alcance
