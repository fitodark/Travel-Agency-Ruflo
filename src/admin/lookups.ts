/**
 * Resoluciones que la UI necesita y que casi siempre tienen una sola respuesta.
 */

import type { Consultable } from '../db/consulta.js';

/**
 * La agencia, cuando hay exactamente una (el caso de Donaji). Si el llamador ya
 * pasó un id, se respeta. Si hay 0 o varias y no se pasó, lanza.
 */
export async function resolverAgencia(db: Consultable, dado?: string): Promise<string> {
  if (dado) return dado;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM core.agencia WHERE activo ORDER BY creado_en`,
  );
  if (rows.length === 1) return rows[0]!.id;
  throw new Error(
    rows.length === 0 ? 'no hay ninguna agencia' : 'hay varias agencias: especificá agenciaId',
  );
}
