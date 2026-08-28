/**
 * La ingesta ignora las columnas GENERATED ALWAYS (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.1
 *
 * Regresión de 0031: `core.cliente.telefono_normalizado` es una columna
 * generada; el trigger de outbox manda la fila completa, así que la ingesta la
 * recibía y reventaba con `428C9: cannot insert a non-DEFAULT value into
 * column`. Ningún cliente podía replicar a la nube.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('ingesta · columnas generadas (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  it('acepta un `core.cliente` cuyo payload incluye `telefono_normalizado` (generada)', async () => {
    // Un cliente real, con su fila completa tal como la manda el outbox.
    const { rows: ins } = await db.query<{ p: Record<string, unknown>; id: string }>(
      `INSERT INTO core.cliente (nombre, telefono, email)
       VALUES ('Cliente Sync', '953-111-22-33', 'cs@donaji.test')
       RETURNING (to_jsonb(core.cliente.*)) AS p, id`,
    );
    const payload = ins[0]!.p;
    const id = ins[0]!.id;
    expect(payload['telefono_normalizado'], 'el payload trae la columna generada').toBe('9531112233');

    // Se borra la fila local y se re-ingiere el payload, como haría la nube.
    await db.query(`DELETE FROM core.cliente WHERE id = $1`, [id]);

    // Avanza el reloj del payload para ejercitar el camino de aplicación.
    const conFuturo = {
      ...payload,
      hlc_cnt: Number(payload['hlc_cnt']) + 1,
      version: Number(payload['version']) + 1,
    };

    const { rows: res } = await db.query<{ estado: string; motivo: string | null }>(
      `SELECT estado, motivo FROM sync.ingest_fila('core.cliente', $1::uuid, $2::jsonb)`,
      [id, JSON.stringify(conFuturo)],
    );
    expect(res[0]!.estado, res[0]!.motivo ?? '').toBe('aceptada');

    const { rows: fila } = await db.query<{ nombre: string; norm: string }>(
      `SELECT nombre, telefono_normalizado AS norm FROM core.cliente WHERE id = $1`,
      [id],
    );
    expect(fila[0]!.nombre).toBe('Cliente Sync');
    // La nube la recalcula sola desde `telefono`.
    expect(fila[0]!.norm).toBe('9531112233');
  });

  it('un payload que solo trae la columna generada se rechaza como "sin columnas conocidas"', async () => {
    const { rows } = await db.query<{ estado: string; motivo: string | null }>(
      `SELECT estado, motivo FROM sync.ingest_fila(
         'core.cliente', core.uuid_v7(),
         jsonb_build_object('telefono_normalizado', '123'))`,
    );
    expect(rows[0]!.estado).toBe('rechazada');
    expect(rows[0]!.motivo).toMatch(/ninguna columna conocida/i);
  });
});
