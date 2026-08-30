/**
 * Higiene del `sync.cambio_log` de la NUBE: borra las entradas huérfanas.
 *
 *   npm run sanear:nube                 # informe (dry-run)
 *   npm run sanear:nube -- --aplicar    # borra de verdad
 *
 * POR QUÉ: `sync.cambio_log` es append-only. En la Supabase compartida acumuló
 * miles de entradas de la PoC y de la suite de caos (`tests/sync/`, prefijo de id
 * `019caa5f-`): esas pruebas crean datos en la nube, publican por `trg_cambio_log`
 * y luego BORRAN las filas de `core.*` —pero NO las del `cambio_log`—. Cada
 * `repartir_cupo_offline` genera además ids nuevos, así que re-correr la suite
 * multiplica los huérfanos.
 *
 * Un nodo que hace bootstrap los ignora (arranca con el cursor en el máximo),
 * pero un nodo con un cursor viejo se atasca entrada por entrada: cada huérfano
 * rebota por unicidad o por FK y el motor lo salta recién tras la gracia de 10
 * min. Con cientos de huérfanos, el pull tarda días.
 *
 * QUÉ BORRA: por cada tabla que aparezca en `sync.cambio_log` y tenga columna
 * `id`, las entradas cuyo `fila_id` YA NO EXISTE como fila viva. Una entrada así
 * no puede aplicarse nunca y su ausencia no pierde nada: el estado bueno está en
 * la fila viva y en las entradas más recientes. NO toca entradas de filas que
 * siguen existiendo.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../src/db/connection.js';

async function main(): Promise<void> {
  const aplicar = process.argv.includes('--aplicar');
  const conn = resolveConnection('nube');
  const c = new Client(conn.config);
  await c.connect();
  console.log(`${aplicar ? 'Saneando' : 'Analizando'} sync.cambio_log en la nube (${conn.describe})`);

  const { rows: nube } = await c.query<{ es_nube: boolean }>(`SELECT es_nube FROM sync.nodo WHERE singleton`);
  if (!nube[0]?.es_nube) {
    throw new Error('sync.nodo.es_nube no es true: este comando solo corre contra la nube.');
  }

  const total0 = await c.query<{ n: string }>(`SELECT count(*) n FROM sync.cambio_log`);
  console.log(`  entradas totales: ${total0.rows[0]!.n}`);

  // Todas las tablas que aparecen en el log Y existen Y tienen columna `id`.
  const { rows: tablas } = await c.query<{ tabla: string }>(
    `SELECT DISTINCT cl.tabla
       FROM sync.cambio_log cl
       JOIN information_schema.columns col
         ON col.table_schema = split_part(cl.tabla, '.', 1)
        AND col.table_name   = split_part(cl.tabla, '.', 2)
        AND col.column_name  = 'id'
      ORDER BY 1`,
  );

  let borrables = 0;
  for (const { tabla } of tablas) {
    const sql = `${aplicar ? 'DELETE' : 'SELECT count(*)'} FROM sync.cambio_log cl
       WHERE cl.tabla = $1
         AND NOT EXISTS (SELECT 1 FROM ${tabla} t WHERE t.id = cl.fila_id)`;
    const r = await c.query(sql, [tabla]);
    const n = aplicar ? (r.rowCount ?? 0) : Number((r.rows[0] as { count: string } | undefined)?.count ?? 0);
    if (n > 0) {
      borrables += n;
      console.log(`  ${tabla.padEnd(30)} ${aplicar ? 'borradas' : 'huérfanas'}: ${n}`);
    }
  }

  console.log(`\n  ${aplicar ? 'Borradas' : 'Se borrarían'} ${borrables} entradas huérfanas.`);
  if (!aplicar && borrables > 0) console.log('  Corré de nuevo con  --aplicar  para borrarlas.');
  await c.end();
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
