/**
 * Catálogos de configuración — solo lectura, con RBAC (HTTP, PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.4
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { seedAuth } from '../auth/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-01T12:00:00.000Z');
const ahora = (): Date => AHORA;

run('API · /catalogos (PostgreSQL real)', () => {
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

  it('GET /catalogos/sucursales lista las vigentes', async () => {
    const fx = await seedAuth(db);
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);

    const r = await app.inject({ method: 'GET', url: '/catalogos/sucursales', headers: bearer(token) });
    expect(r.statusCode).toBe(200);
    const ids = (r.json() as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(fx.sucursalAId);
  });

  it('GET /catalogos/usuarios exige el permiso config.usuarios', async () => {
    const vendedor = await seedAuth(db, { rol: 'vendedor' });
    const admin = await seedAuth(db, { rol: 'administrador' });
    const tokV = await tokenDe(db, vendedor.email, vendedor.sucursalAId, ahora);
    const tokA = await tokenDe(db, admin.email, admin.sucursalAId, ahora);

    expect((await app.inject({ method: 'GET', url: '/catalogos/usuarios', headers: bearer(tokV) })).statusCode).toBe(403);

    const ok = await app.inject({ method: 'GET', url: '/catalogos/usuarios', headers: bearer(tokA) });
    expect(ok.statusCode).toBe(200);
    const emails = (ok.json() as { email: string }[]).map((u) => u.email);
    expect(emails).toContain(admin.email);
  });

  it('GET /catalogos/config-impresora devuelve null si la sucursal no tiene impresora', async () => {
    const fx = await seedAuth(db);
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);
    const r = await app.inject({ method: 'GET', url: '/catalogos/config-impresora', headers: bearer(token) });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('null');
  });

  it('GET /catalogos/config-impresora devuelve la impresora vigente de la sucursal', async () => {
    const fx = await seedAuth(db);
    await db.query(
      `INSERT INTO core.config_impresora (sucursal_id, nombre, transporte, ip, es_predeterminada)
       VALUES ($1::uuid, 'Enduro Barra', 'tcp', '192.168.1.50', true)`,
      [fx.sucursalAId],
    );
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);

    const r = await app.inject({ method: 'GET', url: '/catalogos/config-impresora', headers: bearer(token) });
    expect(r.json()).toMatchObject({ nombre: 'Enduro Barra', transporte: 'tcp', ip: '192.168.1.50' });
  });

  it('GET /catalogos/parametros devuelve el mapa de parámetros vigentes', async () => {
    const fx = await seedAuth(db);
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);

    const r = await app.inject({ method: 'GET', url: '/catalogos/parametros', headers: bearer(token) });
    expect(r.statusCode).toBe(200);
    const p = r.json() as Record<string, unknown>;
    expect(p['umbral_sync_degradado_horas']).toBe(72);
    expect(p['minutos_lease']).toBe(15);
  });

  it('GET /catalogos/parametros/:clave y 404 para una clave inexistente', async () => {
    const fx = await seedAuth(db);
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);

    const ok = await app.inject({
      method: 'GET', url: '/catalogos/parametros/minutos_lease', headers: bearer(token),
    });
    expect(ok.json()).toEqual({ clave: 'minutos_lease', valor: 15 });

    const no = await app.inject({
      method: 'GET', url: '/catalogos/parametros/no_existe', headers: bearer(token),
    });
    expect(no.statusCode).toBe(404);
  });
});
