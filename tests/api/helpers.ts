/**
 * Utilidades para probar la capa HTTP con `app.inject()`.
 *
 * El truco de aislamiento: `construirApp` recibe la conexión por parámetro, así
 * que se le pasa un `Client` dentro de una transacción que se revierte al final
 * de cada prueba. Nada llega a tocar la base de desarrollo de verdad.
 */

import type { FastifyInstance } from 'fastify';
import type { Client } from 'pg';
import { construirApp } from '../../src/api/server.js';
import { login } from '../../src/auth/login.js';
import { seleccionarSucursal } from '../../src/auth/sesion.js';
import { PASSWORD_OK } from '../auth/fixture.js';

export async function abrirApp(db: Client, ahora: () => Date): Promise<FastifyInstance> {
  return construirApp({ db, ahora, logger: false });
}

/** Entra por el módulo de auth (no por HTTP) y devuelve un token ya completo. */
export async function tokenDe(
  db: Client, email: string, sucursalId: string, ahora: () => Date,
): Promise<string> {
  const r = await login({ node: db, email, password: PASSWORD_OK, ahora });
  if (!r.ok) throw new Error(`login falló: ${r.motivo}`);
  if (!r.sesionCompleta) {
    await seleccionarSucursal(db, { token: r.token, sucursalId, ahora });
  }
  return r.token;
}

export const bearer = (token: string): { authorization: string } => ({
  authorization: `Bearer ${token}`,
});
