/**
 * Captura de abordaje y estado del viaje (F7).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §5
 *
 * El checklist se marca a mano y luego se captura. Corregir es un hecho nuevo
 * que anula el anterior, nunca un UPDATE. Marcar "en ruta" bloquea la venta
 * desde ese instante (lo respetan `registrar_venta` / `buscar_salidas` /
 * `adquirir_lease`).
 */

import type { Consultable } from '../db/consulta.js';

export async function registrarAbordaje(
  db: Consultable,
  args: {
    boletoId: string; abordo: boolean; usuarioId: string;
    sucursalId: string; ahora?: Date;
  },
): Promise<string> {
  const { rows } = await db.query<{ registrar_abordaje: string }>(
    `SELECT core.registrar_abordaje($1::uuid, $2::boolean, $3::uuid, $4::uuid, $5::timestamptz)`,
    [args.boletoId, args.abordo, args.usuarioId, args.sucursalId, args.ahora ?? new Date()],
  );
  return rows[0]!.registrar_abordaje;
}

export async function corregirAbordaje(
  db: Consultable,
  args: {
    eventoId: string; abordo: boolean; usuarioId: string;
    sucursalId: string; ahora?: Date;
  },
): Promise<string> {
  const { rows } = await db.query<{ corregir_abordaje: string }>(
    `SELECT core.corregir_abordaje($1::uuid, $2::boolean, $3::uuid, $4::uuid, $5::timestamptz)`,
    [args.eventoId, args.abordo, args.usuarioId, args.sucursalId, args.ahora ?? new Date()],
  );
  return rows[0]!.corregir_abordaje;
}

export interface EstadoViaje {
  salidaId: string;
  estado: string;
  salidaRealEn?: Date;
}

export async function marcarEnRuta(
  db: Consultable,
  args: { salidaId: string; usuarioId: string; conductorId?: string; ahora?: Date },
): Promise<EstadoViaje> {
  const { rows } = await db.query<{
    salida_id: string; estado: string; salida_real_en: Date;
  }>(
    `SELECT salida_id, estado, salida_real_en
       FROM core.marcar_en_ruta($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
    [args.salidaId, args.usuarioId, args.conductorId ?? null, args.ahora ?? new Date()],
  );
  const r = rows[0]!;
  return { salidaId: r.salida_id, estado: r.estado, salidaRealEn: r.salida_real_en };
}

export async function finalizarSalida(
  db: Consultable,
  args: { salidaId: string; usuarioId: string; ahora?: Date },
): Promise<EstadoViaje> {
  const { rows } = await db.query<{ salida_id: string; estado: string }>(
    `SELECT salida_id, estado FROM core.finalizar_salida($1::uuid, $2::uuid, $3::timestamptz)`,
    [args.salidaId, args.usuarioId, args.ahora ?? new Date()],
  );
  const r = rows[0]!;
  return { salidaId: r.salida_id, estado: r.estado };
}

export type EstadoAbordaje = 'abordo' | 'no_presento' | 'pendiente';

export interface FilaChecklist {
  boletoId: string;
  folio: string;
  asientoNum: number;
  pasajeroNombre: string;
  tramos: string;
  conflicto: boolean;
  estadoAbordaje: EstadoAbordaje;
  capturadoEn: Date | null;
}

export interface BoletoPorFolio extends FilaChecklist {
  salida: {
    salidaId: string;
    fechaOperacion: string;
    horaSalida: Date;
    origen: string;
    destino: string;
    estado: string;
    conductor: string | null;
  };
}

/**
 * Normaliza un folio tecleado a mano para buscarlo.
 *
 * El folio es un STRING de 6 caracteres (02b §1): `[código de sucursal][contador
 * base32 de 5]`, alfabeto `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — NO un consecutivo
 * numérico. El alfabeto excluye `I L O U` a propósito porque los folios se dictan
 * por teléfono; si el operador teclea uno de esos, se asume el símbolo real que
 * suena/parece igual (`O→0`, `I/L→1`). Un folio verdadero nunca los contiene, así
 * que el mapeo no puede llevar a otro folio.
 */
export function normalizarFolio(entrada: string): string {
  return entrada
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Busca un boleto por su folio (exacto tras normalizar) y devuelve su fila del
 * checklist más el contexto de la salida, para que el operador pueda capturar el
 * abordaje o saltar al viaje. El folio es UNIQUE global, así que no se filtra por
 * sucursal.
 */
export async function buscarBoletoPorFolio(
  db: Consultable, folioEntrada: string,
): Promise<BoletoPorFolio | null> {
  const folio = normalizarFolio(folioEntrada);
  if (folio.length !== 6) return null;

  const { rows } = await db.query<{
    boleto_id: string; folio: string; asiento_num: number; pasajero_nombre: string;
    tramos: string; conflicto: boolean; estado_abordaje: EstadoAbordaje;
    capturado_en: Date | null;
    salida_id: string; fecha_operacion: string; salida_estado: string;
    conductor: string | null; hora_salida: Date; origen: string; destino: string;
  }>(
    `SELECT c.boleto_id, c.folio, c.asiento_num, c.pasajero_nombre, c.tramos::text AS tramos,
            c.conflicto, c.estado_abordaje, c.capturado_en,
            s.id AS salida_id, s.fecha_operacion::text AS fecha_operacion,
            s.estado AS salida_estado, s.conductor_nombre_snapshot AS conductor,
            spo.hora_paso_programada AS hora_salida,
            suo.nombre AS origen, sud.nombre AS destino
       FROM core.v_checklist_abordaje c
       JOIN core.salida s ON s.id = c.salida_id
       JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = 0
       JOIN core.punto_ruta suo ON suo.id = spo.punto_id
       JOIN core.salida_parada spd ON spd.salida_id = s.id
        AND spd.orden = (SELECT max(orden) FROM core.salida_parada WHERE salida_id = s.id)
       JOIN core.punto_ruta sud ON sud.id = spd.punto_id
      WHERE c.folio = $1`,
    [folio],
  );

  const r = rows[0];
  if (!r) return null;
  return {
    boletoId: r.boleto_id,
    folio: r.folio,
    asientoNum: Number(r.asiento_num),
    pasajeroNombre: r.pasajero_nombre,
    tramos: r.tramos,
    conflicto: r.conflicto,
    estadoAbordaje: r.estado_abordaje,
    capturadoEn: r.capturado_en,
    salida: {
      salidaId: r.salida_id,
      fechaOperacion: r.fecha_operacion,
      horaSalida: r.hora_salida,
      origen: r.origen,
      destino: r.destino,
      estado: r.salida_estado,
      conductor: r.conductor,
    },
  };
}

export async function checklistAbordaje(
  db: Consultable, salidaId: string,
): Promise<FilaChecklist[]> {
  const { rows } = await db.query<{
    boleto_id: string; folio: string; asiento_num: number; pasajero_nombre: string;
    tramos: string; conflicto: boolean; estado_abordaje: EstadoAbordaje;
    capturado_en: Date | null;
  }>(
    `SELECT boleto_id, folio, asiento_num, pasajero_nombre, tramos::text AS tramos,
            conflicto, estado_abordaje, capturado_en
       FROM core.v_checklist_abordaje
      WHERE salida_id = $1::uuid
      ORDER BY asiento_num`,
    [salidaId],
  );
  return rows.map((r) => ({
    boletoId: r.boleto_id,
    folio: r.folio,
    asientoNum: Number(r.asiento_num),
    pasajeroNombre: r.pasajero_nombre,
    tramos: r.tramos,
    conflicto: r.conflicto,
    estadoAbordaje: r.estado_abordaje,
    capturadoEn: r.capturado_en,
  }));
}

export interface DetalleBoleto {
  boletoId: string;
  folio: string;
  pasajeroNombre: string;
  asientoNum: number;
  tramos: string;
  estado: string;
  conflicto: boolean;
  /** Costo de este boleto (numeric → number). */
  importe: number;
  impresoEn: Date | null;
  /** Fecha y hora en que se registró la venta del boleto. */
  vendidoEn: Date;
  venta: {
    ventaId: string;
    esReservacion: boolean;
    importeTotal: number;
    /** Boletos vivos de la misma venta (contexto cuando fue una venta múltiple). */
    boletosEnLaVenta: number;
    contactoTelefono: string;
    clienteNombre: string | null;
  };
  vendedor: { nombre: string; rol: string };
  sucursalVenta: string;
  ruta: { origen: string; destino: string; origenHora: Date; destinoHora: Date };
  salida: {
    salidaId: string;
    fechaOperacion: string;
    estado: string;
    conductor: string | null;
  };
}

/**
 * Detalle completo de un boleto para la modal del listado de viajes: quién lo
 * vendió y con qué rol, en qué sucursal, cuándo, cuánto costó y su tramo
 * (origen → destino, con las horas de paso). El folio y el boleto son únicos
 * globales, así que no se filtra por sucursal.
 */
export async function detalleBoleto(
  db: Consultable, boletoId: string,
): Promise<DetalleBoleto | null> {
  const { rows } = await db.query<{
    boleto_id: string; folio: string; pasajero_nombre: string; asiento_num: number;
    tramos: string; estado: string; importe: string; impreso_en: Date | null;
    vendido_en: Date;
    venta_id: string; es_reservacion: boolean; importe_total: string;
    contacto_telefono: string; boletos_en_venta: string; cliente_nombre: string | null;
    vendedor_nombre: string; vendedor_rol: string; sucursal_venta: string;
    salida_id: string; fecha_operacion: string; salida_estado: string;
    conductor: string | null;
    origen: string; destino: string; origen_hora: Date; destino_hora: Date;
  }>(
    `SELECT b.id AS boleto_id, b.folio, b.pasajero_nombre, b.asiento_num,
            b.tramos::text AS tramos, b.estado, b.importe, b.impreso_en,
            b.creado_en AS vendido_en,
            v.id AS venta_id, v.es_reservacion, v.importe_total, v.contacto_telefono,
            (SELECT count(*) FROM core.boleto bb
              WHERE bb.venta_id = v.id AND bb.activo) AS boletos_en_venta,
            cli.nombre AS cliente_nombre,
            u.nombre AS vendedor_nombre, u.rol AS vendedor_rol,
            suv.nombre AS sucursal_venta,
            s.id AS salida_id, s.fecha_operacion::text AS fecha_operacion,
            s.estado AS salida_estado, s.conductor_nombre_snapshot AS conductor,
            spo.nombre AS origen, spd.nombre AS destino,
            sppo.hora_paso_programada AS origen_hora,
            sppd.hora_paso_programada AS destino_hora
       FROM core.boleto b
       JOIN core.venta v      ON v.id  = b.venta_id
       JOIN core.usuario u    ON u.id  = v.usuario_id
       JOIN core.sucursal suv ON suv.id = v.sucursal_venta_id
       LEFT JOIN core.cliente cli ON cli.id = v.cliente_id
       JOIN core.salida s     ON s.id  = b.salida_id
       JOIN core.salida_parada sppo ON sppo.salida_id = s.id AND sppo.orden = lower(b.tramos)
       JOIN core.punto_ruta spo ON spo.id = sppo.punto_id
       JOIN core.salida_parada sppd ON sppd.salida_id = s.id AND sppd.orden = upper(b.tramos)
       JOIN core.punto_ruta spd ON spd.id = sppd.punto_id
      WHERE b.id = $1::uuid`,
    // Sin filtro `b.activo`: la modal de detalle debe seguir mostrando el boleto
    // tras cancelarlo o reubicarlo (F6-D1 deja el reubicado `activo = false`).
    [boletoId],
  );

  const r = rows[0];
  if (!r) return null;
  return {
    boletoId: r.boleto_id,
    folio: r.folio,
    pasajeroNombre: r.pasajero_nombre,
    asientoNum: Number(r.asiento_num),
    tramos: r.tramos,
    estado: r.estado,
    conflicto: r.estado === 'conflicto_sobreventa',
    importe: Number(r.importe),
    impresoEn: r.impreso_en,
    vendidoEn: r.vendido_en,
    venta: {
      ventaId: r.venta_id,
      esReservacion: r.es_reservacion,
      importeTotal: Number(r.importe_total),
      boletosEnLaVenta: Number(r.boletos_en_venta),
      contactoTelefono: r.contacto_telefono,
      clienteNombre: r.cliente_nombre,
    },
    vendedor: { nombre: r.vendedor_nombre, rol: r.vendedor_rol },
    sucursalVenta: r.sucursal_venta,
    ruta: {
      origen: r.origen,
      destino: r.destino,
      origenHora: r.origen_hora,
      destinoHora: r.destino_hora,
    },
    salida: {
      salidaId: r.salida_id,
      fechaOperacion: r.fecha_operacion,
      estado: r.salida_estado,
      conductor: r.conductor,
    },
  };
}

export interface ResultadoReimpresion {
  printJobId: string;
  /** Cuántas veces se ha reimpreso el boleto tras esta. */
  reimpresiones: number;
}

export interface ResultadoCancelacion {
  ventaId: string;
  /** La venta entera quedó cancelada (no le quedaban boletos vivos). */
  ventaCancelada: boolean;
  /** Egreso de reembolso registrado en el corte de la sucursal de cobro; `null` si no aplicó. */
  reembolsoId: string | null;
  /** Monto pagado que se devuelve; `null` si no hubo pago. */
  reembolsoMonto: number | null;
  /**
   * N-13: si el pago se cobró en una sucursal sin sistema (corresponsal), el
   * reembolso NO se registra — se hace a mano en esa sucursal. Aquí va su nombre.
   */
  reembolsoPendienteEn: string | null;
}

/**
 * Cancela un boleto / reserva hasta 1 h antes de la salida (D9): libera el
 * asiento y cancela boleto + venta. El reembolso solo existe en la sucursal de
 * cobro (N-13): con sistema → egreso en su corte abierto; sin sistema
 * (corresponsal) → sin movimiento, reembolso manual (`reembolsoPendienteEn`).
 */
export async function cancelarBoleto(
  db: Consultable,
  args: {
    boletoId: string; usuarioId: string; sucursalId: string;
    motivo?: string; ahora?: Date;
  },
): Promise<ResultadoCancelacion> {
  const { rows } = await db.query<{
    venta_id: string; venta_cancelada: boolean;
    reembolso_id: string | null; reembolso_monto: string | null;
    reembolso_pendiente_en: string | null;
  }>(
    `SELECT venta_id, venta_cancelada, reembolso_id, reembolso_monto, reembolso_pendiente_en
       FROM core.cancelar_boleto($1::uuid, $2::uuid, $3::uuid, $4::text, $5::timestamptz)`,
    [
      args.boletoId, args.usuarioId, args.sucursalId,
      args.motivo ?? null, args.ahora ?? new Date(),
    ],
  );
  const r = rows[0]!;
  return {
    ventaId: r.venta_id,
    ventaCancelada: r.venta_cancelada,
    reembolsoId: r.reembolso_id,
    reembolsoMonto: r.reembolso_monto === null ? null : Number(r.reembolso_monto),
    reembolsoPendienteEn: r.reembolso_pendiente_en,
  };
}

/**
 * Encola una reimpresión de un boleto liquidado: mismo contenido que el original
 * (mismo snapshot) más la leyenda de reimpresión que agrega la plantilla desde
 * `config_ticket.leyenda_reimpresion` (N-4). Rechaza un boleto con saldo o
 * cancelado. Deja `nota_auditoria` tipo `reimpresion`.
 */
export async function reimprimirBoleto(
  db: Consultable,
  args: {
    boletoId: string; usuarioId: string; sucursalId: string;
    motivo?: string; ahora?: Date;
  },
): Promise<ResultadoReimpresion> {
  const { rows } = await db.query<{ print_job_id: string; reimpresiones: number }>(
    `SELECT print_job_id, reimpresiones
       FROM core.reimprimir_boleto($1::uuid, $2::uuid, $3::uuid, $4::text, $5::timestamptz)`,
    [
      args.boletoId, args.usuarioId, args.sucursalId,
      args.motivo ?? 'REIMPRESIÓN', args.ahora ?? new Date(),
    ],
  );
  return {
    printJobId: rows[0]!.print_job_id,
    reimpresiones: Number(rows[0]!.reimpresiones),
  };
}

export interface ResultadoReubicar {
  boletoNuevoId: string;
  folioNuevo: string;
  ventaNuevaId: string;
  importe: number;
  /** true = se mantuvo el precio que el pasajero ya había pagado (N-14). */
  precioMantenido: boolean;
  saldoPendiente: number;
  printJobs: number;
}

/**
 * Reubica un boleto huérfano (D12) en una salida de la ruta nueva (N-14). El
 * boleto viejo queda `reasignado` y su asiento liberado. Si el huérfano ya pagó,
 * el boleto nuevo se emite al precio pagado y el/los `core.pago` se traspasan;
 * si no pagó, a la tarifa vigente de la ruta nueva (venta `pendiente`).
 */
export async function reubicarHuerfano(
  db: Consultable,
  args: {
    boletoViejoId: string; salidaNuevaId: string;
    origenOrden: number; destinoOrden: number; asientoNum: number;
    usuarioId: string; sucursalId: string; ahora?: Date;
  },
): Promise<ResultadoReubicar> {
  const { rows } = await db.query<{
    boleto_nuevo_id: string; folio_nuevo: string; venta_nueva_id: string;
    importe: string; precio_mantenido: boolean; saldo_pendiente: string; print_jobs: number;
  }>(
    `SELECT boleto_nuevo_id, folio_nuevo, venta_nueva_id, importe,
            precio_mantenido, saldo_pendiente, print_jobs
       FROM core.reubicar_huerfano($1::uuid, $2::uuid, $3::int, $4::int, $5::smallint,
                                   $6::uuid, $7::uuid, $8::timestamptz)`,
    [
      args.boletoViejoId, args.salidaNuevaId, args.origenOrden, args.destinoOrden,
      args.asientoNum, args.usuarioId, args.sucursalId, args.ahora ?? new Date(),
    ],
  );
  const r = rows[0]!;
  return {
    boletoNuevoId: r.boleto_nuevo_id,
    folioNuevo: r.folio_nuevo,
    ventaNuevaId: r.venta_nueva_id,
    importe: Number(r.importe),
    precioMantenido: r.precio_mantenido,
    saldoPendiente: Number(r.saldo_pendiente),
    printJobs: Number(r.print_jobs),
  };
}

export interface BoletoReubicable {
  boletoId: string;
  folio: string;
  pasajeroNombre: string;
  asientoNum: number;
}

/** Boletos vivos (`emitido`) de una venta — para reubicar la venta completa. */
export async function boletosReubicables(
  db: Consultable, ventaId: string,
): Promise<BoletoReubicable[]> {
  const { rows } = await db.query<{
    boleto_id: string; folio: string; pasajero_nombre: string; asiento_num: number;
  }>(
    `SELECT id AS boleto_id, folio, pasajero_nombre, asiento_num
       FROM core.boleto
      WHERE venta_id = $1::uuid AND activo AND estado = 'emitido'
      ORDER BY asiento_num`,
    [ventaId],
  );
  return rows.map((r) => ({
    boletoId: r.boleto_id,
    folio: r.folio,
    pasajeroNombre: r.pasajero_nombre,
    asientoNum: Number(r.asiento_num),
  }));
}

export interface AsignacionReubicar {
  boletoViejoId: string;
  origenOrden: number;
  destinoOrden: number;
  asientoNum: number;
}

export interface ResultadoReubicarVenta {
  ventaNuevaId: string;
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
  precioMantenido: boolean;
  boletos: Array<{ boletoId: string; folio: string; asientoNum: number; pasajero: string; importe: number }>;
  printJobs: number;
}

/**
 * Reubica una venta huérfana COMPLETA (multi-boleto, familia, D12/N-14) en una
 * salida de la ruta nueva: emite una venta nueva con todos los boletos al precio
 * pagado (traspasa el pago una vez) o a la tarifa vigente si no había pago. Las
 * asignaciones deben cubrir exactamente los boletos vivos de la venta.
 */
export async function reubicarVentaHuerfana(
  db: Consultable,
  args: {
    ventaViejaId: string; salidaNuevaId: string;
    asignaciones: AsignacionReubicar[];
    usuarioId: string; sucursalId: string; ahora?: Date;
  },
): Promise<ResultadoReubicarVenta> {
  const asig = args.asignaciones.map((a) => ({
    boleto_viejo_id: a.boletoViejoId,
    origen_orden: a.origenOrden,
    destino_orden: a.destinoOrden,
    asiento_num: a.asientoNum,
  }));
  const { rows } = await db.query<{
    venta_nueva_id: string; importe_total: string; pagado: string;
    saldo_pendiente: string; precio_mantenido: boolean;
    boletos: Array<{ boleto_id: string; folio: string; asiento_num: number; pasajero: string; importe: number }>;
    print_jobs: number;
  }>(
    `SELECT venta_nueva_id, importe_total, pagado, saldo_pendiente,
            precio_mantenido, boletos, print_jobs
       FROM core.reubicar_venta_huerfana($1::uuid, $2::uuid, $3::jsonb,
                                         $4::uuid, $5::uuid, $6::timestamptz)`,
    [
      args.ventaViejaId, args.salidaNuevaId, JSON.stringify(asig),
      args.usuarioId, args.sucursalId, args.ahora ?? new Date(),
    ],
  );
  const r = rows[0]!;
  return {
    ventaNuevaId: r.venta_nueva_id,
    importeTotal: Number(r.importe_total),
    pagado: Number(r.pagado),
    saldoPendiente: Number(r.saldo_pendiente),
    precioMantenido: r.precio_mantenido,
    boletos: (r.boletos ?? []).map((b) => ({
      boletoId: b.boleto_id, folio: b.folio, asientoNum: Number(b.asiento_num),
      pasajero: b.pasajero, importe: Number(b.importe),
    })),
    printJobs: Number(r.print_jobs),
  };
}
