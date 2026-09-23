/**
 * Asignación del conductor real de una salida.
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5
 *
 * Desde 0074 la unidad (no el conductor) determina el mapa de asientos de la
 * salida (D-7 invertido): asignar o cambiar el conductor nunca toca el mapa,
 * los cupos ni los boletos — es puro dato operativo de "quién maneja hoy". La
 * lógica vive en `core.cambiar_conductor`; aquí solo se invoca.
 */

import type { Consultable } from '../db/consulta.js';

export interface ResultadoCambioConductor {
  /** Fila de `core.cambio_conductor` que registró la operación. */
  cambioId: string;
}

export interface CambiarConductorArgs {
  salidaId: string;
  conductorNuevoId: string;
  usuarioId: string;
  motivo?: string;
}

export async function cambiarConductor(
  db: Consultable,
  args: CambiarConductorArgs,
): Promise<ResultadoCambioConductor> {
  const { rows } = await db.query<{ cambio_id: string }>(
    `SELECT cambio_id FROM core.cambiar_conductor($1::uuid, $2::uuid, $3::uuid, $4::text)`,
    [args.salidaId, args.conductorNuevoId, args.usuarioId, args.motivo ?? null],
  );
  return { cambioId: rows[0]!.cambio_id };
}
