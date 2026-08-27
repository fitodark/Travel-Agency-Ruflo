/**
 * Aplicador de configuración — la vigencia como dato, materializada con el reloj
 * local del nodo.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §3
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F2, criterios 2 y 3)
 *
 * Contra PostgreSQL local real, cada prueba en su transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { aplicarConfiguracion, ultimaPasadaAplicador } from '../../src/config/aplicador.js';
import { epocaConfig } from '../../src/config/epoca.js';
import { login } from '../../src/auth/login.js';
import { verificarSesion } from '../../src/auth/sesion.js';
import { PASSWORD_OK, seedAuth } from '../auth/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-01T12:00:00.000Z');
const ahora = (): Date => AHORA;
const haceHoras = (h: number): Date => new Date(AHORA.getTime() - h * 3_600_000);

run('aplicador de configuración (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const entrar = async (email: string, sucursalId: string): Promise<string> => {
    const r = await login({ node: db, email, password: PASSWORD_OK, sucursalId, ahora });
    if (!r.ok) throw new Error(`login falló: ${r.motivo}`);
    return r.token;
  };
  const motivoDe = async (token: string): Promise<string | null> => {
    const { rows } = await db.query<{ m: string | null }>(
      `SELECT cerrada_motivo AS m FROM auth_local.sesion WHERE id = $1`, [token],
    );
    return rows[0]?.m ?? null;
  };

  // -------------------------------------------------------------------------
  // F2 · criterios 2 y 3 — la baja de un usuario cierra su sesión
  // -------------------------------------------------------------------------
  it('cierra la sesión de un usuario cuya vigencia ya terminó', async () => {
    const fx = await seedAuth(db);
    const token = await entrar(fx.email, fx.sucursalAId);

    // La baja se recibió (o venció) mientras el usuario estaba en turno.
    await db.query(`UPDATE core.usuario SET effective_until = $2 WHERE id = $1`, [fx.usuarioId, haceHoras(1)]);

    const r = await aplicarConfiguracion(db, { ahora });
    expect(r.sesionesCerradasPorUsuario).toBe(1);
    expect(r.usuariosAfectados).toEqual([fx.usuarioId]);
    expect(await motivoDe(token)).toBe('vigencia_usuario');
    expect(await verificarSesion(db, token, { ahora })).toBeNull();
  });

  it('una baja recibida TARDE (effective_until ya en el pasado) surte efecto en la siguiente pasada', async () => {
    const fx = await seedAuth(db);
    const token = await entrar(fx.email, fx.sucursalAId);
    // El nodo estuvo días sin internet; ahora baja la fila con la baja del martes.
    await db.query(`UPDATE core.usuario SET effective_until = $2 WHERE id = $1`, [fx.usuarioId, haceHoras(72)]);

    expect((await aplicarConfiguracion(db, { ahora })).sesionesCerradasPorUsuario).toBe(1);
    expect(await verificarSesion(db, token, { ahora })).toBeNull();
  });

  it('un usuario desactivado (activo = false) también pierde su sesión', async () => {
    const fx = await seedAuth(db);
    const token = await entrar(fx.email, fx.sucursalAId);
    await db.query(`UPDATE core.usuario SET activo = false WHERE id = $1`, [fx.usuarioId]);

    expect((await aplicarConfiguracion(db, { ahora })).sesionesCerradasPorUsuario).toBe(1);
    expect(await verificarSesion(db, token, { ahora })).toBeNull();
  });

  it('no toca las sesiones de usuarios que siguen vigentes', async () => {
    const vigente = await seedAuth(db);
    const bajado = await seedAuth(db);
    const tokenVigente = await entrar(vigente.email, vigente.sucursalAId);
    const tokenBajado = await entrar(bajado.email, bajado.sucursalAId);

    await db.query(`UPDATE core.usuario SET effective_until = $2 WHERE id = $1`, [bajado.usuarioId, haceHoras(1)]);

    const r = await aplicarConfiguracion(db, { ahora });
    expect(r.sesionesCerradasPorUsuario).toBe(1);
    expect(r.usuariosAfectados).toEqual([bajado.usuarioId]);
    expect(await verificarSesion(db, tokenVigente, { ahora }), 'el vigente sigue dentro').not.toBeNull();
    expect(await verificarSesion(db, tokenBajado, { ahora })).toBeNull();
  });

  it('una baja programada al futuro todavía no cierra nada', async () => {
    const fx = await seedAuth(db);
    const token = await entrar(fx.email, fx.sucursalAId);
    await db.query(
      `UPDATE core.usuario SET effective_until = $2 WHERE id = $1`,
      [fx.usuarioId, new Date(AHORA.getTime() + 6 * 3_600_000)],
    );
    expect((await aplicarConfiguracion(db, { ahora })).sesionesCerradasPorUsuario).toBe(0);
    expect(await verificarSesion(db, token, { ahora })).not.toBeNull();
  });

  it('es idempotente: la segunda pasada seguida no cierra nada', async () => {
    const fx = await seedAuth(db);
    await entrar(fx.email, fx.sucursalAId);
    await db.query(`UPDATE core.usuario SET effective_until = $2 WHERE id = $1`, [fx.usuarioId, haceHoras(1)]);

    expect((await aplicarConfiguracion(db, { ahora })).sesionesCerradasPorUsuario).toBe(1);
    expect((await aplicarConfiguracion(db, { ahora })).sesionesCerradasPorUsuario).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Sucursal: la asignación deja de valer
  // -------------------------------------------------------------------------
  it('cierra la sesión cuando al usuario le quitan la sucursal desde la que opera', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const token = await entrar(fx.email, fx.sucursalAId);

    await db.query(
      `UPDATE core.usuario_sucursal SET effective_until = $3
        WHERE usuario_id = $1 AND sucursal_id = $2`,
      [fx.usuarioId, fx.sucursalAId, haceHoras(1)],
    );

    const r = await aplicarConfiguracion(db, { ahora });
    expect(r.sesionesCerradasPorSucursal).toBe(1);
    expect(r.sesionesCerradasPorUsuario).toBe(0);
    expect(await motivoDe(token)).toBe('vigencia_sucursal');
    expect(await verificarSesion(db, token, { ahora })).toBeNull();
  });

  it('cierra la sesión cuando se desactiva la sucursal desde la que se opera', async () => {
    const fx = await seedAuth(db);
    const token = await entrar(fx.email, fx.sucursalAId);
    await db.query(`UPDATE core.sucursal SET activo = false WHERE id = $1`, [fx.sucursalAId]);

    expect((await aplicarConfiguracion(db, { ahora })).sesionesCerradasPorSucursal).toBe(1);
    expect(await verificarSesion(db, token, { ahora })).toBeNull();
  });

  it('una sesión sin sucursal elegida no se cierra por el chequeo de sucursal', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const r = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });
    if (!r.ok) throw new Error(r.motivo);
    expect(r.sesionCompleta).toBe(false);

    const res = await aplicarConfiguracion(db, { ahora });
    expect(res.sesionesCerradasPorSucursal).toBe(0);
    expect(await verificarSesion(db, r.token, { ahora })).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Marca de la pasada y época de configuración
  // -------------------------------------------------------------------------
  it('registra la última pasada y acumula el total de sesiones cerradas', async () => {
    const fx = await seedAuth(db);
    await entrar(fx.email, fx.sucursalAId);
    await db.query(`UPDATE core.usuario SET effective_until = $2 WHERE id = $1`, [fx.usuarioId, haceHoras(1)]);

    expect(await ultimaPasadaAplicador(db), 'aún no ha corrido en esta tx').toBeNull();
    await aplicarConfiguracion(db, { ahora });

    expect((await ultimaPasadaAplicador(db))?.getTime()).toBe(AHORA.getTime());
    const { rows } = await db.query<{ n: string }>(
      `SELECT sesiones_cerradas_total AS n FROM sync.config_aplicado WHERE singleton`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('la época de configuración cambia cuando cambia una tabla de clase A', async () => {
    const e1 = await epocaConfig(db);
    await db.query(
      `UPDATE core.parametro SET valor = valor WHERE clave = 'minutos_lease'`,
    );
    const e2 = await epocaConfig(db);
    expect(e2).not.toBe(e1);
  });

  it('`epocaCambio` avisa a la caché: true tras un cambio, false si nada cambió', async () => {
    await aplicarConfiguracion(db, { ahora });                       // fija la época base
    const sinCambios = await aplicarConfiguracion(db, { ahora });
    expect(sinCambios.epocaCambio, 'nada cambió entre pasadas').toBe(false);

    // Cualquier UPDATE de una fila de clase A sube su `modificado_en` por trigger.
    await db.query(`UPDATE core.parametro SET valor = valor WHERE clave = 'minutos_lease'`);
    const conCambios = await aplicarConfiguracion(db, { ahora });
    expect(conCambios.epocaCambio, 'un parámetro cambió').toBe(true);
  });
});
