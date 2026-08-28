/**
 * Motor de sincronización de la terminal — proceso continuo.
 *
 *   npm run sync
 *   npm run sync -- --push 5000 --pull 30000
 *
 * Blueprint §4.1 / §4.2: el motor es un CONTENEDOR APARTE de la API y corre
 * SIEMPRE. En producción es un servicio de Windows (NSSM) con reinicio
 * automático; la API arranca entonces con `API_SIN_SYNC=1`.
 *
 * En desarrollo NO hace falta correr esto: `npm run api` ya arranca el motor
 * embebido (para no obligar a abrir otra terminal). Este runner es para el
 * servicio de producción y para operarlo suelto.
 *
 * El frontend NUNCA dispara sincronización.
 */

import 'dotenv/config';
import { iniciarMotor } from '../src/sync/servicio.js';

function flagNum(nombre: string): number | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ? Number(v) : undefined;
}

const opts: Parameters<typeof iniciarMotor>[0] = {};
const push = flagNum('push');
const pull = flagNum('pull');
if (push !== undefined) opts.pushIntervalMs = push;
if (pull !== undefined) opts.pullIntervalMs = pull;

const motor = iniciarMotor(opts);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[sync] ${sig}: deteniendo…`);
    // Si un push contra una nube muda deja `detener()` esperando, no colgamos.
    setTimeout(() => process.exit(0), 5_000).unref();
    void motor.detener().then(() => {
      console.log('[sync] detenido.');
      process.exit(0);
    });
  });
}
