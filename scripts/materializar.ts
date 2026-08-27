/**
 * Job de materialización de salidas.
 *
 *   npm run materializar                 -- horizonte por defecto (90 d), contra la nube
 *   npm run materializar -- --target local
 *   npm run materializar -- --dias 30
 *
 * En producción lo dispara la ventana nocturna en la nube. Este runner existe
 * para operarlo a mano y para el entorno de desarrollo.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection, targetFromArgs } from '../src/db/connection.js';
import { materializarVigentes } from '../src/fleet/materializar.js';

function flagNumero(nombre: string): number | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ? Number(v) : undefined;
}

async function main(): Promise<void> {
  const target = targetFromArgs(process.argv.slice(2), 'nube');
  const conn = resolveConnection(target);
  console.log(`Materializando salidas en ${target} (${conn.describe})`);

  const c = new Client(conn.config);
  await c.connect();
  try {
    const dias = flagNumero('dias');
    const r = await materializarVigentes(c, dias !== undefined ? { dias } : {});
    console.log(`\n  horarios procesados : ${r.horarios}`);
    console.log(`  salidas creadas     : ${r.creadas}`);
    console.log(`  ya existentes       : ${r.yaExistentes}`);
    if (r.sinParadas > 0) console.log(`  AVISO: ${r.sinParadas} salida(s) sin paradas (horario sin horario_parada)`);
    for (const d of r.detalle) {
      console.log(`    ${d.ruta}: +${d.creadas} (${d.yaExistentes} ya estaban)`);
    }
  } finally {
    await c.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
