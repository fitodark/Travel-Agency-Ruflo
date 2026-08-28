/**
 * Export semanal de reportes para el cliente (F8 · mitigación R11).
 *
 *   npm run export:semanal                          -- semana pasada, contra la nube
 *   npm run export:semanal -- --target local
 *   npm run export:semanal -- --desde 2026-08-24 --hasta 2026-08-30
 *   npm run export:semanal -- --out ./exports
 *
 * Determinista y sin entrada del operador. En producción lo dispara una tarea
 * programada en la nube; la ENTREGA (correo / SFTP) la cablea F9.
 */

import 'dotenv/config';
import path from 'node:path';
import { Client } from 'pg';
import { resolveConnection, targetFromArgs } from '../src/db/connection.js';
import {
  escribirBundle, generarBundleSemanal, rangoSemanaAnterior,
} from '../src/dashboard/export.js';

function flag(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const target = targetFromArgs(process.argv.slice(2), 'nube');
  const conn = resolveConnection(target);
  const outDir = path.resolve(flag('out') ?? 'exports');

  const desde = flag('desde');
  const hasta = flag('hasta');
  const rango = desde && hasta ? { desde, hasta } : rangoSemanaAnterior();

  console.log(`Export semanal (${target} · ${conn.describe})`);
  console.log(`  rango : ${rango.desde} .. ${rango.hasta}`);

  const c = new Client(conn.config);
  await c.connect();
  try {
    const bundle = await generarBundleSemanal(c, rango);
    const rutas = await escribirBundle(bundle, outDir);
    console.log(`  carpeta : ${path.join(outDir, bundle.rango.etiqueta)}`);
    console.log(`  archivos: ${rutas.length}`);
    console.log(`  ventas   : ${bundle.ventas.length} filas`);
    console.log(`  cortes   : ${bundle.cortes.length} filas`);
    console.log(`  excepciones abiertas: ${bundle.excepciones.length}`);
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
