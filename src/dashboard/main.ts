/**
 * Arranque del tablero consolidado en nube (F8).
 *
 *   DASHBOARD_TOKEN=... npm run tablero:nube
 *
 * Corre JUNTO a la nube (un contenedor / VPS / Fly / Railway), NO en la terminal.
 * Se conecta a Supabase (`DATABASE_URL`) en solo lectura y sirve el tablero y sus
 * reportes agregados sobre las 4 sucursales.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { resolveConnection } from '../db/connection.js';
import { construirServidorTablero } from './servidor.js';

const PUERTO = Number(process.env['TABLERO_PUERTO'] ?? process.env['PORT'] ?? 4000);
const HOST = process.env['TABLERO_HOST'] ?? '0.0.0.0';
const TOKEN = process.env['DASHBOARD_TOKEN'] ?? '';

async function main(): Promise<void> {
  if (!TOKEN || TOKEN.length < 16) {
    throw new Error(
      'Falta DASHBOARD_TOKEN (mínimo 16 caracteres). Genera uno con: ' +
        "node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\"",
    );
  }

  const conn = resolveConnection('nube');
  // Solo lectura y pocas conexiones: es un tablero, no un servicio caliente.
  const pool = new Pool({ ...conn.config, max: 4 });
  const app = construirServidorTablero({ db: pool, token: TOKEN, logger: true });

  let cerrando = false;
  const cerrar = (): void => {
    if (cerrando) return;
    cerrando = true;
    setTimeout(() => process.exit(0), 5_000).unref();
    void (async (): Promise<void> => {
      await app.close();
      await pool.end();
      process.exit(0);
    })();
  };
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);

  await app.listen({ port: PUERTO, host: HOST });
  app.log.info(`Tablero Donaji en http://${HOST}:${PUERTO} · nube ${conn.describe}`);
}

main().catch((err: unknown) => {
  console.error(`ERROR al arrancar el tablero: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
