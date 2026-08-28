/**
 * Ciclo de vida del corte de caja (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F6)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { abrirCorte, cerrarCorte, corteAbiertoDe, saldoCorte } from '../../src/caja/corte.js';
import { crearUsuario, esperaError, seedCaja } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('corte de caja · ciclo de vida (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  it('abre un corte con su saldo inicial; ingresos y egresos arrancan en cero', async () => {
    const fx = await seedCaja(db);
    const u = await crearUsuario(db);
    const corteId = await abrirCorte(db, {
      sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500,
    });

    const s = await saldoCorte(db, corteId);
    expect(s).toEqual({
      corteId, saldoInicial: 500, ingresos: 0, egresos: 0, saldoCalculado: 500,
    });
    expect(await corteAbiertoDe(db, fx.sucursales[0]!)).toBe(corteId);
  });

  it('un segundo corte abierto en la misma sucursal lo rechaza la BASE DE DATOS', async () => {
    const fx = await seedCaja(db);
    const u = await crearUsuario(db);
    await abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500 });

    const e = await esperaError(db, () =>
      abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 300 }),
    );
    expect(e.message).toMatch(/ya existe un corte de caja abierto/i);

    // Y de verdad es el índice único, no una comprobación previa: sigue habiendo uno solo.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.corte_caja
        WHERE sucursal_id = $1 AND estado = 'abierto' AND activo`,
      [fx.sucursales[0]],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('otra sucursal sí puede tener su propio corte abierto a la vez', async () => {
    const fx = await seedCaja(db);
    const u = await crearUsuario(db);
    const a = await abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500 });
    const b = await abrirCorte(db, { sucursalId: fx.sucursales[1]!, usuarioId: u, saldoInicial: 800 });
    expect(a).not.toBe(b);
  });

  it('tras cerrar un corte se puede abrir otro en la misma sucursal (varios cortes al día)', async () => {
    const fx = await seedCaja(db);
    const u = await crearUsuario(db);
    const primero = await abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500 });
    await cerrarCorte(db, { corteId: primero, usuarioCierreId: u, saldoDeclarado: 500 });

    const segundo = await abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500 });
    expect(segundo).not.toBe(primero);
    expect(await corteAbiertoDe(db, fx.sucursales[0]!)).toBe(segundo);
  });

  it('cerrar devuelve el desglose y la diferencia declarado − calculado', async () => {
    const fx = await seedCaja(db);
    const u = await crearUsuario(db);
    const corteId = await abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500 });

    const cierre = await cerrarCorte(db, {
      corteId, usuarioCierreId: u, saldoDeclarado: 540,
    });
    expect(cierre).toEqual({
      saldoInicial: 500, ingresos: 0, egresos: 0,
      saldoCalculado: 500, saldoDeclarado: 540, diferencia: 40,
    });

    const { rows } = await db.query<{ estado: string; calc: string; decl: string }>(
      `SELECT estado, saldo_final_calculado AS calc, saldo_final_declarado AS decl
         FROM core.corte_caja WHERE id = $1`, [corteId],
    );
    expect(rows[0]!.estado).toBe('cerrado');
    expect(Number(rows[0]!.calc)).toBe(500);
    expect(Number(rows[0]!.decl)).toBe(540);
  });

  it('cerrar dos veces el mismo corte lanza', async () => {
    const fx = await seedCaja(db);
    const u = await crearUsuario(db);
    const corteId = await abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500 });
    await cerrarCorte(db, { corteId, usuarioCierreId: u, saldoDeclarado: 500 });
    await expect(
      cerrarCorte(db, { corteId, usuarioCierreId: u, saldoDeclarado: 500 }),
    ).rejects.toThrow(/ya está cerrado/i);
  });

  it('rechaza saldo inicial negativo', async () => {
    const fx = await seedCaja(db);
    const u = await crearUsuario(db);
    await expect(
      abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: -1 }),
    ).rejects.toThrow(/no puede ser negativo/i);
  });

  it('rechaza cerrar un corte inexistente', async () => {
    await expect(
      cerrarCorte(db, {
        corteId: '00000000-0000-7000-8000-000000000000',
        usuarioCierreId: '00000000-0000-7000-8000-000000000001', saldoDeclarado: 0,
      }),
    ).rejects.toThrow(/no existe/i);
  });

  it('rechaza abrir un corte con un usuario no vigente', async () => {
    const fx = await seedCaja(db);
    const u = await crearUsuario(db);
    await db.query(
      `UPDATE core.usuario SET effective_until = now() - interval '1 day' WHERE id = $1`, [u],
    );
    await expect(
      abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 100 }),
    ).rejects.toThrow(/no está vigente/i);
  });

  it('`corteAbiertoDe` devuelve null cuando no hay ninguno', async () => {
    const fx = await seedCaja(db);
    expect(await corteAbiertoDe(db, fx.sucursales[0]!)).toBeNull();
  });
});
