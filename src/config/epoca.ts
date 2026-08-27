/**
 * Época de configuración — señal barata de "¿cambió algo de configuración?".
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §3.1, §3.3
 *
 * Toda la configuración se consume a través de las vistas `v_*_vigente`, que se
 * recalculan solas contra `now()`. Lo que NO se recalcula solo es una caché en
 * memoria del servidor. La época es un token derivado del último `modificado_en`
 * de las tablas de clase A: quien tenga configuración cacheada la compara contra
 * la época actual y recarga si cambió.
 *
 * `modificado_en` viaja intacto desde el origen (la nube preserva el HLC y la
 * auditoría de la fila al replicar, ver migración 0014), así que la época del
 * nodo refleja cuándo el administrador tocó la configuración, no cuándo bajó.
 */

import type { Client } from 'pg';
import { tablasDeClase } from '../sync/clases.js';

/** Las tablas de clase A. Nombres de un `const` del repo, nunca de entrada externa. */
const TABLAS_CONFIG = tablasDeClase('A').filter((t) => /^core\.[a-z_]+$/.test(t));

/**
 * Token opaco del estado actual de la configuración. Dos llamadas devuelven lo
 * mismo si y solo si ninguna tabla de clase A cambió entremedio.
 */
export async function epocaConfig(node: Client): Promise<string> {
  const union = TABLAS_CONFIG
    .map((t) => `SELECT max(modificado_en) AS m, count(*) AS n FROM ${t}`)
    .join(' UNION ALL ');

  const { rows } = await node.query<{ m: Date | null; n: string | null }>(
    `SELECT max(m) AS m, coalesce(sum(n), 0) AS n FROM (${union}) x`,
  );
  const m = rows[0]?.m ?? null;
  const n = rows[0]?.n ?? '0';
  return `${m ? m.toISOString() : 'vacio'}#${n}`;
}
