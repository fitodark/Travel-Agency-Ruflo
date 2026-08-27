/**
 * CRUD de clientes (HTTP, contra PostgreSQL real).
 *
 * `core.cliente` es clase B: la sucursal que lo registra es su única escritora y
 * sube por el outbox.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { login } from '../../src/auth/login.js';
import { PASSWORD_OK, seedAuth, type AuthFixture } from '../auth/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-01T12:00:00.000Z');
const ahora = (): Date => AHORA;

run('API · /clientes (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;
  let fx: AuthFixture;
  let token: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    app = await abrirApp(db, ahora);
    fx = await seedAuth(db);
    token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  const crear = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/clientes', headers: bearer(token), payload });

  it('POST crea un cliente y le pone la sucursal de la sesión', async () => {
    const r = await crear({ nombre: 'Ana Pérez', telefono: '953-111-2233' });
    expect(r.statusCode).toBe(201);
    const c = r.json();
    expect(c.id).toBeTruthy();
    expect(c.nombre).toBe('Ana Pérez');
    expect(c.sucursalRegistroId).toBe(fx.sucursalAId);
  });

  it('POST sin nombre → 400', async () => {
    expect((await crear({ telefono: '9531112233' })).statusCode).toBe(400);
  });

  it('GET / busca por nombre y por teléfono normalizado', async () => {
    await crear({ nombre: 'Ana Pérez', telefono: '(953) 111 22 33' });
    await crear({ nombre: 'Beto López', telefono: '953 444 5566' });

    const porNombre = await app.inject({ method: 'GET', url: '/clientes?q=pérez', headers: bearer(token) });
    expect(porNombre.json()).toHaveLength(1);
    expect(porNombre.json()[0].nombre).toBe('Ana Pérez');

    const porTel = await app.inject({ method: 'GET', url: '/clientes?telefono=4445566', headers: bearer(token) });
    expect(porTel.json()).toHaveLength(1);
    expect(porTel.json()[0].nombre).toBe('Beto López');
  });

  it('GET /:id devuelve uno y 404 si no existe', async () => {
    const id = (await crear({ nombre: 'Ana' })).json().id as string;
    expect((await app.inject({ method: 'GET', url: `/clientes/${id}`, headers: bearer(token) })).statusCode).toBe(200);

    const r = await app.inject({
      method: 'GET', url: '/clientes/00000000-0000-7000-8000-000000000000', headers: bearer(token),
    });
    expect(r.statusCode).toBe(404);
  });

  it('PATCH /:id actualiza solo los campos enviados', async () => {
    const id = (await crear({ nombre: 'Ana', telefono: '111' })).json().id as string;
    const r = await app.inject({
      method: 'PATCH', url: `/clientes/${id}`, headers: bearer(token), payload: { email: 'ana@correo.mx' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ nombre: 'Ana', telefono: '111', email: 'ana@correo.mx' });
  });

  it('DELETE /:id es baja lógica: desaparece de las búsquedas', async () => {
    const id = (await crear({ nombre: 'Efímero' })).json().id as string;
    expect((await app.inject({ method: 'DELETE', url: `/clientes/${id}`, headers: bearer(token) })).statusCode).toBe(204);

    expect((await app.inject({ method: 'GET', url: `/clientes/${id}`, headers: bearer(token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/clientes/${id}`, headers: bearer(token) })).statusCode).toBe(404);

    // La fila sigue en la base (baja lógica), solo que inactiva.
    const { rows } = await db.query<{ activo: boolean }>(`SELECT activo FROM core.cliente WHERE id = $1`, [id]);
    expect(rows[0]!.activo).toBe(false);
  });

  it('el cliente creado deja una fila de outbox para subir a la nube', async () => {
    const id = (await crear({ nombre: 'Sube a la nube' })).json().id as string;
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.outbox WHERE tabla = 'core.cliente' AND fila_id = $1`, [id],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('una sesión sin sucursal elegida no puede usar /clientes', async () => {
    const fx2 = await seedAuth(db, { sucursales: 2 });
    const r = await login({ node: db, email: fx2.email, password: PASSWORD_OK, ahora });
    if (!r.ok) throw new Error(r.motivo);

    const resp = await app.inject({ method: 'GET', url: '/clientes', headers: bearer(r.token) });
    expect(resp.statusCode).toBe(409);
  });
});
