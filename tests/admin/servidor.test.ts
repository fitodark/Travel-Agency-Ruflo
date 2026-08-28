/**
 * Consola de administración en nube: auth por JWT de Supabase + escritura de
 * configuración clase A (F2b, slice 1). Contra PostgreSQL real.
 *
 * Solo el caso que comprueba la publicación marca el nodo como nube, dentro de
 * su propio `it`, para no serializar la suite por el lock de la fila `sync.nodo`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { construirServidorAdmin } from '../../src/admin/servidor.js';
import { firmarTokenSupabase, verificarTokenSupabase, TokenInvalido } from '../../src/admin/auth-supabase.js';

const SECRETO = 'secreto-de-prueba-suficientemente-largo-2026';

describe('verificarTokenSupabase (sin base)', () => {
  it('acepta un token bien firmado y lee email/sub/rol', () => {
    const t = firmarTokenSupabase({ sub: 'u-1', email: 'Admin@Donaji.MX' }, SECRETO);
    const id = verificarTokenSupabase(t, SECRETO);
    expect(id).toMatchObject({ sub: 'u-1', email: 'admin@donaji.mx', rol: 'authenticated' });
  });

  it('rechaza una firma con otro secreto', () => {
    const t = firmarTokenSupabase({ sub: 'u-1', email: 'a@b.c' }, SECRETO);
    expect(() => verificarTokenSupabase(t, 'otro-secreto-igual-de-largo-2026')).toThrow(TokenInvalido);
  });

  it('rechaza un token expirado', () => {
    const t = firmarTokenSupabase({ sub: 'u-1', email: 'a@b.c', ttlSegundos: -10 }, SECRETO);
    expect(() => verificarTokenSupabase(t, SECRETO)).toThrow(/expirado/);
  });

  it('rechaza basura', () => {
    expect(() => verificarTokenSupabase('no.es.jwt', SECRETO)).toThrow(TokenInvalido);
  });
});

describe('construirServidorAdmin · guardas de arranque', () => {
  const dbFalso = { query: async () => ({ rows: [] }) };
  it('exige un secreto JWT de largo razonable', () => {
    expect(() => construirServidorAdmin({ db: dbFalso as never, jwtSecret: 'corto' }))
      .toThrow(/JWT_SECRET/);
  });
});

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('consola de administración (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    app = construirServidorAdmin({
      db, jwtSecret: SECRETO, adminsIniciales: ['arranque@donaji.mx'],
    });
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  const token = (email: string): string =>
    firmarTokenSupabase({ sub: `sub-${email}`, email }, SECRETO);
  const auth = (email: string): { authorization: string } =>
    ({ authorization: `Bearer ${token(email)}` });

  const crearAdmin = async (email: string): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO core.usuario (nombre, email, rol)
       VALUES ('Admin', $1::citext, 'administrador') RETURNING id`,
      [email],
    );
    return rows[0]!.id;
  };

  const filaUsuario = (): Record<string, unknown> => ({
    nombre: 'Operador Nuevo',
    email: `op-${Math.floor(Math.random() * 1e9)}@donaji.test`,
    rol: 'vendedor',
  });

  // -------------------------------------------------------------------------
  it('GET /salud no pide token', async () => {
    const r = await app.inject({ method: 'GET', url: '/salud' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('GET /api/yo sin token → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/yo' });
    expect(r.statusCode).toBe(401);
  });

  it('GET /api/yo con token válido pero email no admin → 403', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/yo', headers: auth('nadie@donaji.mx') });
    expect(r.statusCode).toBe(403);
  });

  it('GET /api/yo con email de la lista de arranque → 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/yo', headers: auth('arranque@donaji.mx') });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ email: 'arranque@donaji.mx', usuarioId: null, viaListaDeArranque: true });
  });

  it('GET /api/yo con un core.usuario administrador → 200 con su id', async () => {
    const id = await crearAdmin('jefa@donaji.mx');
    const r = await app.inject({ method: 'GET', url: '/api/yo', headers: auth('jefa@donaji.mx') });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ email: 'jefa@donaji.mx', usuarioId: id, viaListaDeArranque: false });
  });

  it('POST /api/config a una tabla fuera de la lista → 400', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/config/core.venta', headers: auth('arranque@donaji.mx'),
      payload: { fila: {}, modo: 'inmediato', confirmarInmediato: true },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('tabla_no_administrable');
  });

  it('POST /api/config/core.usuario escribe y publica (201)', async () => {
    await db.query(`UPDATE sync.nodo SET es_nube = true WHERE singleton`);
    const r = await app.inject({
      method: 'POST', url: '/api/config/core.usuario', headers: auth('arranque@donaji.mx'),
      payload: { fila: filaUsuario(), modo: 'ventana', zonaHoraria: 'America/Mexico_City' },
    });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.creada).toBe(true);
    expect(b.escritoPor).toBe('arranque@donaji.mx');
    expect(b.vigenciaEn).toBe('effective_from');

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.cambio_log WHERE tabla = 'core.usuario' AND fila_id = $1`,
      [b.id],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/config con modo inmediato sin confirmar → 400 escritura_invalida', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/config/core.usuario', headers: auth('arranque@donaji.mx'),
      payload: { fila: filaUsuario(), modo: 'inmediato' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('escritura_invalida');
  });

  it('POST /api/config sin token → 401', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/config/core.usuario',
      payload: { fila: filaUsuario(), modo: 'ventana' },
    });
    expect(r.statusCode).toBe(401);
  });
}, 25_000);
