/**
 * Resoluciones que la UI necesita y que casi siempre tienen una sola respuesta.
 */

import type { Consultable } from '../db/consulta.js';

/**
 * La agencia, cuando hay exactamente una (el caso de Donaji). Si el llamador ya
 * pasó un id, se respeta.
 *
 * El producto es de UNA sola agencia. Aun así, en dev/QA se acumulan filas
 * huérfanas en `core.agencia` (un `seed:admin` que crea "Donaji (dev)" y un
 * `seed:qa`/migración 0044 que deja "Agencia Donaji", más los fixtures de la
 * suite de caos). Cuando hay varias activas pero **solo una tiene sucursales
 * activas**, esa es la real y se elige; el resto es ruido. Solo se lanza si la
 * ambigüedad es genuina (varias con sucursales, o ninguna).
 */
export async function resolverAgencia(db: Consultable, dado?: string): Promise<string> {
  if (dado) return dado;
  const { rows } = await db.query<{ id: string; nombre: string; con_sucursales: boolean }>(
    `SELECT a.id, a.nombre,
            EXISTS (SELECT 1 FROM core.sucursal s
                     WHERE s.agencia_id = a.id AND s.activo) AS con_sucursales
       FROM core.agencia a
      WHERE a.activo
      ORDER BY a.creado_en`,
  );
  if (rows.length === 0) throw new Error('no hay ninguna agencia');
  if (rows.length === 1) return rows[0]!.id;

  const conSucursales = rows.filter((r) => r.con_sucursales);
  if (conSucursales.length === 1) return conSucursales[0]!.id;

  throw new Error(
    `hay varias agencias activas (${rows.map((r) => r.nombre).join(', ')}): especificá agenciaId`,
  );
}
