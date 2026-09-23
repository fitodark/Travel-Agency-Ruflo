/**
 * Traspaso en cadena de la unidad física de una salida sin boletos al resto
 * del día (Rule 2, QA Ses. 75).
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5
 *
 * La lógica vive en `core.mover_unidad`: cancela la salida origen y recorre
 * su unidad a la siguiente salida programada de la misma ruta el mismo día;
 * la unidad que esa salida ya tenía pasa al siguiente eslabón, y así hasta un
 * hueco o el fin del día. El mapa nunca se toca (es del conductor, no de la
 * unidad, 0074), así que los eslabones intermedios pueden tener boletos
 * vendidos sin problema — solo la salida donante debe estar vacía, porque es
 * la única que se cancela. Cualquier rol operativo puede hacerlo (lo filtra
 * la API, no esta función).
 */

import type { Consultable } from '../db/consulta.js';

export interface MoverUnidadArgs {
  salidaOrigenId: string;
  usuarioId: string;
  motivo?: string;
}

export interface ResultadoMoverUnidad {
  unidadId: string;
  /** Cuántas salidas recibieron una unidad distinta en esta cadena. */
  salidasAfectadas: number;
  /** La unidad que quedó sin horario al final de la cadena, si alguna. */
  unidadDesplazadaId: string | null;
}

export async function moverUnidad(
  db: Consultable,
  args: MoverUnidadArgs,
): Promise<ResultadoMoverUnidad> {
  const { rows } = await db.query<{
    unidad_id: string; salidas_afectadas: number; unidad_desplazada_id: string | null;
  }>(
    `SELECT unidad_id, salidas_afectadas, unidad_desplazada_id
       FROM core.mover_unidad($1::uuid, $2::uuid, $3::text)`,
    [args.salidaOrigenId, args.usuarioId, args.motivo ?? null],
  );
  const r = rows[0]!;
  return {
    unidadId: r.unidad_id,
    salidasAfectadas: Number(r.salidas_afectadas),
    unidadDesplazadaId: r.unidad_desplazada_id,
  };
}
