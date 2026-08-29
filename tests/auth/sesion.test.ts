/**
 * Sesiones locales: apertura, verificación, elección de sucursal y cierre.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.2, §1.3
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  abrirSesion, cerrarSesion, cerrarSesionesDe, seleccionarSucursal, sucursalesDe, verificarSesion,
} from '../../src/auth/sesion.js';
import { seedAuth } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-01T12:00:00.000Z');
const ahora = (): Date => AHORA;

run('sesiones (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  it('abre una sesión sin sucursal y luego se completa eligiéndola', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const s = await abrirSesion(db, { usuarioId: fx.usuarioId, ahora });

    expect(s.sucursalId).toBeNull();
    expect(s.sucursalElegidaEn).toBeNull();
    expect(s.rol).toBe('vendedor');
    expect(s.expiraEn.getTime() - s.emitidaEn.getTime()).toBe(12 * 3_600_000);

    const sel = await seleccionarSucursal(db, { token: s.id, sucursalId: fx.sucursalAId, ahora });
    expect(sel).toEqual({ ok: true, sucursalId: fx.sucursalAId });

    const v = await verificarSesion(db, s.id, { ahora });
    expect(v?.sucursalId).toBe(fx.sucursalAId);
    expect(v?.sucursalElegidaEn).not.toBeNull();
  });

  it('abre una sesión ya con sucursal cuando se le pasa', async () => {
    const fx = await seedAuth(db);
    const s = await abrirSesion(db, { usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora });
    expect(s.sucursalId).toBe(fx.sucursalAId);
    expect(s.sucursalElegidaEn).not.toBeNull();
  });

  it('no deja elegir una sucursal que el usuario no tiene asignada', async () => {
    const fx = await seedAuth(db, { sucursales: 1 });
    const s = await abrirSesion(db, { usuarioId: fx.usuarioId, ahora });
    const sel = await seleccionarSucursal(db, { token: s.id, sucursalId: fx.sucursalBId, ahora });
    expect(sel).toEqual({ ok: false, motivo: 'sucursal_no_asignada' });
  });

  it('no deja reelegir sucursal en una sesión ya completa', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const s = await abrirSesion(db, { usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora });
    const sel = await seleccionarSucursal(db, { token: s.id, sucursalId: fx.sucursalBId, ahora });
    expect(sel).toEqual({ ok: false, motivo: 'ya_elegida' });
  });

  it('con permitirCambio sí reelige, pero solo entre las asignadas', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const s = await abrirSesion(db, { usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora });

    const ok = await seleccionarSucursal(db, {
      token: s.id, sucursalId: fx.sucursalBId, ahora, permitirCambio: true,
    });
    expect(ok).toEqual({ ok: true, sucursalId: fx.sucursalBId });
    expect((await verificarSesion(db, s.id, { ahora }))?.sucursalId).toBe(fx.sucursalBId);

    const otra = await seedAuth(db, { sucursales: 1 });
    const mala = await seleccionarSucursal(db, {
      token: s.id, sucursalId: otra.sucursalAId, ahora, permitirCambio: true,
    });
    expect(mala).toEqual({ ok: false, motivo: 'sucursal_no_asignada' });
  });

  it('sucursalesDe lista solo las asignadas y vigentes', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const lista = await sucursalesDe(db, fx.usuarioId, AHORA);
    expect(lista.map((x) => x.id).sort()).toEqual([fx.sucursalAId, fx.sucursalBId].sort());
    expect(lista.every((x) => typeof x.nombre === 'string' && x.nombre.length > 0)).toBe(true);
  });

  it('un token que no corresponde a ninguna sesión se rechaza', async () => {
    const { rows } = await db.query<{ id: string }>(`SELECT core.uuid_v7() AS id`);
    const sel = await seleccionarSucursal(db, { token: rows[0]!.id, sucursalId: rows[0]!.id, ahora });
    expect(sel).toEqual({ ok: false, motivo: 'sesion_invalida' });
    expect(await verificarSesion(db, rows[0]!.id, { ahora })).toBeNull();
  });

  it('una sesión expirada ya no verifica', async () => {
    const fx = await seedAuth(db);
    const s = await abrirSesion(db, { usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora });

    const despues = (): Date => new Date(s.expiraEn.getTime() + 1000);
    expect(await verificarSesion(db, s.id, { ahora: despues })).toBeNull();
  });

  it('cerrar una sesión la invalida, y cerrarla de nuevo no hace nada', async () => {
    const fx = await seedAuth(db);
    const s = await abrirSesion(db, { usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora });

    await cerrarSesion(db, s.id, 'fin_turno');
    expect(await verificarSesion(db, s.id, { ahora })).toBeNull();
    await cerrarSesion(db, s.id, 'otra_vez');  // idempotente: no lanza

    const { rows } = await db.query<{ cerrada_motivo: string }>(
      `SELECT cerrada_motivo FROM auth_local.sesion WHERE id = $1`, [s.id],
    );
    expect(rows[0]!.cerrada_motivo, 'conserva el primer motivo').toBe('fin_turno');
  });

  it('`cerrarSesionesDe` cierra todas las sesiones vivas de un usuario', async () => {
    const fx = await seedAuth(db);
    const a = await abrirSesion(db, { usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora });
    const b = await abrirSesion(db, { usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora });
    await cerrarSesion(db, b.id);  // esta ya está cerrada

    const n = await cerrarSesionesDe(db, fx.usuarioId, 'baja_usuario');
    expect(n, 'solo cuenta las que estaban vivas').toBe(1);
    expect(await verificarSesion(db, a.id, { ahora })).toBeNull();
  });

  it('el esquema no permite una sesión con sucursal pero sin marca de elección', async () => {
    const fx = await seedAuth(db);
    await expect(db.query(
      `INSERT INTO auth_local.sesion (usuario_id, sucursal_id, expira_en)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [fx.usuarioId, fx.sucursalAId],
    )).rejects.toThrow(/sesion_sucursal_coherente/);
  });
});
