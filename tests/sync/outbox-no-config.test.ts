/**
 * El outbox no encola tablas de configuración (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.2
 *
 * Regresión de 0032: un seed de dev escribe `core.tipo_unidad` (clase A) y el
 * trigger de outbox lo encolaba hacia arriba, chocando en cada push con la
 * versión de la nube.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('outbox · la configuración no sube (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const enOutbox = async (tabla: string): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.outbox WHERE tabla = $1`, [tabla],
    );
    return Number(rows[0]!.n);
  };

  it('`sync.es_tabla_config` distingue clase A de clase B', async () => {
    const { rows } = await db.query<{ tu: boolean; cli: boolean; ven: boolean }>(
      `SELECT sync.es_tabla_config('core.tipo_unidad') AS tu,
              sync.es_tabla_config('core.cliente')     AS cli,
              sync.es_tabla_config('core.venta')       AS ven`,
    );
    expect(rows[0]).toEqual({ tu: true, cli: false, ven: false });
  });

  it('escribir una tabla de configuración NO deja fila en el outbox', async () => {
    const antes = await enOutbox('core.tipo_unidad');
    await db.query(
      `INSERT INTO core.tipo_unidad (clave, nombre, num_asientos, mapa)
       VALUES ('TEST-' || floor(random()*1e6)::int, 'Test', 1,
               '{"version":1,"asientos":[{"num":1,"fila":0,"col":0,"vendible":true}],
                 "bloques":[{"clave":"X0","etiqueta":"f","asientos":[1]}]}'::jsonb)`,
    );
    expect(await enOutbox('core.tipo_unidad')).toBe(antes);
  });

  it('escribir una tabla de clase B SÍ deja fila en el outbox', async () => {
    const antes = await enOutbox('core.cliente');
    await db.query(
      `INSERT INTO core.cliente (nombre, telefono) VALUES ('Cliente B', '953 000 0000')`,
    );
    expect(await enOutbox('core.cliente')).toBe(antes + 1);
  });
});
