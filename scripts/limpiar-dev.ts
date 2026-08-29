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
 *  - Las SESIONES e INTENTOS de login (`auth_local.sesion`, `auth_local.intento`).
 *    Un login manual —`npm run seed:qa` + la SPA— deja sesiones abiertas que
 *    `tests/config/aplicador.test.ts` cuenta al hacer su pasada global.
 *
 * NO toca la configuración normal de dev (agencia "Donaji (dev)", sucursal `D`,
 * `admin@donaji.local`) ni los datos de negocio con id de prefijo real.
 *
 * Consejo: corre `npm run sync` contra una base SEPARADA de la de la suite.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection, targetFromArgs } from '../src/db/connection.js';

// `npm test` corre esto como `pretest`. En un entorno sin base local (CI que solo
// hace typecheck, por ejemplo) no hay nada que limpiar y no debe romper la suite.
const ENV_POR_TARGET: Record<string, string> = { local: 'LOCAL_DATABASE_URL', nube: 'DATABASE_URL' };

const PREFIJO = '01900000-%';

const POC: Array<[string, string]> = [
  ['asiento_lease', `DELETE FROM core.asiento_lease WHERE salida_id::text LIKE $1`],
  ['asiento_ocupacion', `DELETE FROM core.asiento_ocupacion WHERE salida_id::text LIKE $1`],
  ['boleto', `DELETE FROM core.boleto WHERE salida_id::text LIKE $1`],
  ['venta', `DELETE FROM core.venta WHERE salida_id::text LIKE $1`],
  ['cupo_offline', `DELETE FROM core.cupo_offline WHERE salida_id::text LIKE $1`],
  ['salida_parada', `DELETE FROM core.salida_parada WHERE salida_id::text LIKE $1 OR salida_id IN (SELECT id FROM core.salida WHERE horario_id IN (SELECT id FROM core.horario WHERE id::text LIKE $1))`],
  ['salida', `DELETE FROM core.salida WHERE id::text LIKE $1 OR horario_id IN (SELECT id FROM core.horario WHERE id::text LIKE $1)`],
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
  // El log de bajada: si esto queda, el pull vuelve a traer las filas de la PoC
  // a cada nodo. En la nube hay que borrarlo; en local está vacío.
  ['sync.cambio_log', `DELETE FROM sync.cambio_log WHERE fila_id::text LIKE $1 OR payload->>'id' LIKE $1`],
];

const SYNC: Array<[string, string]> = [
  ['auth_local.sesion', `DELETE FROM auth_local.sesion`],
  ['auth_local.intento', `DELETE FROM auth_local.intento`],
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
  if (!process.env[ENV_POR_TARGET[target]!]) {
    console.log(`Sin ${ENV_POR_TARGET[target]}: nada que limpiar en "${target}", se omite.`);
    return;
  }
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
    // El reset del runtime de sync SOLO tiene sentido en una base local de dev.
    // En la nube, `sync.lote_recibido` / `sync.cursor` / `sync.hlc_estado` son
    // estado real que no se debe tocar; ahí solo se purgan las filas de la PoC.
    if (target === 'local') {
      for (const [nombre, sql] of SYNC) {
        const r = await c.query(sql);
        if (r.rowCount) console.log(`  sync ${nombre.padEnd(20)} ${sql.startsWith('DELETE') ? `-${r.rowCount}` : 'reset'}`);
      }
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
