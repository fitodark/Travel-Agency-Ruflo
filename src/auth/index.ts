/**
 * Autenticación y autorización offline de la terminal.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1
 *
 * El IdP de la operación es propio y local: Supabase Auth valida contra un
 * endpoint HTTP y sin internet no hay login. Este módulo funciona igual con o
 * sin red.
 */

export { login, estaDegradado } from './login.js';
export type { LoginArgs, LoginResult, LoginOk, MotivoRechazo } from './login.js';

export {
  abrirSesion, verificarSesion, seleccionarSucursal, cerrarSesion, cerrarSesionesDe, TTL_HORAS,
} from './sesion.js';
export type { Sesion, SeleccionResultado } from './sesion.js';

export { puede, permisosDe } from './rbac.js';
export type { Rol } from './rbac.js';

export { hashPassword, verifyPassword } from './passwords.js';
