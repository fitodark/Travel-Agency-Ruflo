/**
 * Aplicación del esquema: carga de migraciones, registro de versiones y ejecución.
 *
 * Blueprint v0.2 · CHANGELOG D-8
 *
 * Vive separado del CLI a propósito. El banco de pruebas de sincronización levanta
 * nodos de sucursal desechables importando `aplicarEsquema`, y un módulo con efectos
 * al importarse dispararía migraciones contra la base equivocada solo por cargarlo.
 *
 * El registro `public.schema_migration` es además la fuente del "versión de esquema por
 * nodo" que exige D-8: como las 4 terminales se actualizan a mano por TeamViewer, no
 * todas quedan en la misma versión la misma noche, y el tablero de salud necesita saber
 * en cuál está cada una.
 *
 * Decisiones deliberadas:
 *  - Cada migración corre en SU PROPIA transacción. Un fallo a la mitad no deja el
 *    esquema en un estado intermedio no registrado.
 *  - Se guarda un checksum del archivo. Si alguien edita una migración ya aplicada, el
 *    runner lo detecta y se niega a continuar: en un sistema replicado, dos nodos con la
 *    "misma" versión y distinto DDL es una fuente de corrupción silenciosa.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(HERE, 'migrations');
export const SEED_DIR = path.join(HERE, 'seed');

export const LEDGER = `
CREATE TABLE IF NOT EXISTS public.schema_migration (
  version     text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL
)`;

export interface MigrationFile {
  version: string;
  file: string;
  sql: string;
  checksum: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export async function loadDir(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const file of names) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    out.push({ version: file.replace(/\.sql$/, ''), file, sql, checksum: sha256(sql) });
  }
  return out;
}

export interface ApplyOptions {
  dryRun?: boolean;
  includeSeeds?: boolean;
}

export async function applyAll(
  client: Client,
  files: MigrationFile[],
  opts: ApplyOptions,
  log: (s: string) => void = console.log,
): Promise<number> {
  const { rows } = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM public.schema_migration',
  );
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  // Un archivo ya aplicado que cambió de contenido es un error, no una migración nueva:
  // dos nodos "en la misma versión" con distinto DDL divergen sin que nadie lo note.
  const drifted = files.filter((f) => applied.has(f.version) && applied.get(f.version) !== f.checksum);
  if (drifted.length > 0) {
    throw new Error(
      `Migraciones ya aplicadas que fueron modificadas: ${drifted.map((d) => d.file).join(', ')}. ` +
        'Crea una migración nueva en vez de editar una aplicada.',
    );
  }

  const pending = files.filter((f) => !applied.has(f.version));
  if (pending.length === 0) {
    log('   (nada pendiente)');
    return 0;
  }

  for (const m of pending) {
    if (opts.dryRun) {
      log(`   [dry] ${m.file}`);
      continue;
    }
    const started = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      const ms = Date.now() - started;
      await client.query(
        'INSERT INTO public.schema_migration (version, checksum, duration_ms) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now(), duration_ms = EXCLUDED.duration_ms',
        [m.version, m.checksum, ms],
      );
      await client.query('COMMIT');
      log(`   ✓ ${m.file} (${ms} ms)`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* la conexión pudo morir */ });
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Falló ${m.file}: ${detail}`);
    }
  }
  return pending.length;
}

interface RunOptions {
  dryRun: boolean;
  statusOnly: boolean;
  withSeeds: boolean;
}


/**
 * Aplica el esquema completo a una conexión ya abierta.
 *
 * Usa EXACTAMENTE las mismas migraciones que producción: un nodo de prueba construido
 * por otro camino probaría otro sistema.
 */
export async function aplicarEsquema(
  client: Client,
  opts: { withSeeds?: boolean; silencioso?: boolean } = {},
): Promise<void> {
  await client.query(LEDGER);
  const log = opts.silencioso === true ? (): void => { /* sin ruido */ } : console.log;
  await applyAll(client, await loadDir(MIGRATIONS_DIR), {}, log);
  if (opts.withSeeds !== false) await applyAll(client, await loadDir(SEED_DIR), {}, log);
}
