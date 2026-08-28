/**
 * Reportes de operación para el dashboard en nube (F8).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
 *
 * La lógica vive en el esquema `reporte` de la nube. Este módulo solo invoca y
 * normaliza. La distinción "ventas de la sucursal" vs. "ingreso a la caja de la
 * sucursal" (C5) está en dos funciones separadas a propósito.
 */

import type { Consultable } from '../db/consulta.js';

export interface RangoFechas {
  /** `YYYY-MM-DD`, inclusivo. */
  desde: string;
  hasta: string;
  sucursalId?: string;
}

export interface FilaVentas {
  sucursalId: string;
  sucursal: string;
  dia: string;
  operaciones: number;
  boletos: number;
  reservaciones: number;
  importeVendido: number;
  importeLiquidado: number;
}

export async function reporteVentas(
  db: Consultable, r: RangoFechas,
): Promise<FilaVentas[]> {
  const { rows } = await db.query<{
    sucursal_id: string; sucursal: string; dia: string;
    operaciones: number; boletos: number; reservaciones: number;
    importe_vendido: string; importe_liquidado: string;
  }>(
    `SELECT sucursal_id, sucursal, dia::text AS dia, operaciones, boletos, reservaciones,
            importe_vendido, importe_liquidado
       FROM reporte.f_ventas($1::date, $2::date, $3::uuid)`,
    [r.desde, r.hasta, r.sucursalId ?? null],
  );
  return rows.map((x) => ({
    sucursalId: x.sucursal_id,
    sucursal: x.sucursal,
    dia: x.dia,
    operaciones: Number(x.operaciones),
    boletos: Number(x.boletos),
    reservaciones: Number(x.reservaciones),
    importeVendido: Number(x.importe_vendido),
    importeLiquidado: Number(x.importe_liquidado),
  }));
}

export interface FilaIngresosCaja {
  sucursalId: string;
  sucursal: string;
  dia: string;
  pagos: number;
  efectivo: number;
  transferencia: number;
  transferenciaPendiente: number;
  totalConfirmado: number;
}

export async function reporteIngresosCaja(
  db: Consultable, r: RangoFechas,
): Promise<FilaIngresosCaja[]> {
  const { rows } = await db.query<{
    sucursal_id: string; sucursal: string; dia: string; pagos: number;
    efectivo: string; transferencia: string; transferencia_pendiente: string;
    total_confirmado: string;
  }>(
    `SELECT sucursal_id, sucursal, dia::text AS dia, pagos, efectivo, transferencia,
            transferencia_pendiente, total_confirmado
       FROM reporte.f_ingresos_caja($1::date, $2::date, $3::uuid)`,
    [r.desde, r.hasta, r.sucursalId ?? null],
  );
  return rows.map((x) => ({
    sucursalId: x.sucursal_id,
    sucursal: x.sucursal,
    dia: x.dia,
    pagos: Number(x.pagos),
    efectivo: Number(x.efectivo),
    transferencia: Number(x.transferencia),
    transferenciaPendiente: Number(x.transferencia_pendiente),
    totalConfirmado: Number(x.total_confirmado),
  }));
}

export interface FilaVentasVsCaja {
  sucursal: string;
  importeVendido: number;
  ingresoACaja: number;
  diferencia: number;
  nota: string;
}

export async function ventasVsCaja(
  db: Consultable, desde: string, hasta: string,
): Promise<FilaVentasVsCaja[]> {
  const { rows } = await db.query<{
    sucursal: string; importe_vendido: string; ingreso_a_caja: string;
    diferencia: string; nota: string;
  }>(
    `SELECT sucursal, importe_vendido, ingreso_a_caja, diferencia, nota
       FROM reporte.f_ventas_vs_caja($1::date, $2::date)`,
    [desde, hasta],
  );
  return rows.map((x) => ({
    sucursal: x.sucursal,
    importeVendido: Number(x.importe_vendido),
    ingresoACaja: Number(x.ingreso_a_caja),
    diferencia: Number(x.diferencia),
    nota: x.nota,
  }));
}

export interface FilaCorte {
  corteId: string;
  sucursal: string;
  abiertoEn: Date;
  cerradoEn: Date | null;
  estado: 'abierto' | 'cerrado';
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  saldoCalculado: number;
  saldoDeclarado: number | null;
  diferencia: number | null;
}

export async function reporteCortes(
  db: Consultable, r: RangoFechas,
): Promise<FilaCorte[]> {
  const { rows } = await db.query<{
    corte_id: string; sucursal: string; abierto_en: Date; cerrado_en: Date | null;
    estado: 'abierto' | 'cerrado'; saldo_inicial: string; ingresos: string;
    egresos: string; saldo_calculado: string; saldo_declarado: string | null;
    diferencia: string | null;
  }>(
    `SELECT corte_id, sucursal, abierto_en, cerrado_en, estado, saldo_inicial,
            ingresos, egresos, saldo_calculado, saldo_declarado, diferencia
       FROM reporte.f_cortes($1::date, $2::date, $3::uuid)`,
    [r.desde, r.hasta, r.sucursalId ?? null],
  );
  return rows.map((x) => ({
    corteId: x.corte_id,
    sucursal: x.sucursal,
    abiertoEn: x.abierto_en,
    cerradoEn: x.cerrado_en,
    estado: x.estado,
    saldoInicial: Number(x.saldo_inicial),
    ingresos: Number(x.ingresos),
    egresos: Number(x.egresos),
    saldoCalculado: Number(x.saldo_calculado),
    saldoDeclarado: x.saldo_declarado === null ? null : Number(x.saldo_declarado),
    diferencia: x.diferencia === null ? null : Number(x.diferencia),
  }));
}
