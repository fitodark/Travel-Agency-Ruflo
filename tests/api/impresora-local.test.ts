/**
 * Override LOCAL de emergencia para la impresora (0078).
 *
 * `/admin/*` entero responde 503 sin `dbNube` (rutasAdmin, admin.ts) — por
 * diseño, esa configuración clase A exige la nube. `/impresora-local` es la
 * ruta de emergencia que debe seguir funcionando exactamente en ese escenario
 * (ver cabecera de src/api/rutas/impresora-local.ts), así que estas pruebas
 * corren CON `dbNube: null` (el default de `abrirApp`, igual que el resto de
 * tests/api/) para demostrarlo.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { seedCaja } from '../caja/fixture.js';
import { crearUsuarioConAcceso } from '../ventas/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date(Date.now() + 30 * 86_400_000);
const ahora = (): Date => AHORA;

run('API · /impresora-local (override de emergencia, 0078)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    app = await abrirApp(db, ahora); // dbNube: null por defecto — sin nube.
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  async function escena(rol: 'administrador' | 'gerente' | 'vendedor' = 'administrador') {
    const fx = await seedCaja(db, 1);
    const sucursalId = fx.sucursales[0]!;
    const u = await crearUsuarioConAcceso(db, sucursalId, rol);
    const token = await tokenDe(db, u.email, sucursalId, ahora);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO core.config_impresora (id, sucursal_id, nombre, transporte, ip, es_predeterminada)
       VALUES (core.uuid_v7(), $1, 'Caja 1', 'tcp', '192.168.1.50'::inet, true)
       RETURNING id`,
      [sucursalId],
    );
    return { sucursalId, token, impresoraId: rows[0]!.id };
  }

  it('/admin/* responde 503 sin nube — confirma el escenario que motiva esta ruta', async () => {
    const { token } = await escena();
    const r = await app.inject({ method: 'GET', url: '/admin/impresoras', headers: bearer(token) });
    expect(r.statusCode).toBe(503);
  });

  it('un administrador fija un override y GET lo refleja de inmediato, sin nube', async () => {
    const { token, impresoraId } = await escena();

    const antes = await app.inject({ method: 'GET', url: '/impresora-local', headers: bearer(token) });
    expect(antes.statusCode).toBe(200);
    expect(antes.json()).toEqual([
      expect.objectContaining({ id: impresoraId, ip: '192.168.1.50', override: null }),
    ]);

    const fijar = await app.inject({
      method: 'POST', url: `/impresora-local/${impresoraId}`, headers: bearer(token),
      payload: { transporte: 'tcp', ip: '10.0.0.77', puerto: 9100, nota: 'DHCP reasignó la IP' },
    });
    expect(fijar.statusCode).toBe(204);

    const despues = await app.inject({ method: 'GET', url: '/impresora-local', headers: bearer(token) });
    const fila = despues.json()[0];
    expect(fila.ip).toBe('10.0.0.77');
    expect(fila.override).toMatchObject({ ip: '10.0.0.77', nota: 'DHCP reasignó la IP' });

    // La fila replicada de core.config_impresora NO se tocó.
    const { rows } = await db.query<{ ip: string }>(
      `SELECT host(ip) AS ip FROM core.config_impresora WHERE id = $1`, [impresoraId],
    );
    expect(rows[0]!.ip).toBe('192.168.1.50');
  });

  it('DELETE quita el override y vuelve a la IP replicada', async () => {
    const { token, impresoraId } = await escena();
    await app.inject({
      method: 'POST', url: `/impresora-local/${impresoraId}`, headers: bearer(token),
      payload: { transporte: 'tcp', ip: '10.0.0.77' },
    });

    const borrar = await app.inject({
      method: 'DELETE', url: `/impresora-local/${impresoraId}`, headers: bearer(token),
    });
    expect(borrar.statusCode).toBe(204);

    const r = await app.inject({ method: 'GET', url: '/impresora-local', headers: bearer(token) });
    expect(r.json()[0]).toMatchObject({ ip: '192.168.1.50', override: null });
  });

  it('un override a usb exige usbNombreCola (400)', async () => {
    const { token, impresoraId } = await escena();
    const r = await app.inject({
      method: 'POST', url: `/impresora-local/${impresoraId}`, headers: bearer(token),
      payload: { transporte: 'usb' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().mensaje).toMatch(/usbNombreCola/);
  });

  it('una impresora que no existe en esta base local se rechaza (400)', async () => {
    const { token } = await escena();
    const r = await app.inject({
      method: 'POST',
      url: '/impresora-local/00000000-0000-0000-0000-000000000000',
      headers: bearer(token),
      payload: { transporte: 'tcp', ip: '10.0.0.1' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('gerente y vendedor no entran (403) — mismo criterio que /admin', async () => {
    for (const rol of ['gerente', 'vendedor'] as const) {
      const { token, impresoraId } = await escena(rol);
      const r = await app.inject({ method: 'GET', url: '/impresora-local', headers: bearer(token) });
      expect(r.statusCode).toBe(403);
      const post = await app.inject({
        method: 'POST', url: `/impresora-local/${impresoraId}`, headers: bearer(token),
        payload: { transporte: 'tcp', ip: '10.0.0.1' },
      });
      expect(post.statusCode).toBe(403);
    }
  });
});
