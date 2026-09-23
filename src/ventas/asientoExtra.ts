/**
 * Hasta 2 asientos extra por salida, sin tocar el mapa (F4 / QA Ses. 76).
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §4
 *
 * La lógica vive en `core.vender_asiento_extra`: un solo pasajero, categoría
 * general, pago de contado (efectivo o transferencia íntegra) — nunca abono,
 * corresponsal ni reservación. Sin `cierre_venta_en` (pasa después del cierre
 * normal) ni cupo offline (siempre con conexión). Aquí solo se invoca.
 */

import type { Consultable } from '../db/consulta.js';

export interface VenderAsientoExtraArgs {
  salidaId: string;
  sucursalVentaId: string;
  usuarioId: string;
  contactoTelefono: string;
  origenOrden: number;
  destinoOrden: number;
  nombre: string;
  metodo: 'efectivo' | 'transferencia';
  /** Solo `efectivo`: con cuánto pagó (>= la tarifa). El backend calcula el cambio. */
  efectivoRecibido?: number;
  /** Solo `transferencia`. */
  referencia?: string;
  corteCajaId?: string;
  ahora?: Date;
}

export interface ResultadoAsientoExtra {
  ventaId: string;
  boletoId: string;
  folio: string;
  asientoNum: number;
  importe: number;
  estado: 'liquidada' | 'finalizada_transferencia';
  printJobs: number;
}

export async function venderAsientoExtra(
  db: Consultable,
  args: VenderAsientoExtraArgs,
): Promise<ResultadoAsientoExtra> {
  const { rows } = await db.query<{
    venta_id: string; boleto_id: string; folio: string; asiento_num: number;
    importe: string; estado_venta: 'liquidada' | 'finalizada_transferencia'; print_jobs: number;
  }>(
    `SELECT venta_id, boleto_id, folio, asiento_num, importe, estado_venta, print_jobs
       FROM core.vender_asiento_extra(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::int, $6::int, $7::text, $8::text,
         $9::numeric, $10::text, $11::uuid, $12::timestamptz)`,
    [
      args.salidaId, args.sucursalVentaId, args.usuarioId, args.contactoTelefono,
      args.origenOrden, args.destinoOrden, args.nombre, args.metodo,
      args.efectivoRecibido ?? null, args.referencia ?? null,
      args.corteCajaId ?? null, args.ahora ?? new Date(),
    ],
  );
  const r = rows[0]!;
  return {
    ventaId: r.venta_id,
    boletoId: r.boleto_id,
    folio: r.folio,
    asientoNum: Number(r.asiento_num),
    importe: Number(r.importe),
    estado: r.estado_venta,
    printJobs: Number(r.print_jobs),
  };
}
