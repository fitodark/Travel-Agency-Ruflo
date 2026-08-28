/**
 * Rutas del tablero (HTTP, contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
 *
 * La lógica de F8 ya la cubren `tests/dashboard/`. Aquí, el cableado HTTP:
 * los reportes son SOLO LECTURA y solo para administradores.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { abrirCorte } from '../../src/caja/corte.js';
import { registrarEgreso } from '../../src/caja/movimiento.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { antesDelCierre, crearUsuario, crearUsuarioConAcceso, seedSalida } from '../ventas/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-15T09:00:00.000Z');
const ahora = (): Date => AHORA;
const RANGO = 'desde=2020-01-01&hasta=2100-01-01';

run('API · /reportes (PostgreSQL real)', () => {
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

  /** Una sucursal con una venta de 2 boletos pagada en efectivo y un egreso. */
  const prep = async (rolToken = 'administrador') => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const suc = fx.sucursales[0]!;
    await db.query(`UPDATE sync.nodo SET sucursal_id = $1::uuid WHERE singleton`, [suc]);
    const vendedor = await crearUsuario(db);
    const corteId = await abrirCorte(db, { sucursalId: suc, usuarioId: vendedor, saldoInicial: 500 });
    const cuando = await antesDelCierre(db, fx.salidaId, 0);
    await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: suc, usuarioId: vendedor,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [
        { asientoNum: 2, nombre: 'Ana', importe: 450 },
        { asientoNum: 3, nombre: 'Beto', importe: 450 },
      ],
      pago: { metodo: 'efectivo', monto: 900, corteCajaId: corteId },
      ahora: cuando,
    });
    await registrarEgreso(db, {
      corteId, usuarioId: vendedor, monto: 80, descripcion: 'papel',
    });

    const { email } = await crearUsuarioConAcceso(db, suc, rolToken);
    const token = await tokenDe(db, email, suc, ahora);
    return { fx, suc, token };
  };

  // -------------------------------------------------------------------------
  it('GET /reportes/ventas exige sesión', async () => {
    const r = await app.inject({ method: 'GET', url: `/reportes/ventas?${RANGO}` });
    expect(r.statusCode).toBe(401);
  });

  it('un vendedor no puede ver el tablero (403)', async () => {
    const { token } = await prep('vendedor');
    const r = await app.inject({
      method: 'GET', url: `/reportes/ventas?${RANGO}`, headers: bearer(token),
    });
    expect(r.statusCode).toBe(403);
  });

  it('GET /reportes/ventas: operaciones, boletos e importe de mi sucursal', async () => {
    const { suc, token } = await prep();
    const r = await app.inject({
      method: 'GET', url: `/reportes/ventas?${RANGO}`, headers: bearer(token),
    });
    expect(r.statusCode).toBe(200);
    const mias = r.json().filter((f: { sucursalId: string }) => f.sucursalId === suc);
    const tot = mias.reduce(
      (a: { b: number; v: number }, f: { boletos: number; importeVendido: number }) =>
        ({ b: a.b + f.boletos, v: a.v + f.importeVendido }),
      { b: 0, v: 0 },
    );
    expect(tot).toEqual({ b: 2, v: 900 });
  });

  it('GET /reportes/ventas-vs-caja incluye mi sucursal', async () => {
    const { token } = await prep();
    const r = await app.inject({
      method: 'GET', url: `/reportes/ventas-vs-caja?${RANGO}`, headers: bearer(token),
    });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
    expect(r.json().length).toBeGreaterThanOrEqual(1);
  });

  it('GET /reportes/cortes lista el corte abierto con su saldo', async () => {
    const { suc, token } = await prep();
    const r = await app.inject({
      method: 'GET', url: `/reportes/cortes?${RANGO}`, headers: bearer(token),
    });
    const mio = r.json().find((c: { sucursal: string }) => typeof c.sucursal === 'string');
    expect(mio).toBeDefined();
    const conEgreso = r.json().find((c: { egresos: number }) => c.egresos === 80);
    expect(conEgreso, 'el corte con el egreso de 80').toBeDefined();
    expect(conEgreso.saldoInicial).toBe(500);
    expect(suc).toBeTruthy();
  });

  it('GET /reportes/gastos suma el egreso de caja', async () => {
    const { token } = await prep();
    const r = await app.inject({
      method: 'GET', url: `/reportes/gastos?${RANGO}`, headers: bearer(token),
    });
    const egresos = r.json().filter((g: { concepto: string }) => g.concepto.startsWith('egreso_'));
    expect(egresos.reduce((a: number, g: { monto: number }) => a + g.monto, 0)).toBe(80);
  });

  it('GET /reportes/excepciones devuelve resumen y lista', async () => {
    const { token } = await prep();
    const r = await app.inject({
      method: 'GET', url: '/reportes/excepciones', headers: bearer(token),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().resumen).toEqual(
      expect.objectContaining({ critica: expect.any(Number), alta: expect.any(Number) }),
    );
    expect(Array.isArray(r.json().abiertas)).toBe(true);
  });

  it('GET /reportes/ventas sin rango → 400', async () => {
    const { token } = await prep();
    const r = await app.inject({
      method: 'GET', url: '/reportes/ventas', headers: bearer(token),
    });
    expect(r.statusCode).toBe(400);
  });
});
