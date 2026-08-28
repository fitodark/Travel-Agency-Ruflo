/**
 * Impresora, ticket y tarifas desde la consola de administración (F2b, slice 4).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import {
  configurarImpresora, configurarTicket, listarImpresoras, ticketVigente,
} from '../../src/admin/impresion.js';
import { crearTarifa, darDeBajaTarifa, listarTarifas } from '../../src/admin/tarifas.js';
import { construirServidorAdmin } from '../../src/admin/servidor.js';
import { firmarTokenSupabase } from '../../src/admin/auth-supabase.js';
import { seedRuta } from '../fleet/fixture.js';

const SECRETO = 'secreto-de-prueba-suficientemente-largo-2026';
const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;
const AHORA = new Date('2026-09-10T16:00:00.000Z');
const ahora = (): Date => AHORA;

run('consola · impresora / ticket / tarifas (PostgreSQL real)', () => {
  let db: Client;
  let agenciaId: string;
  let sucursalId: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    const ids = await db.query<{ agencia: string; sucursal: string }>(
      `SELECT (SELECT id FROM core.agencia WHERE activo ORDER BY creado_en LIMIT 1) AS agencia,
              (SELECT id FROM core.sucursal WHERE activo ORDER BY creado_en LIMIT 1) AS sucursal`,
    );
    agenciaId = ids.rows[0]!.agencia;
    sucursalId = ids.rows[0]!.sucursal;
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  // ---- impresora ------------------------------------------------------
  it('configurarImpresora crea y luego actualiza la misma fila (cambiar la IP)', async () => {
    const a = await configurarImpresora(db, {
      sucursalId, nombre: 'Enduro', transporte: 'tcp', ip: '192.168.1.50',
    }, { ahora });
    expect(a.creada).toBe(true);

    const b = await configurarImpresora(db, {
      sucursalId, nombre: 'Enduro', transporte: 'tcp', ip: '192.168.1.99',
    }, { ahora });
    expect(b.creada).toBe(false);
    expect(b.id).toBe(a.id);

    const lista = await listarImpresoras(db, sucursalId);
    expect(lista).toHaveLength(1);
    expect(lista[0]!['ip']).toBe('192.168.1.99');
  });

  it('configurarImpresora exige ip para tcp y cola para usb', async () => {
    await expect(configurarImpresora(db, {
      sucursalId, nombre: 'x', transporte: 'tcp',
    }, { ahora })).rejects.toThrow(/ip/);
    await expect(configurarImpresora(db, {
      sucursalId, nombre: 'x', transporte: 'usb',
    }, { ahora })).rejects.toThrow(/usbNombreCola/);
  });

  // ---- ticket --------------------------------------------------------
  it('configurarTicket publica una versión nueva; inmediato queda vigente ya', async () => {
    const v = await configurarTicket(db, { agenciaId, leyendaPie: 'Buen viaje' }, { ahora });
    expect(new Date(v.effectiveFrom).getTime()).toBeGreaterThan(AHORA.getTime());

    await configurarTicket(db, { agenciaId, leyendaPie: 'Gracias por viajar' }, {
      modo: 'inmediato', confirmarInmediato: true, ahora,
    });
    const vigente = await ticketVigente(db, agenciaId, AHORA);
    expect(vigente!['leyenda_pie']).toBe('Gracias por viajar');

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.config_ticket WHERE agencia_id = $1`, [agenciaId],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  // ---- tarifas -------------------------------------------------------
  it('crearTarifa fija el precio y cierra el anterior del mismo tramo', async () => {
    const fx = await seedRuta(db, { paradas: 3 });

    const t1 = await crearTarifa(db, {
      rutaId: fx.rutaId, paradaOrigenOrden: 0, paradaDestinoOrden: 2, importe: 450,
    }, { ahora });
    expect(t1.cerroAnterior).toBeNull();
    expect(new Date(t1.effectiveFrom).getTime()).toBeGreaterThan(AHORA.getTime());

    const t2 = await crearTarifa(db, {
      rutaId: fx.rutaId, paradaOrigenOrden: 0, paradaDestinoOrden: 2, importe: 500,
    }, { ahora });
    expect(t2.cerroAnterior).toBe(t1.id);

    const { rows } = await db.query<{ eu: Date | null }>(
      `SELECT effective_until AS eu FROM core.tarifa WHERE id = $1`, [t1.id],
    );
    expect(new Date(rows[0]!.eu!).getTime()).toBe(new Date(t2.effectiveFrom).getTime());
  });

  it('una tarifa nunca se cambia de forma inmediata (§3.4)', async () => {
    const fx = await seedRuta(db, { paradas: 2 });
    await expect(
      crearTarifa(db, {
        rutaId: fx.rutaId, paradaOrigenOrden: 0, paradaDestinoOrden: 1, importe: 100,
      }, { modo: 'inmediato' as 'ventana', ahora }),
    ).rejects.toThrow(/inmediata/i);
  });

  it('darDeBajaTarifa cierra el tramo', async () => {
    const fx = await seedRuta(db, { paradas: 2 });
    const t = await crearTarifa(db, {
      rutaId: fx.rutaId, paradaOrigenOrden: 0, paradaDestinoOrden: 1, importe: 200,
    }, { ahora });
    const baja = await darDeBajaTarifa(db, t.id, { ahora });
    const { rows } = await db.query<{ activo: boolean; eu: Date | null }>(
      `SELECT activo, effective_until AS eu FROM core.tarifa WHERE id = $1`, [t.id],
    );
    expect(rows[0]!.activo).toBe(false);
    expect(new Date(rows[0]!.eu!).getTime()).toBe(new Date(baja.effectiveUntil).getTime());
    expect((await listarTarifas(db, fx.rutaId)).length).toBeGreaterThanOrEqual(1);
  });
}, 30_000);

run('consola · impresora / ticket / tarifas por HTTP (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;
  let agenciaId: string;
  let sucursalId: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    const ids = await db.query<{ agencia: string; sucursal: string }>(
      `SELECT (SELECT id FROM core.agencia WHERE activo ORDER BY creado_en LIMIT 1) AS agencia,
              (SELECT id FROM core.sucursal WHERE activo ORDER BY creado_en LIMIT 1) AS sucursal`,
    );
    agenciaId = ids.rows[0]!.agencia;
    sucursalId = ids.rows[0]!.sucursal;
    app = construirServidorAdmin({ db, jwtSecret: SECRETO, adminsIniciales: ['jefe@donaji.mx'], ahora });
  });
  afterEach(async () => { await app.close(); await db.query('ROLLBACK'); });

  const auth = { authorization: `Bearer ${firmarTokenSupabase({ sub: 's', email: 'jefe@donaji.mx' }, SECRETO, ahora)}` };

  it('impresora, ticket y tarifa por HTTP', async () => {
    const imp = await app.inject({
      method: 'POST', url: '/api/impresoras', headers: auth,
      payload: { sucursalId, nombre: 'Enduro', transporte: 'tcp', ip: '10.0.0.5' },
    });
    expect(imp.statusCode, imp.body).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/api/impresoras?sucursalId=${sucursalId}`, headers: auth })).statusCode).toBe(200);

    const tk = await app.inject({
      method: 'POST', url: '/api/ticket', headers: auth,
      payload: { agenciaId, leyendaPie: 'X', modo: 'inmediato', confirmarInmediato: true },
    });
    expect(tk.statusCode, tk.body).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/api/ticket?agenciaId=${agenciaId}`, headers: auth })).json().leyenda_pie).toBe('X');

    const fx = await seedRuta(db, { paradas: 2 });
    const tf = await app.inject({
      method: 'POST', url: '/api/tarifas', headers: auth,
      payload: { rutaId: fx.rutaId, paradaOrigenOrden: 0, paradaDestinoOrden: 1, importe: 320 },
    });
    expect(tf.statusCode, tf.body).toBe(201);
    expect((await app.inject({
      method: 'POST', url: `/api/tarifas/${tf.json().id}/baja`, headers: auth, payload: {},
    })).statusCode).toBe(200);
  });

  it('POST /api/tarifas con modo inmediato → 400', async () => {
    const fx = await seedRuta(db, { paradas: 2 });
    const r = await app.inject({
      method: 'POST', url: '/api/tarifas', headers: auth,
      payload: { rutaId: fx.rutaId, paradaOrigenOrden: 0, paradaDestinoOrden: 1, importe: 1, modo: 'inmediato' },
    });
    expect(r.statusCode).toBe(400); // el schema rechaza el enum
  });

  it('sin token → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/impresoras' })).statusCode).toBe(401);
  });
}, 30_000);
