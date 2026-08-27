/**
 * Respaldo local de la base de la sucursal.
 *
 * Blueprint v0.2 · CHANGELOG D-2 · docs/architecture/04-riesgos-roadmap.md R2
 *
 * POR QUÉ ESTO ES CRÍTICO Y NO OPCIONAL:
 * P1 confirmó que cada terminal tiene UNA SOLA PC. Mientras esa sucursal está sin
 * internet, sus ventas existen únicamente en ese disco: no hay segunda máquina, no hay
 * réplica, y la nube todavía no las conoce. Si el disco muere antes de sincronizar, esa
 * información no está en ningún otro lugar del mundo.
 *
 * Un `pg_dump` horario a un medio físico distinto es la diferencia entre perder una hora
 * y perder tres días de operación de una terminal.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { resolveTool } from './pg-tools.js';

const run = promisify(execFile);

export interface BackupConfig {
  databaseUrl: string;
  /** Destino de los respaldos. En producción DEBE ser un medio físico distinto. */
  destDir: string;
  /** Días de retención. Blueprint: 7. */
  retentionDays: number;
  /** Etiqueta de la sucursal, para distinguir archivos si se juntan. */
  sucursal: string;
}

export interface BackupResult {
  file: string;
  bytes: number;
  durationMs: number;
  schemaVersion: string | null;
  warnings: string[];
}

const stamp = (d: Date): string => d.toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Advierte si el respaldo va al mismo volumen que la base.
 *
 * Es el error que anula el propósito entero: un `pg_dump` en `D:\` cuando la base vive
 * en `D:\` no protege contra la falla de disco, que es exactamente el riesgo R2. No se
 * bloquea (en desarrollo es lo normal), pero tiene que ser imposible no verlo.
 */
export function sameVolumeWarning(destDir: string, dataDir: string | null): string | null {
  if (!dataDir) return null;
  const volume = (p: string): string => path.parse(path.resolve(p)).root.toUpperCase();
  if (volume(destDir) !== volume(dataDir)) return null;
  return (
    `El destino del respaldo (${volume(destDir)}) está en el MISMO volumen que la base de datos. ` +
    'Un fallo de disco se lleva ambos. En la terminal esto debe apuntar a una USB o disco externo dedicado.'
  );
}

export async function runBackup(cfg: BackupConfig): Promise<BackupResult> {
  const warnings: string[] = [];
  const started = Date.now();

  const client = new Client({ connectionString: cfg.databaseUrl });
  await client.connect();

  let serverMajor: number;
  let dataDir: string | null = null;
  let schemaVersion: string | null = null;

  try {
    const v = await client.query<{ n: string }>("SELECT current_setting('server_version_num') AS n");
    serverMajor = Math.floor(Number(v.rows[0]!.n) / 10000);

    // `data_directory` solo lo puede leer un superusuario; si no se puede, se sigue sin
    // la advertencia de volumen en vez de abortar el respaldo.
    try {
      const d = await client.query<{ dir: string }>("SELECT current_setting('data_directory') AS dir");
      dataDir = d.rows[0]!.dir;
    } catch {
      warnings.push('No se pudo leer data_directory (se requiere superusuario): no se verifica el volumen.');
    }

    try {
      const s = await client.query<{ version: string }>(
        'SELECT version FROM public.schema_migration ORDER BY version DESC LIMIT 1',
      );
      schemaVersion = s.rows[0]?.version ?? null;
    } catch {
      warnings.push('La base no tiene registro de migraciones todavía.');
    }
  } finally {
    await client.end();
  }

  const volumeWarning = sameVolumeWarning(cfg.destDir, dataDir);
  if (volumeWarning) warnings.push(volumeWarning);

  await mkdir(cfg.destDir, { recursive: true });

  const pgDump = await resolveTool('pg_dump', serverMajor);
  const file = path.join(cfg.destDir, `donaji-${cfg.sucursal}-${stamp(new Date())}.dump`);

  // Formato custom (-Fc): comprimido, restaurable selectivamente y con pg_restore
  // paralelo. Un .sql plano sería más grande y más lento de restaurar bajo presión,
  // que es justo el momento en que se usa.
  await run(pgDump.path, ['--format=custom', '--compress=6', '--file', file, cfg.databaseUrl], {
    maxBuffer: 1024 * 1024 * 64,
  });

  const { size } = await stat(file);
  if (size === 0) throw new Error(`pg_dump produjo un archivo vacío: ${file}`);

  await writeFile(
    `${file}.json`,
    JSON.stringify(
      {
        archivo: path.basename(file),
        sucursal: cfg.sucursal,
        creado_en: new Date().toISOString(),
        bytes: size,
        version_esquema: schemaVersion,
        pg_dump: pgDump.version,
        servidor_major: serverMajor,
      },
      null,
      2,
    ),
    'utf8',
  );

  const purged = await purgeOld(cfg.destDir, cfg.retentionDays);
  if (purged > 0) warnings.push(`${purged} respaldo(s) fuera de retención eliminados.`);

  return { file, bytes: size, durationMs: Date.now() - started, schemaVersion, warnings };
}

/** Elimina respaldos más viejos que la retención. Nunca borra el más reciente. */
export async function purgeOld(dir: string, retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const names = (await readdir(dir)).filter((n) => n.endsWith('.dump')).sort();

  // Guarda siempre el último, aunque la retención diga lo contrario: una terminal que
  // estuvo apagada una semana no debe quedarse sin ningún respaldo al encenderse.
  const candidates = names.slice(0, -1);

  let removed = 0;
  for (const name of candidates) {
    const full = path.join(dir, name);
    const { mtimeMs } = await stat(full);
    if (mtimeMs >= cutoff) continue;
    await unlink(full);
    await unlink(`${full}.json`).catch(() => { /* el manifiesto pudo no existir */ });
    removed++;
  }
  return removed;
}
