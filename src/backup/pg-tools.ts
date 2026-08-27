/**
 * Localización de binarios de PostgreSQL compatibles con el servidor.
 *
 * Blueprint v0.2 · CHANGELOG D-2
 *
 * Por qué esto existe: `pg_dump` se niega a respaldar un servidor MÁS NUEVO que él.
 * En la máquina de desarrollo de este proyecto el PATH resuelve a un `pg_dump` 9.5
 * heredado de otra instalación, mientras el servidor es 18 — el respaldo fallaría con un
 * error de versión, o peor, alguien "arreglaría" el PATH y el problema volvería en una
 * sucursal seis meses después.
 *
 * Regla: la versión mayor del binario debe ser >= la del servidor. Se busca el binario
 * explícitamente y solo se cae al PATH si no hay nada mejor.
 */

import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type PgTool = 'pg_dump' | 'pg_restore' | 'createdb' | 'dropdb' | 'psql';

/** Raíces donde Windows y Linux instalan PostgreSQL. */
const ROOTS = [
  'C:/Program Files/PostgreSQL',
  'C:/Program Files (x86)/PostgreSQL',
  '/usr/lib/postgresql',
];

const exeName = (tool: PgTool): string => (process.platform === 'win32' ? `${tool}.exe` : tool);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Versiones instaladas, de mayor a menor. */
async function installedVersions(): Promise<{ major: number; bin: string }[]> {
  const found: { major: number; bin: string }[] = [];

  for (const root of ROOTS) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const major = Number.parseInt(entry, 10);
      if (Number.isNaN(major)) continue;
      const bin = path.join(root, entry, 'bin');
      if (await exists(bin)) found.push({ major, bin });
    }
  }

  return found.sort((a, b) => b.major - a.major);
}

export interface ResolvedTool {
  path: string;
  version: string;
  major: number;
}

/**
 * Devuelve la ruta a un binario cuya versión mayor sea >= `serverMajor`.
 *
 * Lanza si no encuentra ninguno: preferimos un respaldo que falla ruidosamente al
 * arrancar a uno que produce archivos que nadie puede restaurar.
 */
export async function resolveTool(tool: PgTool, serverMajor: number): Promise<ResolvedTool> {
  const candidates: string[] = [];

  const override = process.env['PG_BIN_DIR'];
  if (override) candidates.push(path.join(override, exeName(tool)));

  for (const v of await installedVersions()) {
    if (v.major >= serverMajor) candidates.push(path.join(v.bin, exeName(tool)));
  }
  candidates.push(exeName(tool)); // último recurso: el del PATH

  const rejected: string[] = [];
  for (const candidate of candidates) {
    try {
      const { stdout } = await run(candidate, ['--version']);
      const version = stdout.trim();
      const major = Number.parseInt(version.replace(/^\D+/, ''), 10);
      if (major >= serverMajor) return { path: candidate, version, major };
      rejected.push(`${candidate} (${version})`);
    } catch {
      // No existe o no es ejecutable: siguiente candidato.
    }
  }

  throw new Error(
    `No se encontró un ${tool} compatible con PostgreSQL ${serverMajor}. ` +
      (rejected.length > 0 ? `Descartados por ser más viejos: ${rejected.join(', ')}. ` : '') +
      'Instala las herramientas cliente de esa versión o define PG_BIN_DIR.',
  );
}
