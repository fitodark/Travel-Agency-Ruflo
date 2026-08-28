/**
 * Aplicación de un código de revocación en la terminal (F2b, slice 3, capa 3).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5
 *
 * OFFLINE: valida el código contra la semilla local de la sucursal
 * (`auth_local.revocacion_hotp`, replicada) y, si es válido, marca al usuario
 * como revocado en `auth_local.revocacion_aplicada` (local, no se replica) y
 * cierra sus sesiones vivas de inmediato.
 *
 * `login.ts` niega la entrada a un usuario con marca de revocación, salvo que su
 * `effective_from` sea posterior a la revocación (una re-alta desde la consola).
 */

import type { Consultable } from '../db/consulta.js';
import { verificarCodigo } from './hotp.js';

/** Cuántos contadores hacia adelante barre el nodo (el código viaja más rápido que el sync). */
const VENTANA = 25;

export type ResultadoRevocacion =
  | { ok: true; contador: number; sesionesCerradas: number }
  | { ok: false; motivo: 'sin_semilla' | 'codigo_invalido' };

/**
 * Aplica el código para desactivar `usuarioId` en esta terminal.
 *
 * `sucursalId` por defecto es la de este nodo (`sync.sucursal_local()`).
 */
export async function aplicarCodigoRevocacion(
  node: Consultable,
  args: { codigo: string; usuarioId: string; sucursalId?: string; ahora?: () => Date },
): Promise<ResultadoRevocacion> {
  const ahora = args.ahora?.() ?? new Date();

  const { rows: sem } = await node.query<{ semilla: Buffer; ultimo_usado: string }>(
    `SELECT h.semilla, h.ultimo_usado
       FROM auth_local.revocacion_hotp h
      WHERE h.sucursal_id = COALESCE($1::uuid, sync.sucursal_local()) AND h.activo`,
    [args.sucursalId ?? null],
  );
  if (!sem[0]) return { ok: false, motivo: 'sin_semilla' };

  // El piso del barrido: por encima de lo que la nube dice consumido Y de lo que
  // este nodo ya aplicó (anti-replay).
  const { rows: prev } = await node.query<{ contador: string }>(
    `SELECT contador FROM auth_local.revocacion_aplicada WHERE usuario_id = $1`,
    [args.usuarioId],
  );
  const desde = Math.max(
    Number(sem[0].ultimo_usado),
    prev[0] ? Number(prev[0].contador) : -1,
  ) + 1;

  const contador = verificarCodigo(sem[0].semilla, args.usuarioId, args.codigo, {
    desde, ventana: VENTANA,
  });
  if (contador === null) return { ok: false, motivo: 'codigo_invalido' };

  const sucursalId = args.sucursalId
    ?? (await node.query<{ s: string }>(`SELECT sync.sucursal_local() AS s`)).rows[0]!.s;

  await node.query(
    `INSERT INTO auth_local.revocacion_aplicada (usuario_id, sucursal_id, contador, aplicado_en)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (usuario_id) DO UPDATE
        SET sucursal_id = EXCLUDED.sucursal_id,
            contador    = EXCLUDED.contador,
            aplicado_en = EXCLUDED.aplicado_en`,
    [args.usuarioId, sucursalId, contador, ahora],
  );

  const { rowCount } = await node.query(
    `UPDATE auth_local.sesion
        SET cerrada_en = $2, cerrada_motivo = 'revocacion_hotp'
      WHERE usuario_id = $1 AND cerrada_en IS NULL`,
    [args.usuarioId, ahora],
  );

  return { ok: true, contador, sesionesCerradas: rowCount ?? 0 };
}
