/**
 * Arranque del servicio HTTP de la terminal.
 *
 *   npm run api
 *
 * En producción corre como servicio de Windows (NSSM, arranque automático): la
 * ventana de configuración, el drenaje del outbox y la cola de impresión ocurren
 * sin operador, así que el proceso no puede estar atado a una ventana abierta
 * (blueprint §4.2).
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { resolveConnection } from '../db/connection.js';
import { construirApp } from './server.js';

const PUERTO = Number(process.env['API_PUERTO'] ?? process.env['PORT'] ?? 3000);
const HOST = process.env['API_HOST'] ?? '127.0.0.1';

async function main(): Promise<void> {
  const conn = resolveConnection('local');
  const pool = new Pool({ ...conn.config, max: 10 });
  const app = await construirApp({ db: pool, logger: true });

  const cerrar = (): void => {
    void (async (): Promise<void> => {
      await app.close();
      await pool.end();
      process.exit(0);
    })();
  };
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);

  await app.listen({ port: PUERTO, host: HOST });
  app.log.info(`Donaji API escuchando en http://${HOST}:${PUERTO} · base ${conn.describe}`);
}

main().catch((err: unknown) => {
  console.error(`ERROR al arrancar la API: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
