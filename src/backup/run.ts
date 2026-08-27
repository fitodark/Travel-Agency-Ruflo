/**
 * CLI de respaldo y verificación.
 *
 *   npm run backup            respalda y verifica la restauración
 *   npm run backup -- --no-verify   solo respalda (uso horario)
 *   npm run backup:verify -- --file <ruta>   verifica un dump existente
 *
 * El ciclo horario NO verifica: restaurar en cada corrida consumiría la máquina de la
 * caja durante la operación. La verificación va una vez al día en la ventana de
 * madrugada, y siempre a mano antes de confiar en un respaldo para recuperar algo.
 *
 * ESTE COMANDO SIEMPRE OPERA SOBRE LA BASE LOCAL, y no es configurable.
 * Respaldar la nube sería respaldar lo que ya está respaldado por el proveedor, y
 * dejaría sin copia el disco de la terminal — que es el único lugar donde viven las
 * ventas que todavía no han sincronizado. Ese es el riesgo R2 completo.
 * Además, la verificación necesita CREATE/DROP DATABASE, que un Supabase gestionado
 * no permite.
 */

import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { resolveConnection } from '../db/connection.js';
import { registrarRespaldo } from '../sync/salud.js';
import { runBackup } from './backup.js';
import { verifyRestore } from './verify.js';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const DEST = value('dest') ?? process.env['BACKUP_DIR'] ?? path.resolve('backups');
const SUCURSAL = value('sucursal') ?? process.env['SUCURSAL_CODIGO'] ?? 'dev';
const RETENTION = Number(value('retention') ?? process.env['BACKUP_RETENTION_DAYS'] ?? '7');

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;

async function latestDump(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.dump')).sort();
  const last = names.at(-1);
  if (!last) throw new Error(`No hay respaldos en ${dir}`);
  return path.join(dir, last);
}

async function main(): Promise<void> {
  const conn = resolveConnection('local');
  const databaseUrl = conn.url;
  console.log(`Base local: ${conn.describe}`);

  const verifyOnly = flag('verify-only');
  let dumpFile = value('file');

  if (!verifyOnly) {
    console.log(`Respaldo -> ${DEST}`);
    const res = await runBackup({ databaseUrl, destDir: DEST, retentionDays: RETENTION, sucursal: SUCURSAL });
    console.log(`   archivo : ${path.basename(res.file)}`);
    console.log(`   tamaño  : ${mb(res.bytes)}`);
    console.log(`   esquema : ${res.schemaVersion ?? '(sin registro)'}`);
    console.log(`   duración: ${res.durationMs} ms`);
    for (const w of res.warnings) console.log(`   AVISO   : ${w}`);
    dumpFile = res.file;

    // Queda constancia en la base para que el tablero de salud sepa cuándo fue
    // el último respaldo (R2). Un fallo aquí no invalida el respaldo, que ya
    // está en disco: solo se avisa.
    const reg = new Client({ connectionString: databaseUrl });
    try {
      await reg.connect();
      await registrarRespaldo(reg, {
        archivo: path.basename(res.file),
        bytes: res.bytes,
        versionEsquema: res.schemaVersion,
      });
    } catch (err) {
      console.log(`   AVISO   : no se pudo registrar el respaldo en la base: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await reg.end().catch(() => { /* ya cerrada */ });
    }
  }

  if (flag('no-verify')) {
    console.log('\nVerificación omitida (--no-verify).');
    return;
  }

  dumpFile ??= await latestDump(DEST);
  console.log(`\nVerificando restauración de ${path.basename(dumpFile)}`);

  const v = await verifyRestore({ databaseUrl, dumpFile, keepScratch: flag('keep-scratch') });
  for (const c of v.checks) console.log(`   ${c.ok ? 'OK  ' : 'FALLA'} ${c.nombre} — ${c.detalle}`);
  console.log(`   duración: ${v.durationMs} ms`);

  if (!v.ok) {
    console.error('\nLa verificación FALLÓ. Este respaldo no es confiable.');
    process.exitCode = 1;
    return;
  }
  console.log('\nRespaldo verificado: restaurado y comparado contra el origen.');
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
