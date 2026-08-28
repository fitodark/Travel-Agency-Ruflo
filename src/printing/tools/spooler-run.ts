/**
 * Spooler de impresión en marcha: vacía `core.print_job` contra la impresora de
 * la terminal, en bucle.
 *
 *   npm run printer:spooler                una pasada cada 10 s, indefinido
 *   npm run printer:spooler -- --once      una sola pasada y termina
 *   npm run printer:spooler -- --interval 30
 *
 * Lee la base LOCAL: cada terminal imprime SUS jobs. El transporte sale de
 * `core.config_impresora` como en producción. Para previsualizar el papel sin
 * consumir la cola, usa `npm run printer:poc-manifiesto`.
 */

import { Client } from 'pg';
import { resolveConnection } from '../../db/connection.js';
import { procesarCola, type ResumenSpooler } from '../spooler.js';

const args = process.argv.slice(2);
const once = args.includes('--once');
const intervalArg = args.indexOf('--interval');
const intervalMs = (intervalArg >= 0 && args[intervalArg + 1] ? Number(args[intervalArg + 1]) : 10) * 1000;

const hayNovedad = (r: ResumenSpooler): boolean =>
  r.impresos + r.fallidos + r.revisionManual + r.reanudados > 0;

function resumir(r: ResumenSpooler): string {
  const partes = [`impresos ${r.impresos}`];
  if (r.fallidos) partes.push(`fallidos ${r.fallidos}`);
  if (r.revisionManual) partes.push(`revisión manual ${r.revisionManual}`);
  if (r.reanudados) partes.push(`reanudados ${r.reanudados}`);
  if (r.sinImpresora) partes.push(`sin impresora ${r.sinImpresora}`);
  if (r.impresoraFuera) partes.push(`impresora fuera ${r.impresoraFuera}`);
  return partes.join(' · ');
}

async function main(): Promise<void> {
  const conn = resolveConnection('local');
  const db = new Client(conn.config);
  await db.connect();
  console.log(`Spooler contra ${conn.describe}`);

  let corriendo = true;
  const parar = (): void => { corriendo = false; };
  process.on('SIGINT', parar);
  process.on('SIGTERM', parar);

  try {
    do {
      const r = await procesarCola(db);
      if (once || hayNovedad(r)) {
        console.log(`[${new Date().toISOString()}] ${resumir(r)}`);
      }
      if (once || !corriendo) break;
      await new Promise((res) => setTimeout(res, intervalMs));
    } while (corriendo);
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error('Spooler falló:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
