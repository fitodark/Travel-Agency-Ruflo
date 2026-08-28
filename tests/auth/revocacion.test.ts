/**
 * Aplicación de un código de revocación en la terminal (F2b, slice 3, capa 3).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5
 */

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { generarCodigo } from '../../src/auth/hotp.js';
import { aplicarCodigoRevocacion } from '../../src/auth/revocacion.js';
import { login } from '../../src/auth/login.js';
import { seedAuth, PASSWORD_OK } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;
const AHORA = new Date('2026-09-10T16:00:00.000Z');
const ahora = (): Date => AHORA;

run('revocación · aplicar el código en la terminal (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const semilla = randomBytes(20);

  /** Un usuario en su sucursal, con semilla de revocación y una sesión viva. */
  const prep = async () => {
    const fx = await seedAuth(db);
    await db.query(
      `INSERT INTO auth_local.revocacion_hotp (sucursal_id, semilla) VALUES ($1, $2)`,
      [fx.sucursalAId, semilla],
    );
    const r = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });
    expect(r.ok).toBe(true);
    return fx;
  };

  it('un código válido bloquea al usuario y cierra sus sesiones', async () => {
    const fx = await prep();
    const codigo = generarCodigo(semilla, fx.usuarioId, 0);

    const res = await aplicarCodigoRevocacion(db, {
      codigo, usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora,
    });
    expect(res).toMatchObject({ ok: true, contador: 0 });
    expect((res as { sesionesCerradas: number }).sesionesCerradas).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM auth_local.revocacion_aplicada WHERE usuario_id = $1`,
      [fx.usuarioId],
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // Y ya no puede volver a entrar.
    const reintento = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });
    expect(reintento).toMatchObject({ ok: false, motivo: 'revocado' });
  });

  it('usa la sucursal del nodo si no se pasa una', async () => {
    const fx = await prep();
    const codigo = generarCodigo(semilla, fx.usuarioId, 0);
    const res = await aplicarCodigoRevocacion(db, { codigo, usuarioId: fx.usuarioId, ahora });
    expect(res.ok).toBe(true);
  });

  it('rechaza un código que no corresponde', async () => {
    const fx = await prep();
    const res = await aplicarCodigoRevocacion(db, {
      codigo: '00000000', usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora,
    });
    expect(res).toEqual({ ok: false, motivo: 'codigo_invalido' });
  });

  it('el mismo código no se puede reusar (anti-replay)', async () => {
    const fx = await prep();
    const codigo = generarCodigo(semilla, fx.usuarioId, 0);
    expect((await aplicarCodigoRevocacion(db, {
      codigo, usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora,
    })).ok).toBe(true);
    expect(await aplicarCodigoRevocacion(db, {
      codigo, usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora,
    })).toEqual({ ok: false, motivo: 'codigo_invalido' });
  });

  it('sin semilla configurada devuelve sin_semilla', async () => {
    const fx = await seedAuth(db);
    const res = await aplicarCodigoRevocacion(db, {
      codigo: '12345678', usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora,
    });
    expect(res).toEqual({ ok: false, motivo: 'sin_semilla' });
  });

  it('una re-alta posterior (effective_from nuevo) deja entrar de nuevo', async () => {
    const fx = await prep();
    const codigo = generarCodigo(semilla, fx.usuarioId, 0);
    await aplicarCodigoRevocacion(db, { codigo, usuarioId: fx.usuarioId, sucursalId: fx.sucursalAId, ahora });
    expect((await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora })).ok).toBe(false);

    // El administrador lo vuelve a dar de alta: effective_from posterior a la marca.
    await db.query(
      `UPDATE core.usuario SET effective_from = $2, activo = true, effective_until = NULL WHERE id = $1`,
      [fx.usuarioId, new Date(AHORA.getTime() + 60_000)],
    );
    const reintento = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora: () => new Date(AHORA.getTime() + 120_000) });
    expect(reintento.ok).toBe(true);
  });
}, 30_000);
