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

export interface Pasajero {
  asientoNum: number;
  nombre: string;
  importe: number;
  /** Lease adquirido en el paso 3 (venta con conexión fuera del cupo propio). */
  leaseId?: string;
}

export interface PagoInput {
  metodo: 'efectivo' | 'transferencia';
  monto: number;
  esAbono?: boolean;
  referencia?: string;
  /** Corte al que suma. Si se omite, se usa el corte abierto de la sucursal. */
  corteCajaId?: string;
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
}

export interface ResultadoVenta {
  ventaId: string;
  estado: 'pendiente' | 'liquidada';
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
  boletos: BoletoEmitido[];
  /** Tickets encolados (0 si el saldo no llegó a cero). */
  printJobs: number;
  imprimible: boolean;
}

function pasajeroAJson(p: Pasajero): Record<string, unknown> {
  return {
    asiento_num: p.asientoNum,
    nombre: p.nombre,
    importe: p.importe,
    ...(p.leaseId ? { lease_id: p.leaseId } : {}),
  };
}

function pagoAJson(p: PagoInput): Record<string, unknown> {
  return {
    metodo: p.metodo,
    monto: p.monto,
    es_abono: p.esAbono ?? false,
    ...(p.referencia ? { referencia: p.referencia } : {}),
    ...(p.corteCajaId ? { corte_caja_id: p.corteCajaId } : {}),
  };
}

interface FilaVenta {
  venta_id: string;
  estado_venta: 'pendiente' | 'liquidada';
  importe_total: string;
  pagado: string;
  saldo_pendiente: string;
  boletos: BoletoEmitidoRaw[];
  print_jobs: number;
  imprimible: boolean;
}

interface BoletoEmitidoRaw {
  boleto_id: string;
  folio: string;
  asiento_num: number;
  pasajero: string;
  importe: number;
}

export async function registrarVenta(
  db: Consultable,
  args: RegistrarVentaArgs,
): Promise<ResultadoVenta> {
  const { rows } = await db.query<FilaVenta>(
    `SELECT venta_id, estado_venta, importe_total, pagado, saldo_pendiente,
            boletos, print_jobs, imprimible
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
    })),
    printJobs: Number(f.print_jobs),
    imprimible: f.imprimible,
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
}

export async function registrarPago(
  db: Consultable,
  args: RegistrarPagoArgs,
): Promise<ResultadoPago> {
  const { rows } = await db.query<{
    pago_id: string; pagado: string; saldo_pendiente: string;
    liquidada: boolean; print_jobs: number;
  }>(
    `SELECT pago_id, pagado, saldo_pendiente, liquidada, print_jobs
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
