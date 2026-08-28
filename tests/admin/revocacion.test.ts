/**
 * Generación de códigos de revocación desde la consola (F2b, slice 3, capa 3).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { generarCodigo } from '../../src/auth/hotp.js';
import { generarCodigoRevocacion } from '../../src/admin/revocacion.js';
import { crearSucursal } from '../../src/admin/sucursales.js';
import { crearUsuario } from '../../src/admin/usuarios.js';
import { construirServidorAdmin } from '../../src/admin/servidor.js';
import { firmarTokenSupabase } from '../../src/admin/auth-supabase.js';

const SECRETO = 'secreto-de-prueba-suficientemente-largo-2026';
const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;
const AHORA = new Date('2026-09-10T16:00:00.000Z');
const ahora = (): Date => AHORA;

run('consola · códigos de revocación (PostgreSQL real)', () => {
  let db: Client;
  let agenciaId: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.agencia WHERE activo ORDER BY creado_en LIMIT 1`,
    );
    agenciaId = rows[0]!.id;
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const semillaDe = async (sucursalId: string): Promise<Buffer> => {
    const { rows } = await db.query<{ semilla: Buffer }>(
      `SELECT semilla FROM auth_local.revocacion_hotp WHERE sucursal_id = $1`, [sucursalId],
    );
    return rows[0]!.semilla;
  };

  it('genera un código verificable contra la semilla y avanza el contador', async () => {
    const suc = await crearSucursal(db, {
      agenciaId, nombre: 'S', direccionCompleta: 'x', telefonoPrincipal: 'x', codigo: 'Z',
    }, { modo: 'inmediato', confirmarInmediato: true, ahora });
    const usr = await crearUsuario(db, {
      nombre: 'U', email: `rv-${Math.floor(Math.random() * 1e9)}@donaji.test`, rol: 'vendedor',
    }, { modo: 'inmediato', confirmarInmediato: true, ahora });

    const primero = await generarCodigoRevocacion(db, { sucursalId: suc.id, usuarioId: usr.id, ahora });
    expect(primero.contador).toBe(0);
    expect(primero.codigo).toBe(generarCodigo(await semillaDe(suc.id), usr.id, 0));

    const { rows } = await db.query<{ u: string }>(
      `SELECT ultimo_usado AS u FROM auth_local.revocacion_hotp WHERE sucursal_id = $1`, [suc.id],
    );
    expect(Number(rows[0]!.u)).toBe(0);

    const segundo = await generarCodigoRevocacion(db, { sucursalId: suc.id, usuarioId: usr.id, ahora });
    expect(segundo.contador).toBe(1);
    expect(segundo.codigo).not.toBe(primero.codigo);
  });

  it('lanza si la sucursal no tiene semilla', async () => {
    await expect(
      generarCodigoRevocacion(db, {
        sucursalId: '00000000-0000-7000-8000-000000000000', usuarioId: agenciaId, ahora,
      }),
    ).rejects.toThrow(/semilla/i);
  });

  it('POST /api/usuarios/:id/codigo-revocacion devuelve el código', async () => {
    const app: FastifyInstance = construirServidorAdmin({
      db, jwtSecret: SECRETO, adminsIniciales: ['jefe@donaji.mx'], ahora,
    });
    try {
      const suc = await crearSucursal(db, {
        agenciaId, nombre: 'S', direccionCompleta: 'x', telefonoPrincipal: 'x', codigo: 'Y',
      }, { modo: 'inmediato', confirmarInmediato: true, ahora });
      const usr = await crearUsuario(db, {
        nombre: 'U', email: `rvh-${Math.floor(Math.random() * 1e9)}@donaji.test`, rol: 'vendedor',
      }, { modo: 'inmediato', confirmarInmediato: true, ahora });

      const r = await app.inject({
        method: 'POST', url: `/api/usuarios/${usr.id}/codigo-revocacion`,
        headers: { authorization: `Bearer ${firmarTokenSupabase({ sub: 's', email: 'jefe@donaji.mx' }, SECRETO, ahora)}` },
        payload: { sucursalId: suc.id },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().codigo).toMatch(/^\d{8}$/);
    } finally {
      await app.close();
    }
  });
}, 30_000);
