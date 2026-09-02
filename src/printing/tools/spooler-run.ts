/**
 * Spooler de impresión en marcha: vacía `core.print_job` contra la impresora de
 * la terminal.
 *
 *   npm run printer:spooler                escucha avisos + poll de respaldo 60 s
 *   npm run printer:spooler -- --once      una sola pasada y termina (cron/tests)
 *   npm run printer:spooler -- --interval 30   ajusta el poll de respaldo (s)
 *
 * Por defecto imprime AL INSTANTE: `LISTEN print_job_nuevo` recibe el aviso del
 * trigger (migración 0047) en cuanto `core.registrar_venta` encola el ticket. El
 * poll de respaldo solo recoge lo que se encoló mientras el proceso estaba caído.
 *
 * Lee la base LOCAL: cada terminal imprime SUS jobs. El transporte sale de
 * `core.config_impresora` como en producción. Para previsualizar el papel sin
 * consumir la cola, usa `npm run printer:poc-manifiesto` / `printer:poc --boleto`.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../db/connection.js';
import { iniciarSpooler } from '../servicio.js';
import { procesarCola, type ResumenSpooler } from '../spooler.js';

const args = process.argv.slice(2);
const once = args.includes('--once');
const intervalArg = args.indexOf('--interval');
const intervaloRespaldoMs =
  (intervalArg >= 0 && args[intervalArg + 1] ? Number(args[intervalArg + 1]) : 60) * 1000;

function resumir(r: ResumenSpooler): string {
  const partes = [`impresos ${r.impresos}`];
  if (r.fallidos) partes.push(`fallidos ${r.fallidos}`);
  if (r.revisionManual) partes.push(`revisión manual ${r.revisionManual}`);
  if (r.reanudados) partes.push(`reanudados ${r.reanudados}`);
  if (r.sinImpresora) partes.push(`sin impresora ${r.sinImpresora}`);
  if (r.impresoraFuera) partes.push(`impresora fuera ${r.impresoraFuera}`);
  return partes.join(' · ');
}

const sello = (l: string): string => `[${new Date().toISOString()}] ${l}`;

async function main(): Promise<void> {
  const conn = resolveConnection('local');
  console.log(`Spooler contra ${conn.describe}`);

  if (once) {
    const db = new Client(conn.config);
    await db.connect();
    try {
      console.log(sello(resumir(await procesarCola(db))));
    } finally {
      await db.end();
    }
    return;
  }

  const spooler = iniciarSpooler(conn.config, {
    intervaloRespaldoMs,
    log: (l) => console.log(sello(l)),
  });
  console.log(
    `Escuchando print_job_nuevo · poll de respaldo cada ${intervaloRespaldoMs / 1000} s · Ctrl+C para salir`,
  );

  const parar = async (): Promise<void> => {
    await spooler.detener();
    process.exit(0);
  };
  process.on('SIGINT', () => void parar());
  process.on('SIGTERM', () => void parar());

  await new Promise(() => { /* el servicio vive hasta SIGINT/SIGTERM */ });
}

main().catch((err: unknown) => {
  console.error('Spooler falló:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
