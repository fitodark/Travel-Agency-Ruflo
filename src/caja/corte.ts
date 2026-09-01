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
import type { Rol } from './movimiento.js';

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

// ---------------------------------------------------------------------------
// Historial de cortes, con visibilidad por rol (0045).
//   administrador → todos los cortes de todas las sucursales
//   gerente       → los cortes de la sucursal de su sesión
//   vendedor      → solo los cortes que él mismo abrió
// ---------------------------------------------------------------------------

/** Contexto de sesión que decide qué cortes se ven. */
export interface AlcanceCorte {
  rol: Rol;
  usuarioId: string;
  sucursalId: string;
}

export interface CorteHistorial {
  corteId: string;
  sucursalId: string;
  sucursal: string;
  estado: 'abierto' | 'cerrado';
  abiertoEn: Date;
  cerradoEn: Date | null;
  usuarioApertura: string;
  usuarioCierre: string | null;
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  saldoCalculado: number;
  /** `null` mientras el corte sigue abierto. */
  saldoDeclarado: number | null;
  /** `declarado − calculado`; `null` mientras el corte sigue abierto. */
  diferencia: number | null;
}

interface FilaCorteHistorial {
  corte_id: string;
  sucursal_id: string;
  sucursal: string;
  estado: 'abierto' | 'cerrado';
  abierto_en: Date;
  cerrado_en: Date | null;
  usuario_apertura: string;
  usuario_cierre: string | null;
  saldo_inicial: string;
  ingresos: string;
  egresos: string;
  saldo_calculado: string;
  saldo_declarado: string | null;
  diferencia: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export async function historialCortes(
  db: Consultable,
  alcance: AlcanceCorte,
  filtros: { desde?: string; hasta?: string; estado?: 'abierto' | 'cerrado' } = {},
): Promise<CorteHistorial[]> {
  const { rows } = await db.query<FilaCorteHistorial>(
    `SELECT corte_id, sucursal_id, sucursal, estado, abierto_en, cerrado_en,
            usuario_apertura, usuario_cierre, saldo_inicial, ingresos, egresos,
            saldo_calculado, saldo_declarado, diferencia
       FROM core.f_cortes_visibles($1::text, $2::uuid, $3::uuid, $4::date, $5::date, $6::text)`,
    [
      alcance.rol, alcance.usuarioId, alcance.sucursalId,
      filtros.desde ?? null, filtros.hasta ?? null, filtros.estado ?? null,
    ],
  );
  return rows.map((r) => ({
    corteId: r.corte_id,
    sucursalId: r.sucursal_id,
    sucursal: r.sucursal,
    estado: r.estado,
    abiertoEn: r.abierto_en,
    cerradoEn: r.cerrado_en,
    usuarioApertura: r.usuario_apertura,
    usuarioCierre: r.usuario_cierre,
    saldoInicial: Number(r.saldo_inicial),
    ingresos: Number(r.ingresos),
    egresos: Number(r.egresos),
    saldoCalculado: Number(r.saldo_calculado),
    saldoDeclarado: num(r.saldo_declarado),
    diferencia: num(r.diferencia),
  }));
}

/** ¿El alcance de esta sesión puede ver este corte (y sus movimientos)? */
export async function corteVisiblePor(
  db: Consultable, corteId: string, alcance: AlcanceCorte,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT core.corte_visible_por($1::uuid, $2::text, $3::uuid, $4::uuid) AS ok`,
    [corteId, alcance.rol, alcance.usuarioId, alcance.sucursalId],
  );
  return rows[0]!.ok;
}
