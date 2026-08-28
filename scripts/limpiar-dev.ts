/**
 * Devuelve una base de desarrollo a un estado limpio para la suite de pruebas.
 *
 *   npx tsx scripts/limpiar-dev.ts               # local (default)
 *   npx tsx scripts/limpiar-dev.ts --target nube
 *
 * Qué borra:
 *  - Filas de la PoC de sincronización (prefijo de id `01900000-`), que un
 *    `pull` manual contra la nube trae a la base de dev y rompen las pruebas por
 *    colisión de `sucursal.codigo`.
 *  - El ESTADO DE RUNTIME del motor de sync: `sync.outbox` a medias,
 *    `sync.excepcion`, `sync.salud`, `sync.hlc_estado`, `sync.cursor`,
 *    `sync.lote_recibido`, `sync.checksum_bloque`, y `sync.config_aplicado`.
 *    Se ensucia cada vez que corres `npm run sync` o un push/pull a mano contra
 *    la misma base que usa la suite.
 *
 * NO toca la configuración normal de dev (agencia "Donaji (dev)", sucursal `D`,
 * `admin@donaji.local`) ni los datos de negocio con id de prefijo real.
 *
 * Consejo: corre `npm run sync` contra una base SEPARADA de la de la suite.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection, targetFromArgs } from '../src/db/connection.js';

const PREFIJO = '01900000-%';

const POC: Array<[string, string]> = [
  ['horario_parada', `DELETE FROM core.horario_parada WHERE horario_id IN (SELECT id FROM core.horario WHERE id::text LIKE $1)`],
  ['horario', `DELETE FROM core.horario WHERE id::text LIKE $1`],
  ['ruta_parada', `DELETE FROM core.ruta_parada WHERE ruta_id IN (SELECT id FROM core.ruta WHERE id::text LIKE $1)`],
  ['tarifa', `DELETE FROM core.tarifa WHERE ruta_id IN (SELECT id FROM core.ruta WHERE id::text LIKE $1)`],
  ['ruta', `DELETE FROM core.ruta WHERE id::text LIKE $1`],
  ['usuario_sucursal', `DELETE FROM core.usuario_sucursal WHERE usuario_id::text LIKE $1 OR sucursal_id::text LIKE $1`],
  ['credencial', `DELETE FROM auth_local.credencial WHERE usuario_id::text LIKE $1`],
  ['sesion', `DELETE FROM auth_local.sesion WHERE usuario_id::text LIKE $1`],
  ['conductor', `DELETE FROM core.conductor WHERE id::text LIKE $1`],
  ['usuario', `DELETE FROM core.usuario WHERE id::text LIKE $1`],
  ['folio_secuencia', `DELETE FROM core.folio_secuencia WHERE sucursal_id::text LIKE $1`],
  ['sucursal', `DELETE FROM core.sucursal WHERE id::text LIKE $1`],
  ['agencia', `DELETE FROM core.agencia WHERE id::text LIKE $1`],
];

const SYNC: Array<[string, string]> = [
  ['sync.outbox', `DELETE FROM sync.outbox WHERE estado IN ('rechazado', 'enviado')`],
  ['sync.excepcion', `TRUNCATE sync.excepcion`],
  ['sync.salud', `TRUNCATE sync.salud`],
  ['sync.checksum_bloque', `TRUNCATE sync.checksum_bloque`],
  ['sync.cursor', `TRUNCATE sync.cursor`],
  ['sync.lote_recibido', `TRUNCATE sync.lote_recibido`],
  ['sync.hlc_estado', `UPDATE sync.hlc_estado SET ultimo_ts = '-infinity', ultimo_cnt = 0 WHERE singleton`],
  ['sync.config_aplicado', `UPDATE sync.config_aplicado SET ultima_pasada = NULL, ultima_epoca = NULL, sesiones_cerradas_total = 0 WHERE singleton`],
];

async function main(): Promise<void> {
  const target = targetFromArgs(process.argv.slice(2), 'local');
  const conn = resolveConnection(target);
  const c = new Client(conn.config);
  await c.connect();
  console.log(`Limpiando ${target} (${conn.describe})`);

  try {
    await c.query('BEGIN');
    for (const [nombre, sql] of POC) {
      const r = await c.query(sql, [PREFIJO]);
      if (r.rowCount) console.log(`  poc  ${nombre.padEnd(16)} -${r.rowCount}`);
    }
    for (const [nombre, sql] of SYNC) {
      const r = await c.query(sql);
      if (r.rowCount) console.log(`  sync ${nombre.padEnd(20)} ${sql.startsWith('DELETE') ? `-${r.rowCount}` : 'reset'}`);
    }
    await c.query('COMMIT');
    console.log('Listo.');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    await c.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
