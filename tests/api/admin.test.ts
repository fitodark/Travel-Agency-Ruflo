/**
 * Sección de administración embebida en la API de la terminal (`/admin/*`).
 *
 * Escribe en la NUBE (aquí, la misma base en tx revertida) con la sesión LOCAL
 * del administrador. Sin `dbNube` → 503. Sin rol administrador → 403.
 *
 * Blueprint v0.2 · docs/architecture/blueprint.md §4.1
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

const AHORA = new Date('2026-09-10T12:00:00.000Z');
const ahora = (): Date => AHORA;

run('API · /admin (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    // La misma conexión hace de local y de "nube" para la prueba.
    app = await abrirApp(db, ahora, { dbNube: db });
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  it('GET /admin/salud reporta disponible cuando hay nube', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/salud' });
    expect(r.statusCode).toBe(200);
    expect(r.json().disponible).toBe(true);
  });

  it('sin token → 401; con rol no-admin → 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/sucursales' })).statusCode).toBe(401);

    const vend = await seedAuth(db, { rol: 'vendedor' });
    const tok = await tokenDe(db, vend.email, vend.sucursalAId, ahora);
    const r = await app.inject({ method: 'GET', url: '/admin/sucursales', headers: bearer(tok) });
    expect(r.statusCode).toBe(403);
  });

  it('un administrador lista y da de alta sucursales y usuarios', async () => {
    const admin = await seedAuth(db, { rol: 'administrador' });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);

    const lista = await app.inject({ method: 'GET', url: '/admin/sucursales', headers: bearer(tok) });
    expect(lista.statusCode).toBe(200);
    expect(Array.isArray(lista.json())).toBe(true);

    const alta = await app.inject({
      method: 'POST', url: '/admin/sucursales', headers: bearer(tok),
      payload: {
        agenciaId: admin.agenciaId, nombre: 'Sucursal Admin', direccionCompleta: 'Calle 9',
        telefonoPrincipal: '951 999 0000', modo: 'inmediato', confirmarInmediato: true,
      },
    });
    expect(alta.statusCode).toBe(201);
    expect(alta.json().escritoPor).toBe(admin.email);

    const usuarios = await app.inject({ method: 'GET', url: '/admin/usuarios', headers: bearer(tok) });
    expect(usuarios.statusCode).toBe(200);

    const nuevo = await app.inject({
      method: 'POST', url: '/admin/usuarios', headers: bearer(tok),
      payload: {
        nombre: 'Vendedor Nuevo', email: `nuevo-${Date.now()}@donaji.test`, rol: 'vendedor',
        sucursalIds: [admin.sucursalAId], modo: 'inmediato', confirmarInmediato: true,
      },
    });
    expect(nuevo.statusCode).toBe(201);
    expect(nuevo.json().passwordTemporal).toBeTruthy();
  });

  it('POST /admin/config/:tabla rechaza una tabla fuera de la lista', async () => {
    const admin = await seedAuth(db, { rol: 'administrador' });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);
    const r = await app.inject({
      method: 'POST', url: '/admin/config/core.boleto', headers: bearer(tok),
      payload: { fila: { id: '00000000-0000-7000-8000-000000000000' }, modo: 'inmediato', confirmarInmediato: true },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('tabla_no_administrable');
  });

  it('sin nube (`dbNube` null) todo /admin salvo /salud responde 503', async () => {
    await app.close();
    app = await abrirApp(db, ahora, { dbNube: null });

    const salud = await app.inject({ method: 'GET', url: '/admin/salud' });
    expect(salud.json().disponible).toBe(false);

    const admin = await seedAuth(db, { rol: 'administrador' });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);
    const r = await app.inject({ method: 'GET', url: '/admin/sucursales', headers: bearer(tok) });
    expect(r.statusCode).toBe(503);
  });
});
