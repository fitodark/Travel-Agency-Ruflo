/**
 * Leases de asiento (paso 3 del flujo, con conexión).
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §5
 *
 * Un lease reserva un asiento libre —incluso del cupo de otra sucursal— por 15
 * min. La lógica vive en `core.adquirir_lease` / `core.liberar_lease` /
 * `core.barrer_leases_expirados` / `core.consumir_lease`. Aquí solo se invocan.
 *
 * `adquirirLease` NO lanza cuando el asiento ya se tomó: devuelve el estado como
 * dato (`ocupado` / `lease_ajeno`). Solo lanza ante entradas imposibles.
 */

import type { Consultable } from '../db/consulta.js';

export type EstadoLease = 'otorgado' | 'ocupado' | 'lease_ajeno';

export interface ResultadoLease {
  estado: EstadoLease;
  /** Presentes solo si `estado === 'otorgado'`. */
  leaseId: string | null;
  expiraEn: Date | null;
}

export interface AdquirirLeaseArgs {
  salidaId: string;
  asientoNum: number;
  /** Tramo `[desde, hasta)` en órdenes de parada. */
  desde: number;
  hasta: number;
  /** La sucursal que pide el lease. */
  sucursalId: string;
  /** Por defecto, `minutos_lease` del parámetro (15 min). */
  duracionSeg?: number;
  /** Inyectable para pruebas. */
  ahora?: Date;
}

export async function adquirirLease(
  db: Consultable,
  args: AdquirirLeaseArgs,
): Promise<ResultadoLease> {
  const { rows } = await db.query<{
    estado: EstadoLease; lease_id: string | null; expira_en: Date | null;
  }>(
    `SELECT estado, lease_id, expira_en
       FROM core.adquirir_lease($1::uuid, $2::smallint, $3::int, $4::int, $5::uuid,
                                $6::int, $7::timestamptz)`,
    [
      args.salidaId, args.asientoNum, args.desde, args.hasta, args.sucursalId,
      args.duracionSeg ?? null, args.ahora ?? new Date(),
    ],
  );
  const r = rows[0]!;
  return { estado: r.estado, leaseId: r.lease_id, expiraEn: r.expira_en };
}

/** Libera un lease no consumido. Idempotente: `true` si cambió algo. */
export async function liberarLease(
  db: Consultable, leaseId: string, ahora?: Date,
): Promise<boolean> {
  const { rows } = await db.query<{ liberar_lease: boolean }>(
    `SELECT core.liberar_lease($1::uuid, $2::timestamptz)`,
    [leaseId, ahora ?? new Date()],
  );
  return rows[0]!.liberar_lease;
}

/** Libera todos los leases vencidos no consumidos. Devuelve cuántos. */
export async function barrerLeasesExpirados(
  db: Consultable, ahora?: Date,
): Promise<number> {
  const { rows } = await db.query<{ barrer_leases_expirados: number }>(
    `SELECT core.barrer_leases_expirados($1::timestamptz)`,
    [ahora ?? new Date()],
  );
  return Number(rows[0]!.barrer_leases_expirados);
}

/** Ata un lease vivo a un boleto. `false` si ya venció o se liberó. */
export async function consumirLease(
  db: Consultable, leaseId: string, boletoId: string, ahora?: Date,
): Promise<boolean> {
  const { rows } = await db.query<{ consumir_lease: boolean }>(
    `SELECT core.consumir_lease($1::uuid, $2::uuid, $3::timestamptz)`,
    [leaseId, boletoId, ahora ?? new Date()],
  );
  return rows[0]!.consumir_lease;
}

export interface LeaseVivo {
  leaseId: string;
  asientoNum: number;
  tramos: string;
  sucursalId: string;
  otorgadoEn: Date;
  expiraEn: Date;
}

/** Leases todavía válidos de una salida (para inspección y UI). */
export async function leasesVivos(
  db: Consultable, salidaId: string, ahora?: Date,
): Promise<LeaseVivo[]> {
  const { rows } = await db.query<{
    id: string; asiento_num: number; tramos: string; sucursal_id: string;
    otorgado_en: Date; expira_en: Date;
  }>(
    `SELECT id, asiento_num, tramos::text AS tramos, sucursal_id, otorgado_en, expira_en
       FROM core.asiento_lease
      WHERE salida_id = $1::uuid
        AND consumido_por_boleto_id IS NULL
        AND liberado_en IS NULL
        AND expira_en > $2::timestamptz
      ORDER BY asiento_num`,
    [salidaId, ahora ?? new Date()],
  );
  return rows.map((r) => ({
    leaseId: r.id,
    asientoNum: Number(r.asiento_num),
    tramos: r.tramos,
    sucursalId: r.sucursal_id,
    otorgadoEn: r.otorgado_en,
    expiraEn: r.expira_en,
  }));
}
