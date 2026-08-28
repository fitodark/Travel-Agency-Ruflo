/**
 * Ciclo de vida del corte de caja (F6).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
 *
 * La lógica vive en `core.abrir_corte` / `core.cerrar_corte`. El "un solo corte
 * abierto por sucursal" lo garantiza un índice único parcial de la base, no esta
 * capa. El saldo se deriva de `core.v_corte_saldo` (solo movimientos activos).
 */

import type { Consultable } from '../db/consulta.js';

export async function abrirCorte(
  db: Consultable,
  args: { sucursalId: string; usuarioId: string; saldoInicial: number; ahora?: Date },
): Promise<string> {
  const { rows } = await db.query<{ abrir_corte: string }>(
    `SELECT core.abrir_corte($1::uuid, $2::uuid, $3::numeric, $4::timestamptz)`,
    [args.sucursalId, args.usuarioId, args.saldoInicial, args.ahora ?? new Date()],
  );
  return rows[0]!.abrir_corte;
}

export interface CierreCorte {
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  saldoCalculado: number;
  saldoDeclarado: number;
  /** `declarado - calculado`: positivo = sobra efectivo, negativo = falta. */
  diferencia: number;
}

export async function cerrarCorte(
  db: Consultable,
  args: { corteId: string; usuarioCierreId: string; saldoDeclarado: number; ahora?: Date },
): Promise<CierreCorte> {
  const { rows } = await db.query<{
    saldo_inicial: string; ingresos: string; egresos: string;
    saldo_calculado: string; saldo_declarado: string; diferencia: string;
  }>(
    `SELECT saldo_inicial, ingresos, egresos, saldo_calculado, saldo_declarado, diferencia
       FROM core.cerrar_corte($1::uuid, $2::uuid, $3::numeric, $4::timestamptz)`,
    [args.corteId, args.usuarioCierreId, args.saldoDeclarado, args.ahora ?? new Date()],
  );
  const r = rows[0]!;
  return {
    saldoInicial: Number(r.saldo_inicial),
    ingresos: Number(r.ingresos),
    egresos: Number(r.egresos),
    saldoCalculado: Number(r.saldo_calculado),
    saldoDeclarado: Number(r.saldo_declarado),
    diferencia: Number(r.diferencia),
  };
}

export interface SaldoCorte {
  corteId: string;
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  saldoCalculado: number;
}

export async function saldoCorte(db: Consultable, corteId: string): Promise<SaldoCorte | null> {
  const { rows } = await db.query<{
    corte_caja_id: string; saldo_inicial: string; ingresos: string;
    egresos: string; saldo_calculado: string;
  }>(
    `SELECT corte_caja_id, saldo_inicial, ingresos, egresos, saldo_calculado
       FROM core.v_corte_saldo WHERE corte_caja_id = $1::uuid`,
    [corteId],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    corteId: r.corte_caja_id,
    saldoInicial: Number(r.saldo_inicial),
    ingresos: Number(r.ingresos),
    egresos: Number(r.egresos),
    saldoCalculado: Number(r.saldo_calculado),
  };
}

/** El corte abierto de una sucursal, o `null`. */
export async function corteAbiertoDe(
  db: Consultable, sucursalId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM core.corte_caja
      WHERE sucursal_id = $1::uuid AND estado = 'abierto' AND activo`,
    [sucursalId],
  );
  return rows[0]?.id ?? null;
}
