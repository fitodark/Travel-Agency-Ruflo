/**
 * Rutas de caja (HTTP, contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
 *
 * La lógica de F6 ya la cubre `tests/caja/` (19). Aquí, el cableado HTTP:
 * sesión → sucursal/usuario/rol, visibilidad por rol, permisos, y el mapeo de
 * las reglas de negocio a 422.
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

const AHORA = new Date('2026-09-01T12:00:00.000Z');
const ahora = (): Date => AHORA;

run('API · /caja (PostgreSQL real)', () => {
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

  const conRol = async (rol = 'gerente') => {
    const fx = await seedCaja(db, 1);
    const { email } = await crearUsuarioConAcceso(db, fx.sucursales[0]!, rol);
    const token = await tokenDe(db, email, fx.sucursales[0]!, ahora);
    return { fx, token };
  };

  const abrirCorte = async (token: string, saldoInicial = 500) => {
    const r = await app.inject({
      method: 'POST', url: '/caja/corte', headers: bearer(token),
      payload: { saldoInicial },
    });
    expect(r.statusCode).toBe(201);
    return r.json().corteId as string;
  };

  // -------------------------------------------------------------------------
  it('GET /caja/corte devuelve null sin corte y el corte con su saldo tras abrirlo', async () => {
    const { token } = await conRol();
    expect((await app.inject({ method: 'GET', url: '/caja/corte', headers: bearer(token) })).json())
      .toBeNull();

    const corteId = await abrirCorte(token);
    const r = await app.inject({ method: 'GET', url: '/caja/corte', headers: bearer(token) });
    expect(r.json()).toMatchObject({
      corteId, saldoInicial: 500, ingresos: 0, egresos: 0, saldoCalculado: 500,
    });
  });

  it('un segundo corte en la sucursal se rechaza con 422 (regla de negocio de la BD)', async () => {
    const { token } = await conRol();
    await abrirCorte(token);
    const r = await app.inject({
      method: 'POST', url: '/caja/corte', headers: bearer(token), payload: { saldoInicial: 200 },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().mensaje).toMatch(/ya existe un corte de caja abierto/i);
  });

  it('egreso resta del corte y aparece en los movimientos', async () => {
    const { token } = await conRol();
    const corteId = await abrirCorte(token);
    const e = await app.inject({
      method: 'POST', url: `/caja/corte/${corteId}/egresos`, headers: bearer(token),
      payload: { monto: 120, descripcion: 'papel y jabón' },
    });
    expect(e.statusCode).toBe(201);

    const saldo = await app.inject({ method: 'GET', url: '/caja/corte', headers: bearer(token) });
    expect(saldo.json()).toMatchObject({ egresos: 120, saldoCalculado: 380 });

    const movs = await app.inject({
      method: 'GET', url: `/caja/corte/${corteId}/movimientos`, headers: bearer(token),
    });
    expect(movs.json()).toHaveLength(1);
    expect(movs.json()[0]).toMatchObject({ tipo: 'egreso', monto: 120 });
  });

  it('anular un egreso lo devuelve al corte; gerente no lo ve, admin sí', async () => {
    const { fx, token } = await conRol('gerente');
    const corteId = await abrirCorte(token);
    const e = await app.inject({
      method: 'POST', url: `/caja/corte/${corteId}/egresos`, headers: bearer(token),
      payload: { monto: 90, descripcion: 'café' },
    });
    const movId = e.json().movimientoId as string;

    const anular = await app.inject({
      method: 'POST', url: `/caja/movimientos/${movId}/anular`, headers: bearer(token),
      payload: { motivo: 'devuelto por el proveedor' },
    });
    expect(anular.json()).toEqual({ anulado: true });

    const saldo = await app.inject({ method: 'GET', url: '/caja/corte', headers: bearer(token) });
    expect(saldo.json().saldoCalculado).toBe(500);

    const comoGerente = await app.inject({
      method: 'GET', url: `/caja/corte/${corteId}/movimientos`, headers: bearer(token),
    });
    expect(comoGerente.json().find((m: { id: string }) => m.id === movId)).toBeUndefined();

    // Un administrador de la misma sucursal SÍ lo ve, inactivo.
    const admin = await crearUsuarioConAcceso(db, fx.sucursales[0]!, 'administrador');
    const tokAdmin = await tokenDe(db, admin.email, fx.sucursales[0]!, ahora);
    const comoAdmin = await app.inject({
      method: 'GET', url: `/caja/corte/${corteId}/movimientos`, headers: bearer(tokAdmin),
    });
    const visto = comoAdmin.json().find((m: { id: string }) => m.id === movId);
    expect(visto).toBeDefined();
    expect(visto.activo).toBe(false);
  });

  it('un vendedor no puede anular movimientos (403)', async () => {
    const { fx, token } = await conRol('gerente');
    const corteId = await abrirCorte(token);
    const e = await app.inject({
      method: 'POST', url: `/caja/corte/${corteId}/egresos`, headers: bearer(token),
      payload: { monto: 30, descripcion: 'clips' },
    });
    const movId = e.json().movimientoId as string;

    const vendedor = await crearUsuarioConAcceso(db, fx.sucursales[0]!, 'vendedor');
    const tok = await tokenDe(db, vendedor.email, fx.sucursales[0]!, ahora);
    const r = await app.inject({
      method: 'POST', url: `/caja/movimientos/${movId}/anular`, headers: bearer(tok),
      payload: { motivo: 'nope' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('cerrar el corte devuelve la diferencia declarado − calculado', async () => {
    const { token } = await conRol();
    const corteId = await abrirCorte(token, 500);
    await app.inject({
      method: 'POST', url: `/caja/corte/${corteId}/egresos`, headers: bearer(token),
      payload: { monto: 80, descripcion: 'focos' },
    });
    const r = await app.inject({
      method: 'POST', url: `/caja/corte/${corteId}/cerrar`, headers: bearer(token),
      payload: { saldoDeclarado: 430 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      saldoInicial: 500, egresos: 80, saldoCalculado: 420,
      saldoDeclarado: 430, diferencia: 10,
    });
  });

  it('un egreso sin descripción no pasa la validación (400)', async () => {
    const { token } = await conRol();
    const corteId = await abrirCorte(token);
    const r = await app.inject({
      method: 'POST', url: `/caja/corte/${corteId}/egresos`, headers: bearer(token),
      payload: { monto: 50 },
    });
    expect(r.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // GET /caja/cortes — historial visible por rol (0045).
  // -------------------------------------------------------------------------
  describe('GET /caja/cortes (historial por rol)', () => {
    /**
     * Dos sucursales. Un corte en cada una, abierto por un vendedor distinto.
     * Devuelve tokens de: admin (suc 0), gerente (suc 0), los dos vendedores.
     */
    async function escena() {
      const fx = await seedCaja(db, 2);
      const [sucA, sucB] = fx.sucursales as [string, string];
      const vA = await crearUsuarioConAcceso(db, sucA, 'vendedor');
      const vB = await crearUsuarioConAcceso(db, sucB, 'vendedor');
      const ger = await crearUsuarioConAcceso(db, sucA, 'gerente');
      const adm = await crearUsuarioConAcceso(db, sucA, 'administrador');
      const tokVA = await tokenDe(db, vA.email, sucA, ahora);
      const tokVB = await tokenDe(db, vB.email, sucB, ahora);
      const tokGer = await tokenDe(db, ger.email, sucA, ahora);
      const tokAdm = await tokenDe(db, adm.email, sucA, ahora);
      const corteA = await abrirCorte(tokVA, 100);
      const corteB = await abrirCorte(tokVB, 200);
      return { sucA, sucB, tokVA, tokVB, tokGer, tokAdm, corteA, corteB };
    }
    const ids = (r: { json: () => { corteId: string }[] }) => r.json().map((c) => c.corteId);

    it('el administrador ve los cortes de ambas sucursales', async () => {
      const e = await escena();
      const r = await app.inject({ method: 'GET', url: '/caja/cortes', headers: bearer(e.tokAdm) });
      expect(r.statusCode).toBe(200);
      expect(ids(r)).toEqual(expect.arrayContaining([e.corteA, e.corteB]));
    });

    it('el gerente ve solo los de su sucursal', async () => {
      const e = await escena();
      const r = await app.inject({ method: 'GET', url: '/caja/cortes', headers: bearer(e.tokGer) });
      expect(ids(r)).toContain(e.corteA);
      expect(ids(r)).not.toContain(e.corteB);
    });

    it('el vendedor ve solo los que él abrió', async () => {
      const e = await escena();
      const r = await app.inject({ method: 'GET', url: '/caja/cortes', headers: bearer(e.tokVA) });
      expect(ids(r)).toEqual([e.corteA]);
    });

    it('un vendedor no puede ver los movimientos de un corte ajeno (403)', async () => {
      const e = await escena();
      const r = await app.inject({
        method: 'GET', url: `/caja/corte/${e.corteB}/movimientos`, headers: bearer(e.tokVA),
      });
      expect(r.statusCode).toBe(403);
    });

    it('el administrador sí ve los movimientos de un corte de otra sucursal', async () => {
      const e = await escena();
      const r = await app.inject({
        method: 'GET', url: `/caja/corte/${e.corteB}/movimientos`, headers: bearer(e.tokAdm),
      });
      expect(r.statusCode).toBe(200);
    });
  });
});
