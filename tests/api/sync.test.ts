/**
 * Rutas del estado del motor de sincronización (HTTP, contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/blueprint.md §4.1
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { seedAuth } from '../auth/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-01T12:00:00.000Z');
const ahora = (): Date => AHORA;

run('API · /sync (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    // `/sync/estado` y `/sync/excepciones` leen `sync.excepcion` y `sync.salud`
    // sin filtrar por nodo, así que la prueba tiene que partir de tablas vacías.
    // No basta con el `pretest` (`scripts/limpiar-dev.ts`): se lo salta correr un
    // solo archivo con `vitest`, y `npm run sync` contra la misma base las
    // reensucia a media suite. El `DELETE` es local a esta transacción y se
    // revierte en el `afterEach`; se usa `DELETE` y no `TRUNCATE` a propósito —
    // el `ACCESS EXCLUSIVE` de `TRUNCATE`, en paralelo con el lock de
    // `sync.hlc_estado`, interbloquea con otros archivos.
    await db.query('DELETE FROM sync.excepcion');
    await db.query('DELETE FROM sync.salud');
    app = await abrirApp(db, ahora);
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  const auth = async () => {
    const fx = await seedAuth(db);
    const token = await tokenDe(db, fx.email, fx.sucursalAId, ahora);
    return { fx, token };
  };

  it('GET /sync/estado exige sesión', async () => {
    const r = await app.inject({ method: 'GET', url: '/sync/estado' });
    expect(r.statusCode).toBe(401);
  });

  it('GET /sync/estado devuelve el snapshot del motor', async () => {
    const { fx, token } = await auth();
    await db.query(`UPDATE sync.nodo SET sucursal_id = $1 WHERE singleton`, [fx.sucursalAId]);
    await db.query(`DELETE FROM sync.outbox`);
    await db.query(
      `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa, deriva_reloj_seg)
       VALUES (sync.sucursal_local(), $1, 4)`,
      [new Date(AHORA.getTime() - 20 * 60 * 1000)],
    );
    await db.query(
      `INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt, estado, intentos)
       VALUES ('core.venta', core.uuid_v7(), '{}'::jsonb, now(), 0, 'pendiente', 0),
              ('core.venta', core.uuid_v7(), '{}'::jsonb, now(), 0, 'pendiente', 0),
              ('core.venta', core.uuid_v7(), '{}'::jsonb, now(), 0, 'rechazado', 2)`,
    );

    const r = await app.inject({
      method: 'GET', url: '/sync/estado', headers: bearer(token),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.sucursalId).toBe(fx.sucursalAId);
    expect(b.outboxPendiente).toBe(2);
    expect(b.outboxAtascado, 'la rechazada').toBe(1);
    expect(b.derivaRelojSeg).toBe(4);
    expect(b.degradado, 'sincronizó hace 20 min').toBe(false);
    expect(b.excepcionesAbiertas).toEqual({ critica: 0, alta: 0, media: 0, baja: 0 });
    expect(b.versionEsquema).toMatch(/^\d{4}_/);
  });

  it('GET /sync/estado marca `degradado` si pasó el umbral', async () => {
    const { token } = await auth();
    await db.query(
      `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa)
       VALUES (sync.sucursal_local(), $1)`,
      [new Date(AHORA.getTime() - 80 * 3_600_000)],
    );
    const r = await app.inject({
      method: 'GET', url: '/sync/estado', headers: bearer(token),
    });
    expect(r.json().degradado).toBe(true);
  });

  it('GET /sync/excepciones lista las abiertas, la crítica primero', async () => {
    const { token } = await auth();
    await db.query(
      `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, estado)
       VALUES ('deriva_reloj', 'alta',    sync.sucursal_local(), 'abierta'),
              ('sobreventa',   'critica', sync.sucursal_local(), 'abierta'),
              ('respaldo_vencido', 'baja', sync.sucursal_local(), 'resuelta')`,
    );
    const r = await app.inject({
      method: 'GET', url: '/sync/excepciones', headers: bearer(token),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toHaveLength(2);
    expect(b[0].severidad).toBe('critica');
    expect(b[0].tipo).toBe('sobreventa');
  });
});
