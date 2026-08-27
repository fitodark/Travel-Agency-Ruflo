/**
 * Autenticación de las rutas: token opaco en `Authorization: Bearer`, resuelto
 * contra `auth_local.sesion`.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1
 *
 * La API local es la única autoridad de escritura del dominio (blueprint §4.1):
 * ninguna ruta que toque datos se sirve sin una sesión válida, y las de
 * configuración exigen además el permiso correspondiente de `core.rol_permiso`.
 */

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { puede } from '../auth/rbac.js';
import { verificarSesion } from '../auth/sesion.js';
import { conflicto, noAutorizado, prohibido } from './errores.js';
import type { ContextoSesion } from './tipos.js';

async function resolverSesion(req: FastifyRequest): Promise<ContextoSesion | null> {
  const cabecera = req.headers.authorization;
  if (!cabecera || !cabecera.startsWith('Bearer ')) return null;

  const token = cabecera.slice('Bearer '.length).trim();
  if (!token) return null;

  const s = await verificarSesion(req.server.db, token, { ahora: req.server.ahora });
  if (!s) return null;

  return { token, usuarioId: s.usuarioId, rol: s.rol, sucursalId: s.sucursalId };
}

export interface OpcionesExige {
  /**
   * Si `true` (default), la sesión debe tener sucursal elegida. Ponerlo en
   * `false` para las rutas que se usan JUSTO entre el login y la elección de
   * sucursal (p. ej. `POST /auth/sucursal`).
   */
  conSucursal?: boolean;
  /** Permiso de `core.rol_permiso` requerido, si alguno. */
  permiso?: string;
}

/**
 * `preHandler` que exige una sesión válida y, opcionalmente, sucursal elegida y
 * un permiso concreto. Deja la sesión en `req.sesion`.
 */
export function exige(opts: OpcionesExige = {}): preHandlerAsyncHookHandler {
  const conSucursal = opts.conSucursal ?? true;

  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const sesion = await resolverSesion(req);
    if (!sesion) throw noAutorizado();

    if (conSucursal && sesion.sucursalId === null) {
      throw conflicto('La sesión no tiene sucursal elegida');
    }
    if (opts.permiso && !(await puede(req.server.db, sesion.rol, opts.permiso))) {
      throw prohibido();
    }

    req.sesion = sesion;
  };
}
