/**
 * Borra el escenario de QA que siembra `sembrar-qa.ts` — de la NUBE y de LOCAL.
 *
 *   npm run limpiar:qa                 # nube + local (lo que esté configurado)
 *   npm run limpiar:qa -- --target nube
 *
 * Qué borra:
 *  - Las 3 sucursales de prueba (códigos 1, 2, 3) y su rastro (folio_secuencia,
 *    revocacion_hotp).
 *  - Los 5 usuarios de prueba (gerente@, vendedor.oax@, vendedor.tux@, multi@,
 *    sin.sucursal@donaji.local) con sus credenciales, sesiones y asignaciones.
 *  - En la NUBE: además las filas de `sync.cambio_log` de esas entidades, para que
 *    un pull no las vuelva a bajar.
 *
 * Qué NO toca: `admin@donaji.local` (lo comparte `sembrar-admin.ts`); solo se
 * quitan sus asignaciones a las sucursales de prueba (al borrar la sucursal).
 *
 * Un nodo que ya había bajado los datos y no corre este limpiado contra su base
 * local se queda con residuo: córrelo también ahí (es el comportamiento por
 * defecto) o vuelve a hacer bootstrap.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../src/db/connection.js';

const CODIGOS = ['1', '2', '3'];
const EMAILS = [
  'gerente@donaji.local',
  'vendedor.oax@donaji.local',
  'vendedor.tux@donaji.local',
  'multi@donaji.local',
  'sin.sucursal@donaji.local',
];

async function limpiar(c: Client, esNube: boolean): Promise<void> {
  await c.query('BEGIN');
  try {
    const { rows: sucs } = await c.query<{ id: string }>(
      `SELECT id FROM core.sucursal WHERE codigo = ANY($1)`, [CODIGOS],
    );
    const { rows: usrs } = await c.query<{ id: string }>(
      `SELECT id FROM core.usuario WHERE email = ANY($1::citext[])`, [EMAILS],
    );
    const sucIds = sucs.map((r) => r.id);
    const usrIds = usrs.map((r) => r.id);
    const todos = [...sucIds, ...usrIds];

    const pasos: Array<[string, string, unknown[]]> = [
      ['auth_local.sesion',              `DELETE FROM auth_local.sesion WHERE usuario_id = ANY($1::uuid[])`, [usrIds]],
      ['auth_local.revocacion_aplicada', `DELETE FROM auth_local.revocacion_aplicada WHERE usuario_id = ANY($1::uuid[])`, [usrIds]],
      ['auth_local.credencial',          `DELETE FROM auth_local.credencial WHERE usuario_id = ANY($1::uuid[])`, [usrIds]],
      ['auth_local.intento',             `DELETE FROM auth_local.intento WHERE email = ANY($1::citext[])`, [EMAILS]],
      ['core.usuario_sucursal',          `DELETE FROM core.usuario_sucursal WHERE usuario_id = ANY($1::uuid[]) OR sucursal_id = ANY($2::uuid[])`, [usrIds, sucIds]],
      ['auth_local.revocacion_hotp',     `DELETE FROM auth_local.revocacion_hotp WHERE sucursal_id = ANY($1::uuid[])`, [sucIds]],
      ['core.folio_secuencia',           `DELETE FROM core.folio_secuencia WHERE sucursal_id = ANY($1::uuid[])`, [sucIds]],
      ['core.usuario',                   `DELETE FROM core.usuario WHERE id = ANY($1::uuid[])`, [usrIds]],
      ['core.sucursal',                  `DELETE FROM core.sucursal WHERE id = ANY($1::uuid[])`, [sucIds]],
    ];
    for (const [nombre, sql, params] of pasos) {
      const r = await c.query(sql, params);
      if (r.rowCount) console.log(`  ${nombre.padEnd(30)} -${r.rowCount}`);
    }

    if (esNube && todos.length > 0) {
      const r = await c.query(
        `DELETE FROM sync.cambio_log WHERE fila_id = ANY($1::uuid[])`, [todos],
      );
      if (r.rowCount) console.log(`  sync.cambio_log                 -${r.rowCount}`);
    }

    // El nodo local deja de "ser" una de las sucursales borradas.
    await c.query(
      `UPDATE sync.nodo SET sucursal_id = NULL
        WHERE singleton AND sucursal_id = ANY($1::uuid[])`, [sucIds],
    );

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => { /* ya revertida */ });
    throw err;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--target');
  const explicit = i >= 0 ? args[i + 1] : undefined;
  const targets: ('local' | 'nube')[] = explicit === 'local' ? ['local']
    : explicit === 'nube' ? ['nube']
    : ['nube', 'local'];

  for (const t of targets) {
    const env = t === 'local' ? 'LOCAL_DATABASE_URL' : 'DATABASE_URL';
    if (!process.env[env]) {
      console.log(`Sin ${env}: se omite "${t}".`);
      continue;
    }
    const conn = resolveConnection(t);
    console.log(`Limpiando QA en ${t} (${conn.describe})`);
    const c = new Client(conn.config);
    await c.connect();
    try {
      await limpiar(c, t === 'nube');
    } finally {
      await c.end();
    }
  }
  console.log('\nListo.');
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
