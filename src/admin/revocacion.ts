/**
 * Generación de códigos de revocación fuera de banda (F2b, slice 3, capa 3).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5
 *
 * Corre EN LA NUBE, donde vive la semilla de cada sucursal
 * (`auth_local.revocacion_hotp`, replicada por 0035). El administrador pide un
 * código, la consola lo devuelve una vez, y él lo dicta por teléfono al gerente
 * de la sucursal incomunicada.
 *
 * Cada código consume un contador: se avanza `ultimo_usado` (que baja replicado,
 * como referencia para el nodo). El nodo NO necesita ese valor exacto para
 * validar — barre una ventana — pero le sirve de piso.
 */

import type { Consultable } from '../db/consulta.js';
import { generarCodigo } from '../auth/hotp.js';
import { escribirConfig } from './escribir-config.js';

export interface CodigoRevocacion {
  codigo: string;
  contador: number;
  sucursalId: string;
}

/**
 * Genera el código para desactivar `usuarioId` en `sucursalId`.
 *
 * Lanza si la sucursal no tiene semilla (no debería pasar: `crearSucursal` la
 * genera al alta).
 */
export async function generarCodigoRevocacion(
  db: Consultable,
  args: { sucursalId: string; usuarioId: string; ahora?: () => Date },
): Promise<CodigoRevocacion> {
  const { rows } = await db.query<{ semilla: Buffer; ultimo_usado: string }>(
    `SELECT semilla, ultimo_usado FROM auth_local.revocacion_hotp
      WHERE sucursal_id = $1 AND activo`,
    [args.sucursalId],
  );
  if (!rows[0]) {
    throw new Error(`la sucursal ${args.sucursalId} no tiene semilla de revocación`);
  }

  const contador = Number(rows[0].ultimo_usado) + 1;
  const codigo = generarCodigo(rows[0].semilla, args.usuarioId, contador);

  await escribirConfig(db, {
    tabla: 'auth_local.revocacion_hotp',
    fila: { id: args.sucursalId, sucursal_id: args.sucursalId, ultimo_usado: contador },
    modo: 'inmediato',
    confirmarInmediato: true,
    ...(args.ahora ? { ahora: args.ahora } : {}),
  });

  return { codigo, contador, sucursalId: args.sucursalId };
}
