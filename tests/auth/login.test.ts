/**
 * Login offline-safe — los cuatro criterios de aceptación de F2 y las rutas de
 * rechazo.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.3, §1.5
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F2)
 *
 * Contra PostgreSQL local real. Cada prueba vive en su propia transacción
 * revertida. NUNCA se abre un cliente a la nube: que el login no dependa de ella
 * es justamente lo que se está probando.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { login } from '../../src/auth/login.js';
import { seleccionarSucursal, verificarSesion } from '../../src/auth/sesion.js';
import { PASSWORD_OK, fijarNodo, seedAuth } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-01T12:00:00.000Z');
const ahora = (): Date => AHORA;
const haceHoras = (h: number): Date => new Date(AHORA.getTime() - h * 3_600_000);

run('login offline (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const registrarIntento = async (email: string, exito: boolean, cuando: Date): Promise<void> => {
    await db.query(
      `INSERT INTO auth_local.intento (email, exito, ocurrido_en)
       VALUES ($1::citext, $2::boolean, $3::timestamptz)`,
      [email, exito, cuando],
    );
  };

  // -------------------------------------------------------------------------
  // F2 · criterio 1 — login con la red desconectada y con la nube caída
  // -------------------------------------------------------------------------
  it('1 · autentica contra la base local sin tocar la nube', async () => {
    const fx = await seedAuth(db);
    const r = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });

    expect(r.ok, r.ok ? '' : r.motivo).toBe(true);
    if (!r.ok) return;
    expect(r.rol).toBe('vendedor');
    expect(r.sesionCompleta, 'con una sola sucursal la sesión ya queda lista').toBe(true);

    const sesion = await verificarSesion(db, r.token, { ahora });
    expect(sesion?.sucursalId).toBe(fx.sucursalAId);
    expect(sesion?.rol).toBe('vendedor');
  });

  it('1 · con dos sucursales la sesión queda incompleta hasta elegir', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const r = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.sesionCompleta).toBe(false);
    expect(r.sucursales.map((s) => s.id).sort()).toEqual([fx.sucursalAId, fx.sucursalBId].sort());
    expect((await verificarSesion(db, r.token, { ahora }))?.sucursalId).toBeNull();

    const sel = await seleccionarSucursal(db, { token: r.token, sucursalId: fx.sucursalBId, ahora });
    expect(sel.ok).toBe(true);
    expect((await verificarSesion(db, r.token, { ahora }))?.sucursalId).toBe(fx.sucursalBId);
  });

  it('1 · una `sucursalId` preseleccionada válida completa la sesión de una vez', async () => {
    const fx = await seedAuth(db, { sucursales: 2 });
    const r = await login({
      node: db, email: fx.email, password: PASSWORD_OK, sucursalId: fx.sucursalAId, ahora,
    });
    expect(r.ok && r.sesionCompleta).toBe(true);
  });

  // -------------------------------------------------------------------------
  // F2 · criterio 2 — baja programada a las 03:00 → no entra al día siguiente
  // -------------------------------------------------------------------------
  it('2 · un usuario con `effective_until` ya vencido no puede entrar', async () => {
    const fx = await seedAuth(db, { usuarioHasta: haceHoras(9) });
    const r = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });
    expect(r).toEqual({ ok: false, motivo: 'usuario_no_vigente' });
  });

  it('2 · una baja programada al futuro todavía deja entrar', async () => {
    const fx = await seedAuth(db, { usuarioHasta: new Date(AHORA.getTime() + 12 * 3_600_000) });
    expect((await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora })).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // F2 · criterio 3 — baja recibida con `effective_from` vencido se aplica ya
  // -------------------------------------------------------------------------
  it('3 · una baja recibida tarde (effective_until en el pasado) surte efecto al instante', async () => {
    const fx = await seedAuth(db);
    // El nodo estuvo días sin internet y ahora sincroniza la baja del martes.
    await db.query(
      `UPDATE core.usuario SET effective_until = $2 WHERE id = $1`,
      [fx.usuarioId, haceHoras(72)],
    );
    const r = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });
    expect(r).toEqual({ ok: false, motivo: 'usuario_no_vigente' });
  });

  it('3 · sesión viva de un usuario cuya vigencia ya venció deja de valer', async () => {
    const fx = await seedAuth(db);
    const r = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await db.query(`UPDATE core.usuario SET effective_until = $2 WHERE id = $1`, [fx.usuarioId, haceHoras(1)]);
    expect(await verificarSesion(db, r.token, { ahora }), 'la sesión no sobrevive a la baja').toBeNull();
  });

  // -------------------------------------------------------------------------
  // F2 · criterio 4 — 73 h sin sync → bloqueo de primer login
  // -------------------------------------------------------------------------
  it('4 · en modo degradado se bloquea el primer login de un usuario inactivo', async () => {
    const fx = await seedAuth(db);
    await fijarNodo(db, fx.sucursalAId, 73, AHORA);

    const r = await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });
    expect(r).toEqual({ ok: false, motivo: 'bloqueo_degradado' });
  });

  it('4 · el gerente puede autorizar presencialmente ese primer login', async () => {
    const fx = await seedAuth(db);
    await fijarNodo(db, fx.sucursalAId, 73, AHORA);

    const r = await login({
      node: db, email: fx.email, password: PASSWORD_OK, autorizadoPorGerente: true, ahora,
    });
    expect(r.ok, r.ok ? '' : r.motivo).toBe(true);
  });

  it('4 · un usuario que entró en las últimas 24 h no se interrumpe aunque el nodo esté degradado', async () => {
    const fx = await seedAuth(db);
    await fijarNodo(db, fx.sucursalAId, 90, AHORA);
    await registrarIntento(fx.email, true, haceHoras(6));

    expect((await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora })).ok).toBe(true);
  });

  it('4 · a 71 h el nodo aún no está degradado y no bloquea a nadie', async () => {
    const fx = await seedAuth(db);
    await fijarNodo(db, fx.sucursalAId, 71, AHORA);
    expect((await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora })).ok).toBe(true);
  });

  it('4 · un nodo que nunca sincronizó no está degradado (está empezando)', async () => {
    const fx = await seedAuth(db);
    await fijarNodo(db, fx.sucursalAId, null, AHORA);
    expect((await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora })).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Rutas de rechazo
  // -------------------------------------------------------------------------
  it('rechaza una contraseña incorrecta sin decir si el email existe', async () => {
    const fx = await seedAuth(db);
    expect(await login({ node: db, email: fx.email, password: 'otra-cosa', ahora }))
      .toEqual({ ok: false, motivo: 'credenciales' });
    expect(await login({ node: db, email: 'no-existe@donaji.test', password: PASSWORD_OK, ahora }))
      .toEqual({ ok: false, motivo: 'credenciales' });
  });

  it('rechaza a un usuario sin credencial cargada como credencial incorrecta', async () => {
    const fx = await seedAuth(db, { sinCredencial: true });
    expect(await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora }))
      .toEqual({ ok: false, motivo: 'credenciales' });
  });

  it('rechaza a un usuario sin ninguna sucursal activa', async () => {
    const fx = await seedAuth(db);
    await db.query(
      `UPDATE core.usuario_sucursal SET effective_until = $2 WHERE usuario_id = $1`,
      [fx.usuarioId, haceHoras(1)],
    );
    expect(await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora }))
      .toEqual({ ok: false, motivo: 'sin_sucursal_activa' });
  });

  it('bloquea temporalmente tras demasiados fallos seguidos del mismo email', async () => {
    const fx = await seedAuth(db);
    for (let i = 0; i < 10; i++) await registrarIntento(fx.email, false, haceHoras(0.1));

    // Con la contraseña correcta: da igual, está en rate-limit.
    expect(await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora }))
      .toEqual({ ok: false, motivo: 'demasiados_intentos' });
  });

  it('los fallos viejos (fuera de la ventana) no cuentan para el rate-limit', async () => {
    const fx = await seedAuth(db);
    for (let i = 0; i < 20; i++) await registrarIntento(fx.email, false, haceHoras(1));  // >15 min
    expect((await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora })).ok).toBe(true);
  });

  it('registra cada intento en auth_local.intento, exitoso o no', async () => {
    const fx = await seedAuth(db);
    await login({ node: db, email: fx.email, password: 'mal', ahora });
    await login({ node: db, email: fx.email, password: PASSWORD_OK, ahora });

    const { rows } = await db.query<{ exito: boolean }>(
      // Por `id` (bigserial), no por `ocurrido_en`: el reloj de la prueba es
      // fijo, así que los dos intentos comparten timestamp y `ORDER BY
      // ocurrido_en` los devolvería en orden arbitrario.
      `SELECT exito FROM auth_local.intento WHERE email = $1 ORDER BY id`, [fx.email],
    );
    expect(rows.map((r) => r.exito)).toEqual([false, true]);
  });
});
