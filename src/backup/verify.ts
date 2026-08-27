/**
 * Verificación de restauración.
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F0)
 * Criterio de aceptación de F0: "un respaldo restaurado con éxito".
 *
 * UN RESPALDO QUE NADIE HA RESTAURADO NO ES UN RESPALDO: es un archivo del que se
 * asume algo. El modo de falla clásico es descubrir que los dumps estaban truncados el
 * día que se necesita uno — que en este sistema es el día que muere la única PC de una
 * terminal y con ella las ventas que no habían sincronizado.
 *
 * Esta verificación restaura en una base desechable y COMPARA contra el origen. Al
 * terminar, la base desechable se elimina.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { resolveTool } from './pg-tools.js';

const run = promisify(execFile);

export interface VerifyResult {
  ok: boolean;
  scratchDb: string;
  checks: CheckResult[];
  durationMs: number;
}

export interface CheckResult {
  nombre: string;
  ok: boolean;
  detalle: string;
}

/** Reemplaza el nombre de base en la URL, conservando credenciales y parámetros. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

interface Snapshot {
  schemaVersion: string | null;
  tablas: Map<string, number>;
  filas: Map<string, number>;
  exclusiones: number;
}

/**
 * Radiografía comparable de una base.
 *
 * Se comparan conteos de tablas por esquema, filas de las tablas con datos, y número de
 * restricciones `EXCLUDE`. Esto último no es decorativo: si un dump restaurara las tablas
 * pero no la restricción anti-sobreventa, la copia parecería sana y estaría rota justo
 * en la garantía que sostiene el sistema.
 */
async function snapshot(client: Client): Promise<Snapshot> {
  const tablas = new Map<string, number>();
  const t = await client.query<{ s: string; n: string }>(
    `SELECT table_schema AS s, count(*)::text AS n FROM information_schema.tables
      WHERE table_schema IN ('core','sync','auth_local','api') GROUP BY 1`,
  );
  for (const r of t.rows) tablas.set(r.s, Number(r.n));

  const filas = new Map<string, number>();
  const conDatos = await client.query<{ full: string }>(
    `SELECT format('%I.%I', schemaname, relname) AS full
       FROM pg_stat_user_tables
      WHERE schemaname IN ('core','sync','auth_local','public')
      ORDER BY 1`,
  );
  for (const { full } of conDatos.rows) {
    const c = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${full}`);
    const n = Number(c.rows[0]!.n);
    if (n > 0) filas.set(full, n);
  }

  const e = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_constraint WHERE contype = 'x'`,
  );

  let schemaVersion: string | null = null;
  try {
    const s = await client.query<{ version: string }>(
      'SELECT version FROM public.schema_migration ORDER BY version DESC LIMIT 1',
    );
    schemaVersion = s.rows[0]?.version ?? null;
  } catch { /* base sin registro */ }

  return { schemaVersion, tablas, filas, exclusiones: Number(e.rows[0]!.n) };
}

function compare(origen: Snapshot, copia: Snapshot): CheckResult[] {
  const checks: CheckResult[] = [];

  checks.push({
    nombre: 'versión de esquema',
    ok: origen.schemaVersion === copia.schemaVersion,
    detalle: `origen=${origen.schemaVersion ?? 'ninguna'} copia=${copia.schemaVersion ?? 'ninguna'}`,
  });

  for (const [esquema, n] of origen.tablas) {
    const m = copia.tablas.get(esquema) ?? 0;
    checks.push({
      nombre: `tablas en ${esquema}`,
      ok: n === m,
      detalle: `origen=${n} copia=${m}`,
    });
  }

  checks.push({
    nombre: 'restricciones EXCLUDE (anti-sobreventa)',
    ok: origen.exclusiones === copia.exclusiones && origen.exclusiones > 0,
    detalle: `origen=${origen.exclusiones} copia=${copia.exclusiones}`,
  });

  const diferencias: string[] = [];
  for (const [tabla, n] of origen.filas) {
    const m = copia.filas.get(tabla) ?? 0;
    if (n !== m) diferencias.push(`${tabla}: ${n} vs ${m}`);
  }
  checks.push({
    nombre: 'conteo de filas',
    ok: diferencias.length === 0,
    detalle:
      diferencias.length === 0
        ? `${origen.filas.size} tabla(s) con datos, todas coinciden`
        : diferencias.join('; '),
  });

  return checks;
}

/**
 * Extrae la línea útil del error de un binario de PostgreSQL.
 *
 * `execFile` construye un mensaje multilínea que empieza con el comando completo y
 * termina con un salto; el motivo real ("no se pudo leer desde el archivo de entrada")
 * está en medio. Sin esto, el registro de una tarea programada dice "FALLA" sin decir
 * por qué, que es tanto como no decir nada.
 */
function lastMeaningfulLine(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const lines = err.message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('Command failed'));
  return lines.at(-1) ?? err.message.trim();
}

export interface VerifyOptions {
  databaseUrl: string;
  dumpFile: string;
  /** Base desechable donde restaurar. Se crea y se elimina. */
  scratchDb?: string;
  /** Base de mantenimiento para CREATE/DROP DATABASE. */
  maintenanceDb?: string;
  keepScratch?: boolean;
}

export async function verifyRestore(opts: VerifyOptions): Promise<VerifyResult> {
  const started = Date.now();
  const scratchDb = opts.scratchDb ?? `donaji_verify_${Date.now()}`;
  const maintenanceUrl = withDatabase(opts.databaseUrl, opts.maintenanceDb ?? 'postgres');

  const origin = new Client({ connectionString: opts.databaseUrl });
  await origin.connect();
  let serverMajor: number;
  let origenSnap: Snapshot;
  try {
    const v = await origin.query<{ n: string }>("SELECT current_setting('server_version_num') AS n");
    serverMajor = Math.floor(Number(v.rows[0]!.n) / 10000);
    origenSnap = await snapshot(origin);
  } finally {
    await origin.end();
  }

  const pgRestore = await resolveTool('pg_restore', serverMajor);

  // 1. ¿El archivo es siquiera legible? Un dump truncado falla aquí, antes de crear nada.
  //
  // Un fallo aquí NO se propaga como excepción: esto corre como tarea programada sin
  // nadie mirando, y un respaldo corrupto tiene que quedar registrado como verificación
  // fallida —con su motivo— y no como una traza de error que nadie interpreta.
  const checks: CheckResult[] = [];
  let legible = false;
  try {
    const listed = await run(pgRestore.path, ['--list', opts.dumpFile], { maxBuffer: 1024 * 1024 * 64 });
    const entradas = listed.stdout.split('\n').filter((l) => l.trim() && !l.startsWith(';')).length;
    legible = entradas > 0;
    checks.push({
      nombre: 'archivo legible por pg_restore',
      ok: legible,
      detalle: `${entradas} entradas en el catálogo`,
    });
  } catch (err) {
    checks.push({ nombre: 'archivo legible por pg_restore', ok: false, detalle: lastMeaningfulLine(err) });
  }

  // Sin un archivo legible no tiene sentido crear una base para restaurarlo.
  if (!legible) {
    return { ok: false, scratchDb, checks, durationMs: Date.now() - started };
  }

  const admin = new Client({ connectionString: maintenanceUrl });
  await admin.connect();

  try {
    await admin.query(`DROP DATABASE IF EXISTS "${scratchDb}"`);
    await admin.query(`CREATE DATABASE "${scratchDb}"`);

    // 2. Restaurar. `--exit-on-error` para que un fallo no quede enterrado entre avisos.
    const scratchUrl = withDatabase(opts.databaseUrl, scratchDb);
    await run(
      pgRestore.path,
      ['--dbname', scratchUrl, '--no-owner', '--no-privileges', '--exit-on-error', opts.dumpFile],
      { maxBuffer: 1024 * 1024 * 64 },
    );
    checks.push({ nombre: 'restauración sin errores', ok: true, detalle: `restaurado en ${scratchDb}` });

    // 3. Comparar la copia contra el origen.
    const copy = new Client({ connectionString: scratchUrl });
    await copy.connect();
    try {
      checks.push(...compare(origenSnap, await snapshot(copy)));
    } finally {
      await copy.end();
    }
  } catch (err) {
    checks.push({
      nombre: 'restauración sin errores',
      ok: false,
      detalle: err instanceof Error ? err.message.split('\n')[0]! : String(err),
    });
  } finally {
    if (!opts.keepScratch) {
      await admin.query(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`).catch(() => { /* mejor esfuerzo */ });
    }
    await admin.end();
  }

  return {
    ok: checks.every((c) => c.ok),
    scratchDb,
    checks,
    durationMs: Date.now() - started,
  };
}
