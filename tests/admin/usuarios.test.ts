/**
 * Usuarios y accesos desde la consola de administración (F2b, slice 3).
 *
 * Contra PostgreSQL real, en transacción revertida. Solo el caso que comprueba la
 * publicación marca el nodo como nube, dentro de su propio `it`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { verifyPassword } from '../../src/auth/passwords.js';
import {
  asignarSucursal, contraseñaTemporal, crearUsuario, darDeBajaUsuario, editarUsuario,
  listarUsuarios, quitarSucursal, restablecerPassword,
} from '../../src/admin/usuarios.js';
import { construirServidorAdmin } from '../../src/admin/servidor.js';
import { firmarTokenSupabase } from '../../src/admin/auth-supabase.js';

const SECRETO = 'secreto-de-prueba-suficientemente-largo-2026';
const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;
const AHORA = new Date('2026-09-10T16:00:00.000Z');
const ahora = (): Date => AHORA;

describe('contraseñaTemporal (sin base)', () => {
  it('tiene la forma XXXX-XXXX-XXXX sin caracteres ambiguos', () => {
    const pw = contraseñaTemporal();
    expect(pw).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(pw).not.toMatch(/[ILO01]/);
  });
});

run('consola · usuarios (PostgreSQL real)', () => {
  let db: Client;
  let sucursalId: string;
  let sucursal2: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.sucursal WHERE activo ORDER BY creado_en LIMIT 2`,
    );
    sucursalId = rows[0]!.id;
    sucursal2 = rows[1]?.id ?? rows[0]!.id;
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const datos = (extra: Record<string, unknown> = {}) => ({
    nombre: 'Persona F2b',
    email: `u-${Math.floor(Math.random() * 1e9)}@donaji.test`,
    rol: 'vendedor' as const,
    ...extra,
  });

  const hashDe = async (usuarioId: string): Promise<string | null> => {
    const { rows } = await db.query<{ h: string }>(
      `SELECT hash_password AS h FROM auth_local.credencial WHERE usuario_id = $1`, [usuarioId],
    );
    return rows[0]?.h ?? null;
  };

  // ---- dominio -----------------------------------------------------------
  it('crearUsuario da de alta la fila, la credencial temporal y las sucursales', async () => {
    const r = await crearUsuario(db, datos({ telefono: '953 1', sucursalIds: [sucursalId] }), { ahora });
    expect(r.passwordTemporal).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);

    const { rows: u } = await db.query<{ rol: string; tel: string }>(
      `SELECT rol, telefono AS tel FROM core.usuario WHERE id = $1`, [r.id],
    );
    expect(u[0]).toMatchObject({ rol: 'vendedor', tel: '953 1' });

    const { rows: c } = await db.query<{ debe: boolean }>(
      `SELECT debe_cambiar AS debe FROM auth_local.credencial WHERE usuario_id = $1`, [r.id],
    );
    expect(c[0]!.debe).toBe(true);
    expect(await verifyPassword((await hashDe(r.id))!, r.passwordTemporal)).toBe(true);

    const { rows: us } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.usuario_sucursal WHERE usuario_id = $1 AND sucursal_id = $2`,
      [r.id, sucursalId],
    );
    expect(Number(us[0]!.n)).toBe(1);
  });

  it('crearUsuario rechaza un rol inválido', async () => {
    await expect(
      crearUsuario(db, datos({ rol: 'jefe' as 'vendedor' }), { ahora }),
    ).rejects.toThrow(/rol inválido/i);
  });

  it('editarUsuario cambia campos y sube la versión', async () => {
    const { id } = await crearUsuario(db, datos(), { ahora });
    await editarUsuario(db, id, { nombre: 'Renombrada', rol: 'gerente' },
      { modo: 'inmediato', confirmarInmediato: true, ahora });
    const { rows } = await db.query<{ nombre: string; rol: string; version: number }>(
      `SELECT nombre, rol, version FROM core.usuario WHERE id = $1`, [id],
    );
    expect(rows[0]).toMatchObject({ nombre: 'Renombrada', rol: 'gerente', version: 2 });
  });

  it('darDeBajaUsuario es inmediata por defecto (§3.4)', async () => {
    const { id } = await crearUsuario(db, datos(), { ahora });
    const r = await darDeBajaUsuario(db, id, { ahora });
    expect(new Date(r.effectiveUntil).getTime()).toBe(AHORA.getTime());
    const { rows } = await db.query<{ activo: boolean }>(
      `SELECT activo FROM core.usuario WHERE id = $1`, [id],
    );
    expect(rows[0]!.activo).toBe(false);
  });

  it('quitar y volver a asignar una sucursal reactiva la fila', async () => {
    const { id } = await crearUsuario(db, datos({ sucursalIds: [sucursalId] }), { ahora });
    await quitarSucursal(db, { usuarioId: id, sucursalId }, { ahora });
    let { rows } = await db.query<{ activo: boolean; eu: Date | null }>(
      `SELECT activo, effective_until AS eu FROM core.usuario_sucursal
        WHERE usuario_id = $1 AND sucursal_id = $2`, [id, sucursalId],
    );
    expect(rows[0]!.activo).toBe(false);

    await asignarSucursal(db, { usuarioId: id, sucursalId },
      { modo: 'inmediato', confirmarInmediato: true, ahora });
    ({ rows } = await db.query(
      `SELECT activo, effective_until AS eu FROM core.usuario_sucursal
        WHERE usuario_id = $1 AND sucursal_id = $2`, [id, sucursalId],
    ));
    expect(rows[0]!.activo).toBe(true);
    expect(rows[0]!.eu).toBeNull();
  });

  it('restablecerPassword invalida la contraseña vieja', async () => {
    const alta = await crearUsuario(db, datos(), { ahora });
    const reset = await restablecerPassword(db, alta.id, {}, { ahora });
    expect(reset.passwordTemporal).not.toBe(alta.passwordTemporal);

    const hash = (await hashDe(alta.id))!;
    expect(await verifyPassword(hash, alta.passwordTemporal)).toBe(false);
    expect(await verifyPassword(hash, reset.passwordTemporal)).toBe(true);
  });

  it('listarUsuarios trae credencial y sucursales', async () => {
    const { id } = await crearUsuario(db, datos({ sucursalIds: [sucursalId, sucursal2] }), { ahora });
    const lista = await listarUsuarios(db);
    const mio = lista.find((u) => u.id === id);
    expect(mio).toBeDefined();
    expect(mio!.tieneCredencial).toBe(true);
    expect(mio!.debeCambiarPassword).toBe(true);
    expect(mio!.sucursales.length).toBeGreaterThanOrEqual(1);
  });

  it('el alta publica el usuario y su credencial a las terminales', async () => {
    await db.query(`UPDATE sync.nodo SET es_nube = true WHERE singleton`);
    const { id } = await crearUsuario(db, datos(), { ahora });
    const { rows } = await db.query<{ tabla: string }>(
      `SELECT DISTINCT tabla FROM sync.cambio_log WHERE fila_id = $1`, [id],
    );
    expect(rows.map((r) => r.tabla).sort()).toEqual(['auth_local.credencial', 'core.usuario']);
  });
}, 30_000);

run('consola · usuarios por HTTP (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;
  let sucursalId: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.sucursal WHERE activo ORDER BY creado_en LIMIT 1`,
    );
    sucursalId = rows[0]!.id;
    app = construirServidorAdmin({ db, jwtSecret: SECRETO, adminsIniciales: ['jefe@donaji.mx'], ahora });
  });
  afterEach(async () => { await app.close(); await db.query('ROLLBACK'); });

  const auth = { authorization: `Bearer ${firmarTokenSupabase({ sub: 's', email: 'jefe@donaji.mx' }, SECRETO, ahora)}` };
  const body = (extra: Record<string, unknown> = {}) => ({
    nombre: 'HTTP', email: `h-${Math.floor(Math.random() * 1e9)}@donaji.test`, rol: 'vendedor',
    ...extra,
  });

  it('POST /api/usuarios crea (201) y devuelve la contraseña temporal', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/usuarios', headers: auth, payload: body() });
    expect(r.statusCode).toBe(201);
    expect(r.json().passwordTemporal).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
  });

  it('flujo completo: PATCH, asignar sucursal, quitar, restablecer, baja', async () => {
    const { id } = (await app.inject({
      method: 'POST', url: '/api/usuarios', headers: auth,
      payload: body({ modo: 'inmediato', confirmarInmediato: true }),
    })).json();

    for (const [method, url, payload] of [
      ['PATCH', `/api/usuarios/${id}`, { nombre: 'Nuevo', modo: 'inmediato', confirmarInmediato: true }],
      ['POST', `/api/usuarios/${id}/sucursales`, { sucursalId, modo: 'inmediato', confirmarInmediato: true }],
      ['DELETE', `/api/usuarios/${id}/sucursales/${sucursalId}`, {}],
      ['POST', `/api/usuarios/${id}/restablecer-password`, {}],
      ['POST', `/api/usuarios/${id}/baja`, {}],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth, payload });
      expect([200, 201], `${method} ${url} → ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    }
  });

  it('rol inválido en el body → 400', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/usuarios', headers: auth, payload: body({ rol: 'root' }),
    });
    expect(r.statusCode).toBe(400);
  });

  it('email repetido → 409', async () => {
    const email = `dup-${Math.floor(Math.random() * 1e9)}@donaji.test`;
    expect((await app.inject({ method: 'POST', url: '/api/usuarios', headers: auth, payload: body({ email }) })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/usuarios', headers: auth, payload: body({ email }) })).statusCode).toBe(409);
  });

  it('sin token → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/usuarios' })).statusCode).toBe(401);
  });
}, 30_000);
