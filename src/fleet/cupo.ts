/**
 * Reparto de cupo offline.
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §3
 *
 * La lógica vive en `core.repartir_cupo_offline`. La materialización ya la llama
 * por cada salida nueva; esto se usa para recalcular el reparto (p. ej. tras un
 * cambio de conductor, F3 slice 3) y para inspeccionarlo.
 */

import type { Consultable } from '../db/consulta.js';

/** Recalcula el reparto de una salida. Devuelve cuántas sucursales recibieron cupo. */
export async function repartirCupo(db: Consultable, salidaId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT core.repartir_cupo_offline($1::uuid) AS n`,
    [salidaId],
  );
  return Number(rows[0]!.n);
}

export interface CupoSucursal {
  sucursalId: string;
  /** Claves de los bloques asignados (trazabilidad del reparto). */
  bloques: string[];
  /** Identidades concretas de asiento, no un contador. */
  asientos: number[];
  /** Rango de tramos que esta sucursal puede vender, p. ej. `[1,3)`. */
  tramos: string;
  vigenteDesde: Date;
  /** Devolución automática al pool (SUPUESTO S5). */
  vigenteHasta: Date;
}

interface FilaCupo {
  sucursal_id: string;
  bloques: string[];
  asientos: number[];
  tramos: string;
  vigente_desde: Date;
  vigente_hasta: Date;
}

/** El reparto vigente de una salida, ordenado por parada de venta. */
export async function cupoDeSalida(db: Consultable, salidaId: string): Promise<CupoSucursal[]> {
  const { rows } = await db.query<FilaCupo>(
    `SELECT sucursal_id, bloques, asientos, tramos::text AS tramos,
            vigente_desde, vigente_hasta
       FROM core.cupo_offline
      WHERE salida_id = $1::uuid
      ORDER BY lower(tramos)`,
    [salidaId],
  );
  return rows.map((f) => ({
    sucursalId: f.sucursal_id,
    bloques: f.bloques,
    asientos: f.asientos.map(Number),
    tramos: f.tramos,
    vigenteDesde: f.vigente_desde,
    vigenteHasta: f.vigente_hasta,
  }));
}
