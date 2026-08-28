/**
 * Tablero consolidado en nube — cableado HTTP (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
 *
 * La lógica de reportes ya la cubren `operacion.test.ts` / `auditoria.test.ts`.
 * Aquí: el bearer compartido, el rango obligatorio y la página estática.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { construirServidorTablero } from '../../src/dashboard/servidor.js';
import { abrirCorte } from '../../src/caja/corte.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { antesDelCierre, crearUsuario, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const TOKEN = 'token-de-prueba-suficientemente-largo';
const RANGO = 'desde=2020-01-01&hasta=2100-01-01';
const auth = { authorization: `Bearer ${TOKEN}` };

run('tablero en nube · HTTP (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    app = construirServidorTablero({ db, token: TOKEN });
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  const seedVenta = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const u = await crearUsuario(db);
    const corteId = await abrirCorte(db, {
      sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500,
    });
    const cuando = await antesDelCierre(db, fx.salidaId, 0);
    await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId: u,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 2, nombre: 'Ana', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      ahora: cuando,
    });
    return fx;
  };

  // -------------------------------------------------------------------------
  it('rechaza un token corto al construir', () => {
    expect(() => construirServidorTablero({ db, token: 'corto' })).toThrow(/token/i);
  });

  it('GET /salud responde sin token', async () => {
    const r = await app.inject({ method: 'GET', url: '/salud' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('GET / sirve la página del tablero', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toMatch(/Tablero/);
  });

  it('los reportes exigen el bearer correcto', async () => {
    expect((await app.inject({ method: 'GET', url: `/reportes/ventas?${RANGO}` })).statusCode).toBe(401);
    const malo = await app.inject({
      method: 'GET', url: `/reportes/ventas?${RANGO}`,
      headers: { authorization: 'Bearer otro-token-cualquiera-largo' },
    });
    expect(malo.statusCode).toBe(401);
  });

  it('GET /reportes/ventas con token agrega las ventas de todas las sucursales', async () => {
    const fx = await seedVenta();
    const r = await app.inject({ method: 'GET', url: `/reportes/ventas?${RANGO}`, headers: auth });
    expect(r.statusCode).toBe(200);
    const mias = r.json().filter((f: { sucursalId: string }) => f.sucursalId === fx.sucursales[0]);
    expect(mias.reduce((a: number, f: { boletos: number }) => a + f.boletos, 0)).toBe(1);
    expect(mias.reduce((a: number, f: { importeVendido: number }) => a + f.importeVendido, 0)).toBe(450);
  });

  it('GET /reportes/excepciones devuelve resumen y lista', async () => {
    const r = await app.inject({ method: 'GET', url: '/reportes/excepciones', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(expect.objectContaining({
      resumen: expect.objectContaining({ critica: expect.any(Number) }),
      abiertas: expect.any(Array),
    }));
  });

  it('GET /reportes/ventas sin rango → 400', async () => {
    const r = await app.inject({ method: 'GET', url: '/reportes/ventas', headers: auth });
    expect(r.statusCode).toBe(400);
  });
});
