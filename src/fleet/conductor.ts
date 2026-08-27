/**
 * Cambio de conductor sobre una salida.
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5
 *
 * La regla completa (los cuatro casos) vive en `core.cambiar_conductor`. Aquí
 * solo se la invoca. El cambio se inicia en la terminal (RBAC vendedor / gerente
 * / administrador); el caso 2 incompatible exige conexión y, sin ella, queda
 * `pendiente` para la siguiente sincronización.
 */

import type { Consultable } from '../db/consulta.js';

export type CasoCambio = 1 | 2 | 3 | 4;

export interface ResultadoCambioConductor {
  /** 1 compatible · 2 incompatible · 3 sin boletos. (El caso 4 lanza.) */
  caso: CasoCambio;
  estado: 'aplicado' | 'pendiente';
  /** Boletos que quedaron sin asiento y entraron a la cola de reasignación. */
  boletosAfectados: number;
  /** Fila de `core.cambio_conductor` que registró la operación. */
  cambioId: string;
}

export interface CambiarConductorArgs {
  salidaId: string;
  conductorNuevoId: string;
  usuarioId: string;
  /** `false` cuando la terminal está sin internet. Por defecto `true`. */
  conConexion?: boolean;
  motivo?: string;
}

export async function cambiarConductor(
  db: Consultable,
  args: CambiarConductorArgs,
): Promise<ResultadoCambioConductor> {
  const { rows } = await db.query<{
    caso: number; estado: string; boletos_afectados: number; cambio_id: string;
  }>(
    `SELECT caso, estado, boletos_afectados, cambio_id
       FROM core.cambiar_conductor($1::uuid, $2::uuid, $3::uuid, $4::boolean, $5::text)`,
    [
      args.salidaId, args.conductorNuevoId, args.usuarioId,
      args.conConexion ?? true, args.motivo ?? null,
    ],
  );
  const r = rows[0]!;
  return {
    caso: r.caso as CasoCambio,
    estado: r.estado as 'aplicado' | 'pendiente',
    boletosAfectados: Number(r.boletos_afectados),
    cambioId: r.cambio_id,
  };
}
