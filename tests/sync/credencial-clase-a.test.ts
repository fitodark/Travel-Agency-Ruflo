/**
 * `auth_local.credencial` se replica como clase A (nube → nodo).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.2
 *                  docs/architecture/04-riesgos-roadmap.md §F2b (slice 1)
 *
 * Migración 0034. El hash de contraseña se calcula en la nube y baja replicado
 * como cualquier dato de configuración; el nodo nunca lo escribe. Antes de 0034
 * la tabla no tenía columnas de sync, ni trigger de publicación, ni pasaba por
 * `sync.es_tabla_ingerible` (que solo admitía `core`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { CLASE_POR_TABLA, claseDe } from '../../src/sync/clases.js';
import { ORDEN_TOPOLOGICO } from '../../src/sync/bootstrap.js';

describe('credencial · clase A (metadatos, sin base)', () => {
  it('está declarada clase A en el mapa de clases', () => {
    expect(CLASE_POR_TABLA['auth_local.credencial']).toBe('A');
    expect(claseDe('auth_local.credencial')).toBe('A');
  });

  it('está en el orden de bootstrap, justo después del usuario', () => {
    const i = ORDEN_TOPOLOGICO.indexOf('auth_local.credencial');
    expect(i).toBeGreaterThan(-1);
    expect(ORDEN_TOPOLOGICO.indexOf('core.usuario')).toBeLessThan(i);
    expect(ORDEN_TOPOLOGICO.indexOf('core.unidad')).toBeGreaterThan(i);
  });
});

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('credencial · clase A (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const crearUsuario = async (): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO core.usuario (nombre, email, rol)
       VALUES ('Cred Test', 'cred-' || floor(random()*1e9)::int || '@donaji.test', 'vendedor')
       RETURNING id`,
    );
    return rows[0]!.id;
  };

  /** Inserta una credencial y devuelve su payload completo, como lo mandaría la nube. */
  const semilla = async (usuarioId: string, hash = 'argon2id$hash$inicial'): Promise<Record<string, unknown>> => {
    const { rows } = await db.query<{ p: Record<string, unknown> }>(
      `INSERT INTO auth_local.credencial (usuario_id, hash_password, debe_cambiar)
       VALUES ($1, $2, false)
       RETURNING to_jsonb(auth_local.credencial.*) AS p`,
      [usuarioId, hash],
    );
    return rows[0]!.p;
  };

  it('`es_tabla_ingerible` admite credencial y sigue rechazando las demás de auth_local', async () => {
    const { rows } = await db.query<{ cred: boolean; ses: boolean; hotp: boolean; usr: boolean }>(
      `SELECT sync.es_tabla_ingerible('auth_local.credencial')    AS cred,
              sync.es_tabla_ingerible('auth_local.sesion')        AS ses,
              sync.es_tabla_ingerible('auth_local.revocacion_hotp') AS hotp,
              sync.es_tabla_ingerible('core.usuario')             AS usr`,
    );
    expect(rows[0]).toEqual({ cred: true, ses: false, hotp: false, usr: true });
  });

  it('`es_tabla_config` la reconoce como clase A (baja, no sube)', async () => {
    const { rows } = await db.query<{ cred: boolean }>(
      `SELECT sync.es_tabla_config('auth_local.credencial') AS cred`,
    );
    expect(rows[0]!.cred).toBe(true);
  });

  it('deriva `id` de `usuario_id` al insertar', async () => {
    const usuarioId = await crearUsuario();
    const p = await semilla(usuarioId);
    expect(p['id']).toBe(usuarioId);
  });

  it('escribir una credencial NO deja fila en el outbox (la config no sube)', async () => {
    const usuarioId = await crearUsuario();
    const { rows: antes } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.outbox WHERE tabla = 'auth_local.credencial'`,
    );
    await semilla(usuarioId);
    const { rows: despues } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.outbox WHERE tabla = 'auth_local.credencial'`,
    );
    expect(Number(despues[0]!.n)).toBe(Number(antes[0]!.n));
  });

  it('la ingesta aplica una credencial que "baja de la nube"', async () => {
    const usuarioId = await crearUsuario();
    const payload = await semilla(usuarioId, 'argon2id$hash$nube');
    // Se borra la fila local y se re-ingiere el payload, como haría el pull.
    await db.query(`DELETE FROM auth_local.credencial WHERE usuario_id = $1`, [usuarioId]);

    const { rows: res } = await db.query<{ estado: string; motivo: string | null }>(
      `SELECT estado, motivo FROM sync.ingest_fila('auth_local.credencial', $1::uuid, $2::jsonb)`,
      [usuarioId, JSON.stringify(payload)],
    );
    expect(res[0]!.estado, res[0]!.motivo ?? '').toBe('aceptada');

    const { rows: fila } = await db.query<{ hash_password: string; id: string }>(
      `SELECT hash_password, id FROM auth_local.credencial WHERE usuario_id = $1`, [usuarioId],
    );
    expect(fila[0]!.hash_password).toBe('argon2id$hash$nube');
    expect(fila[0]!.id).toBe(usuarioId);
  });

  it('una versión más nueva del hash gana; una más vieja se ignora', async () => {
    const usuarioId = await crearUsuario();
    const base = await semilla(usuarioId, 'hash$v1');

    const nuevo = {
      ...base,
      hash_password: 'hash$v2',
      hlc_cnt: Number(base['hlc_cnt']) + 1,
      version: Number(base['version']) + 1,
    };
    const viejo = {
      ...base,
      hash_password: 'hash$v0',
      hlc_ts: '1999-01-01T00:00:00Z',
    };

    const aplicar = async (p: Record<string, unknown>): Promise<string> => {
      const { rows } = await db.query<{ estado: string }>(
        `SELECT estado FROM sync.ingest_fila('auth_local.credencial', $1::uuid, $2::jsonb)`,
        [usuarioId, JSON.stringify(p)],
      );
      return rows[0]!.estado;
    };

    expect(await aplicar(nuevo)).toBe('aceptada');
    expect(await aplicar(viejo)).toBe('ignorada_hlc');

    const { rows } = await db.query<{ h: string }>(
      `SELECT hash_password AS h FROM auth_local.credencial WHERE usuario_id = $1`, [usuarioId],
    );
    expect(rows[0]!.h).toBe('hash$v2');
  });
});
