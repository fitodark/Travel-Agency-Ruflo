/**
 * Rutas de autenticación (HTTP, contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.3
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { resolveConnection } from '../../src/db/connection.js';
import { generarCodigo } from '../../src/auth/hotp.js';
import { PASSWORD_OK, seedAuth } from '../auth/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-01T12:00:00.000Z');
const ahora = (): Date => AHORA;

run('API · /auth (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    app = await abrirApp(db, ahora);
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  it('POST /auth/login devuelve token y sucursales con credenciales válidas', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const r = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: fx.email, password: PASSWORD_OK },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.token).toBeTruthy();
    expect(b.rol).toBe('vendedor');
    expect(b.sesionCompleta).toBe(false);
    expect(b.sucursales).toHaveLength(2);
  });

  it('POST /auth/login con una sola sucursal deja la sesión completa', async () => {
    const fx = await seedAuth(db);
    const r = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: fx.email, password: PASSWORD_OK },
    });
    expect(r.json().sesionCompleta).toBe(true);
  });

  it('POST /auth/login rechaza credenciales malas con 401', async () => {
    const fx = await seedAuth(db);
    const r = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: fx.email, password: 'nope' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('credenciales');
  });

  it('POST /auth/login responde 429 cuando el email está en rate-limit', async () => {
    const fx = await seedAuth(db);
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO auth_local.intento (email, exito, ocurrido_en) VALUES ($1::citext, false, $2)`,
        [fx.email, AHORA],
      );
    }
    const r = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: fx.email, password: PASSWORD_OK },
    });
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('demasiados_intentos');
  });

  it('POST /auth/login valida el cuerpo: sin password → 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'x@y.z' } });
    expect(r.statusCode).toBe(400);
  });

  it('POST /auth/sucursal completa la sesión; rechaza una sucursal ajena', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: fx.email, password: PASSWORD_OK },
    });
    const token = login.json().token as string;

    const mala = await app.inject({
      method: 'POST', url: '/auth/sucursal', headers: bearer(token),
      payload: { sucursalId: '00000000-0000-7000-8000-000000000000' },
    });
    expect(mala.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST', url: '/auth/sucursal', headers: bearer(token),
      payload: { sucursalId: fx.sucursalBId },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().sucursalId).toBe(fx.sucursalBId);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
    expect(me.json().sucursalId).toBe(fx.sucursalBId);
  });

  it('GET /auth/me devuelve rol, sucursal y permisos', async () => {
    const fx = await seedAuth(db, { rol: 'gerente' });
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);

    const r = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.rol).toBe('gerente');
    expect(b.sucursalId).toBe(fx.sucursalAId);
    expect(b.permisos).toContain('venta.anular');
    expect(b.permisos).not.toContain('config.horarios');
  });

  it('POST /auth/logout invalida el token', async () => {
    const fx = await seedAuth(db);
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);

    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) })).statusCode).toBe(401);
  });

  it('una ruta protegida sin token responde 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/clientes' })).statusCode).toBe(401);
  });

  it('GET /salud no pide sesión', async () => {
    const r = await app.inject({ method: 'GET', url: '/salud' });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });

  // -- capa 3 de revocación (§1.5) ----------------------------------------
  const conSemilla = async (fx: Awaited<ReturnType<typeof seedAuth>>): Promise<Buffer> => {
    const semilla = randomBytes(20);
    await db.query(
      `INSERT INTO auth_local.revocacion_hotp (sucursal_id, semilla) VALUES ($1, $2)`,
      [fx.sucursalAId, semilla],
    );
    return semilla;
  };

  it('POST /auth/revocar: un gerente aplica el código y el usuario ya no entra', async () => {
    const objetivo = await seedAuth(db);
    const semilla = await conSemilla(objetivo);
    const gerente = await seedAuth(db, { rol: 'gerente' });
    // El gerente opera la misma terminal que el objetivo.
    await db.query(`UPDATE sync.nodo SET sucursal_id = $1 WHERE singleton`, [objetivo.sucursalAId]);
    await db.query(
      `INSERT INTO core.usuario_sucursal (usuario_id, sucursal_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [gerente.usuarioId, objetivo.sucursalAId],
    );
    const token = await tokenDe(db, gerente.email, objetivo.sucursalAId, ahora);

    const r = await app.inject({
      method: 'POST', url: '/auth/revocar', headers: bearer(token),
      payload: { codigo: generarCodigo(semilla, objetivo.usuarioId, 0), usuarioId: objetivo.usuarioId },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().ok).toBe(true);

    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: objetivo.email, password: PASSWORD_OK },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json().error).toBe('revocado');
  });

  it('POST /auth/revocar: un vendedor no tiene el permiso (403)', async () => {
    const fx = await seedAuth(db);
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);
    const r = await app.inject({
      method: 'POST', url: '/auth/revocar', headers: bearer(token),
      payload: { codigo: '12345678', usuarioId: fx.usuarioId },
    });
    expect(r.statusCode).toBe(403);
  });

  it('POST /auth/revocar: código inválido → 400', async () => {
    const gerente = await seedAuth(db, { rol: 'gerente' });
    await conSemilla(gerente);
    const token = await tokenDe(db, gerente.email, gerente.sucursalAId, ahora);
    const r = await app.inject({
      method: 'POST', url: '/auth/revocar', headers: bearer(token),
      payload: { codigo: '00000000', usuarioId: gerente.usuarioId },
    });
    expect(r.statusCode).toBe(400);
  });
});
