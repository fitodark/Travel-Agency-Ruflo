/**
 * Higiene del `sync.cambio_log` de la NUBE: borra las entradas huérfanas.
 *
 *   npm run sanear:nube                 # informe (dry-run)
 *   npm run sanear:nube -- --aplicar    # borra de verdad
 *
 * POR QUÉ: `sync.cambio_log` es append-only y en la Supabase compartida acumuló
 * ~1200 entradas de la PoC/dev. Muchas referencian ids que la nube borró o
 * re-clavó después (la re-clave determinista de `tipo_unidad` en 0039, sucursales
 * de prueba eliminadas, salidas viejas). Un nodo que hace bootstrap las ignora
 * (arranca con el cursor en el máximo), pero un nodo que arrastra un cursor
 * viejo se atasca entrada por entrada.
 *
 * QUÉ BORRA: por cada tabla de clase A, las filas de `sync.cambio_log` cuyo
 * `fila_id` YA NO EXISTE como fila en esa tabla. Una entrada así no puede
 * aplicarse nunca —su `INSERT ... ON CONFLICT (id)` crea un duplicado o rebota
 * por FK— y su ausencia no pierde nada: el estado bueno está en la fila viva y en
 * las entradas más recientes.
 *
 * NO toca entradas de filas que siguen existiendo (un nodo nuevo las ingiere o
 * las ignora por HLC).
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../src/db/connection.js';
import { tablasDeClase } from '../src/sync/clases.js';

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

  let borrables = 0;
  for (const tabla of tablasDeClase('A')) {
    const [esquema, nombre] = tabla.split('.');
    // ¿La tabla tiene columna `id`? (rol_permiso/parametro sí, tras 0012/0013.)
    const tieneId = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = 'id'`,
      [esquema, nombre],
    );
    if (tieneId.rowCount === 0) continue;

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
