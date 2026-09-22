/**
 * Registro de venta / reservación y pagos (pasos 4-6 del flujo).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §2
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F4)
 *
 * La lógica transaccional vive en `core.registrar_venta` / `core.registrar_pago`
 * / `core.verificar_transferencia`. Aquí solo se invocan y se normaliza.
 *
 * FUERA DE ALCANCE (F6): el `core.movimiento_caja` de ingreso. `registrarVenta`
 * crea el `core.pago` con su `corte_caja_id`; el enlace al corte lo cablea F6.
 */

import type { Consultable } from '../db/consulta.js';
import { normalizarFolio } from '../fleet/abordaje.js';

export interface Pasajero {
  asientoNum: number;
  nombre: string;
  importe: number;
  /** Categoría de tarifa (D4). Por defecto `general`. Descuento solo terminal↔terminal. */
  categoria?: 'general' | 'inapam' | 'menor';
  /** Lease adquirido en el paso 3 (venta con conexión fuera del cupo propio). */
  leaseId?: string;
}

export interface PagoInput {
  metodo: 'efectivo' | 'transferencia' | 'corresponsal';
  monto: number;
  esAbono?: boolean;
  referencia?: string;
  /**
   * Solo `efectivo` (0064): con cuánto pagó el pasajero (>= `monto`). El backend
   * calcula el cambio. Informativo para el cajón — no entra al corte ni al boleto.
   */
  efectivoRecibido?: number;
  /** Corte al que suma. Si se omite, se usa el corte abierto de la sucursal. */
  corteCajaId?: string;
  /**
   * Solo `corresponsal` (D8): la sucursal `sin_sistema` donde el pasajero pagó.
   * El pago se agrupa en el corte del origen pero no entra al efectivo.
   */
  sucursalCobroId?: string;
}

export interface RegistrarVentaArgs {
  salidaId: string;
  sucursalVentaId: string;
  usuarioId: string;
  contactoTelefono: string;
  origenOrden: number;
  destinoOrden: number;
  pasajeros: Pasajero[];
  /** Cómo se originó; inmutable, para reportes. No cambia que se imprima o no. */
  esReservacion?: boolean;
  clienteId?: string;
  /** Omitir para una reservación sin pago. */
  pago?: PagoInput;
  conConexion?: boolean;
  ahora?: Date;
}

export interface BoletoEmitido {
  boletoId: string;
  folio: string;
  asientoNum: number;
  pasajero: string;
  importe: number;
  categoria: 'general' | 'inapam' | 'menor';
}

export interface ResultadoVenta {
  ventaId: string;
  estado: 'pendiente' | 'liquidada' | 'finalizada_transferencia';
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
  boletos: BoletoEmitido[];
  /** Tickets encolados (0 si el saldo no llegó a cero). */
  printJobs: number;
  imprimible: boolean;
  /** Un abono que no liquida encoló el comprobante de anticipo (0071), no el boleto. */
  comprobanteImpreso: boolean;
}

function pasajeroAJson(p: Pasajero): Record<string, unknown> {
  return {
    asiento_num: p.asientoNum,
    nombre: p.nombre,
    importe: p.importe,
    ...(p.categoria ? { categoria: p.categoria } : {}),
    ...(p.leaseId ? { lease_id: p.leaseId } : {}),
  };
}

function pagoAJson(p: PagoInput): Record<string, unknown> {
  return {
    metodo: p.metodo,
    monto: p.monto,
    es_abono: p.esAbono ?? false,
    ...(p.efectivoRecibido != null ? { efectivo_recibido: p.efectivoRecibido } : {}),
    ...(p.referencia ? { referencia: p.referencia } : {}),
    ...(p.corteCajaId ? { corte_caja_id: p.corteCajaId } : {}),
    ...(p.sucursalCobroId ? { sucursal_cobro_id: p.sucursalCobroId } : {}),
  };
}

interface FilaVenta {
  venta_id: string;
  estado_venta: 'pendiente' | 'liquidada' | 'finalizada_transferencia';
  importe_total: string;
  pagado: string;
  saldo_pendiente: string;
  boletos: BoletoEmitidoRaw[];
  print_jobs: number;
  imprimible: boolean;
  comprobante_impreso: boolean;
}

interface BoletoEmitidoRaw {
  boleto_id: string;
  folio: string;
  asiento_num: number;
  pasajero: string;
  importe: number;
  categoria: 'general' | 'inapam' | 'menor';
}

export async function registrarVenta(
  db: Consultable,
  args: RegistrarVentaArgs,
): Promise<ResultadoVenta> {
  const { rows } = await db.query<FilaVenta>(
    `SELECT venta_id, estado_venta, importe_total, pagado, saldo_pendiente,
            boletos, print_jobs, imprimible, comprobante_impreso
       FROM core.registrar_venta(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::int, $6::int, $7::jsonb,
         $8::boolean, $9::uuid, $10::jsonb, $11::boolean, $12::timestamptz)`,
    [
      args.salidaId,
      args.sucursalVentaId,
      args.usuarioId,
      args.contactoTelefono,
      args.origenOrden,
      args.destinoOrden,
      JSON.stringify(args.pasajeros.map(pasajeroAJson)),
      args.esReservacion ?? false,
      args.clienteId ?? null,
      args.pago ? JSON.stringify(pagoAJson(args.pago)) : null,
      args.conConexion ?? true,
      args.ahora ?? new Date(),
    ],
  );
  return normalizar(rows[0]!);
}

function normalizar(f: FilaVenta): ResultadoVenta {
  return {
    ventaId: f.venta_id,
    estado: f.estado_venta,
    importeTotal: Number(f.importe_total),
    pagado: Number(f.pagado),
    saldoPendiente: Number(f.saldo_pendiente),
    boletos: (f.boletos ?? []).map((b) => ({
      boletoId: b.boleto_id,
      folio: b.folio,
      asientoNum: Number(b.asiento_num),
      pasajero: b.pasajero,
      importe: Number(b.importe),
      categoria: b.categoria ?? 'general',
    })),
    printJobs: Number(f.print_jobs),
    imprimible: f.imprimible,
    comprobanteImpreso: f.comprobante_impreso,
  };
}

export interface RegistrarPagoArgs {
  ventaId: string;
  /** Dónde se cobra: puede diferir de la sucursal de la venta (C5). */
  sucursalCobroId: string;
  usuarioId: string;
  metodo: 'efectivo' | 'transferencia';
  monto: number;
  esAbono?: boolean;
  referencia?: string;
  corteCajaId?: string;
  ahora?: Date;
}

export interface ResultadoPago {
  pagoId: string;
  pagado: number;
  saldoPendiente: number;
  liquidada: boolean;
  printJobs: number;
  /** Un abono que no liquida encoló el comprobante de anticipo (0071), no el boleto. */
  comprobanteImpreso: boolean;
}

export async function registrarPago(
  db: Consultable,
  args: RegistrarPagoArgs,
): Promise<ResultadoPago> {
  const { rows } = await db.query<{
    pago_id: string; pagado: string; saldo_pendiente: string;
    liquidada: boolean; print_jobs: number; comprobante_impreso: boolean;
  }>(
    `SELECT pago_id, pagado, saldo_pendiente, liquidada, print_jobs, comprobante_impreso
       FROM core.registrar_pago($1::uuid, $2::uuid, $3::uuid, $4::text, $5::numeric,
                                $6::boolean, $7::text, $8::uuid, $9::timestamptz)`,
    [
      args.ventaId, args.sucursalCobroId, args.usuarioId, args.metodo, args.monto,
      args.esAbono ?? false, args.referencia ?? null, args.corteCajaId ?? null,
      args.ahora ?? new Date(),
    ],
  );
  const r = rows[0]!;
  return {
    pagoId: r.pago_id,
    pagado: Number(r.pagado),
    saldoPendiente: Number(r.saldo_pendiente),
    liquidada: r.liquidada,
    printJobs: Number(r.print_jobs),
    comprobanteImpreso: r.comprobante_impreso,
  };
}

export interface ResultadoVerificacion {
  pagado: number;
  saldoPendiente: number;
  liquidada: boolean;
  printJobs: number;
}

export async function verificarTransferencia(
  db: Consultable,
  pagoId: string,
  usuarioId: string,
  ahora?: Date,
): Promise<ResultadoVerificacion> {
  const { rows } = await db.query<{
    pagado: string; saldo_pendiente: string; liquidada: boolean; print_jobs: number;
  }>(
    `SELECT pagado, saldo_pendiente, liquidada, print_jobs
       FROM core.verificar_transferencia($1::uuid, $2::uuid, $3::timestamptz)`,
    [pagoId, usuarioId, ahora ?? new Date()],
  );
  const r = rows[0]!;
  return {
    pagado: Number(r.pagado),
    saldoPendiente: Number(r.saldo_pendiente),
    liquidada: r.liquidada,
    printJobs: Number(r.print_jobs),
  };
}

export interface TransferenciaPorVerificar {
  pagoId: string;
  ventaId: string;
  folio: string | null;
  pasajero: string | null;
  monto: number;
  referencia: string | null;
  vendedor: string;
  registradoEn: string;
}

/**
 * Cola del encargado (0065): transferencias registradas en `sucursalId` cuyo
 * comprobante aún no se confirma. El pasajero manda el comprobante y quien vendió
 * —o un gerente/admin— lo marca pagado con `verificarTransferencia`.
 */
export async function transferenciasPorVerificar(
  db: Consultable, sucursalId: string,
): Promise<TransferenciaPorVerificar[]> {
  const { rows } = await db.query<{
    pago_id: string; venta_id: string; folio: string | null; pasajero: string | null;
    monto: string; referencia: string | null; vendedor: string; registrado_en: Date;
  }>(
    `SELECT pago_id, venta_id, folio, pasajero, monto, referencia, vendedor, registrado_en
       FROM core.pagos_transferencia_por_verificar($1::uuid)`,
    [sucursalId],
  );
  return rows.map((r) => ({
    pagoId: r.pago_id, ventaId: r.venta_id, folio: r.folio, pasajero: r.pasajero,
    monto: Number(r.monto), referencia: r.referencia, vendedor: r.vendedor,
    registradoEn: r.registrado_en.toISOString(),
  }));
}

export interface SaldoVenta {
  ventaId: string;
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
}

export async function saldoDeVenta(
  db: Consultable, ventaId: string,
): Promise<SaldoVenta | null> {
  const { rows } = await db.query<{
    venta_id: string; importe_total: string; pagado: string; saldo_pendiente: string;
  }>(
    `SELECT venta_id, importe_total, pagado, saldo_pendiente
       FROM core.v_venta_saldo WHERE venta_id = $1::uuid`,
    [ventaId],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    ventaId: r.venta_id,
    importeTotal: Number(r.importe_total),
    pagado: Number(r.pagado),
    saldoPendiente: Number(r.saldo_pendiente),
  };
}

export interface PasajeroReserva {
  boletoId: string;
  folio: string;
  asientoNum: number;
  nombre: string;
  importe: number;
  categoria: 'general' | 'inapam' | 'menor';
}

export interface ReservaPorFolio {
  ventaId: string;
  estado: string;
  esReservacion: boolean;
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
  clienteNombre: string | null;
  contactoTelefono: string;
  sucursalVenta: string;
  vendedor: string;
  salida: { salidaId: string; fechaOperacion: string; estado: string };
  ruta: { origen: string; destino: string; origenHora: Date; destinoHora: Date };
  pasajeros: PasajeroReserva[];
}

/**
 * Busca la reservación completa (todos sus boletos) a partir del folio de
 * CUALQUIERA de ellos — el folio identifica la venta, no el asiento (0005).
 * Para el paso "el cliente se presenta en origen con su comprobante" (Ses. 71):
 * la modal de Viajes muestra esto y ofrece cobrar el saldo con `registrarPago`.
 */
export async function buscarReservaPorFolio(
  db: Consultable, folioEntrada: string,
): Promise<ReservaPorFolio | null> {
  const folio = normalizarFolio(folioEntrada);
  if (folio.length !== 6) return null;

  const { rows: fr } = await db.query<{ venta_id: string }>(
    `SELECT venta_id FROM core.boleto WHERE folio = $1`,
    [folio],
  );
  const ventaId = fr[0]?.venta_id;
  if (!ventaId) return null;

  const { rows: vr } = await db.query<{
    venta_id: string; estado: string; es_reservacion: boolean; importe_total: string;
    pagado: string; saldo_pendiente: string; cliente_nombre: string | null;
    contacto_telefono: string; sucursal_venta: string; vendedor: string;
    salida_id: string; fecha_operacion: string; salida_estado: string;
    origen: string; destino: string; origen_hora: Date; destino_hora: Date;
  }>(
    `SELECT v.id AS venta_id, v.estado, v.es_reservacion, v.importe_total,
            vs.pagado, vs.saldo_pendiente,
            cli.nombre AS cliente_nombre, v.contacto_telefono,
            sv.nombre AS sucursal_venta, u.nombre AS vendedor,
            s.id AS salida_id, s.fecha_operacion::text AS fecha_operacion, s.estado AS salida_estado,
            puo.nombre AS origen, pud.nombre AS destino,
            spo.hora_paso_programada AS origen_hora, spd.hora_paso_programada AS destino_hora
       FROM core.venta v
       JOIN core.v_venta_saldo vs  ON vs.venta_id = v.id
       JOIN core.usuario u         ON u.id  = v.usuario_id
       JOIN core.sucursal sv       ON sv.id = v.sucursal_venta_id
       LEFT JOIN core.cliente cli  ON cli.id = v.cliente_id
       JOIN core.salida s          ON s.id  = v.salida_id
       JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = v.parada_origen_orden
       JOIN core.punto_ruta puo    ON puo.id = spo.punto_id
       JOIN core.salida_parada spd ON spd.salida_id = s.id AND spd.orden = v.parada_destino_orden
       JOIN core.punto_ruta pud    ON pud.id = spd.punto_id
      WHERE v.id = $1::uuid`,
    [ventaId],
  );
  const v = vr[0];
  if (!v) return null;

  const { rows: pr } = await db.query<{
    boleto_id: string; folio: string; asiento_num: number; pasajero_nombre: string;
    importe: string; categoria_pasajero: 'general' | 'inapam' | 'menor';
  }>(
    `SELECT id AS boleto_id, folio, asiento_num, pasajero_nombre, importe, categoria_pasajero
       FROM core.boleto WHERE venta_id = $1::uuid AND activo ORDER BY asiento_num`,
    [ventaId],
  );

  return {
    ventaId: v.venta_id,
    estado: v.estado,
    esReservacion: v.es_reservacion,
    importeTotal: Number(v.importe_total),
    pagado: Number(v.pagado),
    saldoPendiente: Number(v.saldo_pendiente),
    clienteNombre: v.cliente_nombre,
    contactoTelefono: v.contacto_telefono,
    sucursalVenta: v.sucursal_venta,
    vendedor: v.vendedor,
    salida: { salidaId: v.salida_id, fechaOperacion: v.fecha_operacion, estado: v.salida_estado },
    ruta: { origen: v.origen, destino: v.destino, origenHora: v.origen_hora, destinoHora: v.destino_hora },
    pasajeros: pr.map((p) => ({
      boletoId: p.boleto_id, folio: p.folio, asientoNum: Number(p.asiento_num),
      nombre: p.pasajero_nombre, importe: Number(p.importe), categoria: p.categoria_pasajero,
    })),
  };
}
