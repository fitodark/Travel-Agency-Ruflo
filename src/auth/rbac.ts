/**
 * Autorización basada en roles (RBAC).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.4
 *
 * La matriz de permisos es **dato replicado** (`core.rol_permiso`), no una
 * cadena de `if` en el código. Permite ajustar permisos sin desplegar — lo cual
 * importa el doble bajo D-8, donde desplegar significa que un humano viaje por
 * TeamViewer a cuatro terminales en una madrugada.
 *
 * Un permiso retirado es una fila con `activo = false` (`core.rol_permiso` no
 * lleva `effective_from`: los cambios de permiso surten efecto al replicarse, no
 * en una ventana). Por eso las dos consultas filtran `activo`.
 */

import type { Consultable } from '../db/consulta.js';

export type Rol = 'administrador' | 'gerente' | 'vendedor';

/**
 * ¿El rol tiene el permiso? Toda acción se ejecuta en el contexto
 * `(usuario_id, sucursal_id, corte_caja_id)`; la comprobación de permiso es
 * previa a cualquier escritura.
 */
export async function puede(node: Consultable, rol: string, permiso: string): Promise<boolean> {
  const { rows } = await node.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM core.rol_permiso WHERE rol = $1 AND permiso = $2 AND activo
     ) AS ok`,
    [rol, permiso],
  );
  return rows[0]!.ok;
}

/** Todos los permisos de un rol. Para armar el menú de la SPA de una sola vez. */
export async function permisosDe(node: Consultable, rol: string): Promise<string[]> {
  const { rows } = await node.query<{ permiso: string }>(
    `SELECT permiso FROM core.rol_permiso WHERE rol = $1 AND activo ORDER BY permiso`,
    [rol],
  );
  return rows.map((r) => r.permiso);
}
