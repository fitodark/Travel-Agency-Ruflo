/**
 * Arranque de la consola de administración en nube (F2b).
 *
 *   SUPABASE_JWT_SECRET=... npm run admin
 *
 * Corre JUNTO a la nube (contenedor / VPS / Fly / Railway), NO en la terminal.
 * Se conecta a Supabase (`DATABASE_URL`) y es la única superficie de escritura de
 * la configuración clase A.
 *
 * TODO (deuda de slice 1): usar un rol de Postgres dedicado con permisos solo
 * sobre las tablas clase A, en vez del rol de `DATABASE_URL`. Hoy comparte
 * conexión con el resto, igual que el tablero.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { conexionDesdeUrl, resolveConnection } from '../db/connection.js';
import { construirServidorAdmin } from './servidor.js';

const PUERTO = Number(process.env['ADMIN_PUERTO'] ?? process.env['PORT'] ?? 4100);
const HOST = process.env['ADMIN_HOST'] ?? '0.0.0.0';
const JWT_SECRET = process.env['SUPABASE_JWT_SECRET'] ?? '';
const ADMINS_INICIALES = (process.env['ADMIN_EMAILS'] ?? '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

async function main(): Promise<void> {
  if (!JWT_SECRET || JWT_SECRET.length < 20) {
    throw new Error(
      'Falta SUPABASE_JWT_SECRET (Settings → API → JWT Secret del proyecto Supabase).',
    );
  }

  // Preferí `ADMIN_DATABASE_URL` (rol `donaji_consola`, acotado a configuración);
  // si no está, cae al rol de `DATABASE_URL`, igual que el tablero.
  const urlAdmin = process.env['ADMIN_DATABASE_URL'];
  const conn = urlAdmin
    ? { url: urlAdmin, ...conexionDesdeUrl(urlAdmin) }
    : resolveConnection('nube');
  const pool = new Pool({ ...conn.config, max: 4 });

  // Red de seguridad: la consola SOLO debe correr contra la nube. Escribir
  // configuración contra una terminal no rompe nada (el pull la sobrescribe),
  // pero es un error de despliegue que conviene atajar aquí.
  const { rows } = await pool.query<{ es_nube: boolean }>(
    `SELECT es_nube FROM sync.nodo WHERE singleton`,
  );
  if (!rows[0]?.es_nube) {
    await pool.end();
    throw new Error(
      `DATABASE_URL no apunta a la nube: sync.nodo.es_nube es ${String(rows[0]?.es_nube)}. ` +
        'La consola de administración solo corre junto a la nube.',
    );
  }

  const app = construirServidorAdmin({
    db: pool,
    jwtSecret: JWT_SECRET,
    adminsIniciales: ADMINS_INICIALES,
    ...(process.env['SUPABASE_URL'] ? { supabaseUrl: process.env['SUPABASE_URL'] } : {}),
    ...(process.env['SUPABASE_ANON_KEY'] ? { supabaseAnonKey: process.env['SUPABASE_ANON_KEY'] } : {}),
    logger: true,
  });

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
  app.log.info(
    `Consola de administración Donaji en http://${HOST}:${PUERTO} · nube ${conn.describe}` +
      ` · ${ADMINS_INICIALES.length} admin(s) de arranque`,
  );
}

main().catch((err: unknown) => {
  console.error(`ERROR al arrancar la consola: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
