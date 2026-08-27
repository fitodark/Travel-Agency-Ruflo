/**
 * Tipos compartidos de la capa HTTP.
 */

import type { Consultable } from '../db/consulta.js';

/**
 * Conexión a PostgreSQL que la API necesita. Un `Pool` (producción) o un
 * `Client` en transacción (pruebas) la cumplen: eso hace la capa probable con
 * `app.inject()` sin base dedicada.
 */
export type BaseDeDatos = Consultable;

/** Contexto de sesión que la autenticación adjunta a cada request protegida. */
export interface ContextoSesion {
  token: string;
  usuarioId: string;
  rol: string;
  /** `null` si el usuario aún no eligió sucursal; la mayoría de rutas lo exigen. */
  sucursalId: string | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: BaseDeDatos;
    ahora: () => Date;
  }
  interface FastifyRequest {
    sesion: ContextoSesion;
  }
}
