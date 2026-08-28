/**
 * Motor de sincronización de la terminal — proceso continuo.
 *
 *   npm run sync
 *   npm run sync -- --push 5000 --pull 30000
 *
 * Blueprint §4.1 / §4.2: el motor es un CONTENEDOR APARTE de la API y corre
 * SIEMPRE, aunque nadie tenga la SPA abierta. En producción es un servicio de
 * Windows (NSSM) con arranque automático y reinicio ante caída. Este runner es
 * ese servicio: empuja el outbox cada ~5 s y jala cambios cada ~30 s, con
 * backoff exponencial cuando la nube no responde.
 *
 * El frontend NO dispara sincronización: solo observa el estado por
 * `GET /sync/estado`. (El endpoint `POST /sync/ciclo` existe solo para forzar un
 * ciclo a mano en pruebas.)
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../src/db/connection.js';
import { SyncEngine } from '../src/sync/engine.js';

function flagNum(nombre: string): number | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ? Number(v) : undefined;
}

const REINTENTO_CONEXION_MS = 5_000;
let corriendo = true;

async function unaVida(): Promise<void> {
  const node = new Client(resolveConnection('local').config);
  const cloud = new Client(resolveConnection('nube').config);

  await node.connect();
  await cloud.connect();
  console.log(`[sync] conectado · local ${resolveConnection('local').describe} · nube ${resolveConnection('nube').describe}`);

  // Si CUALQUIER conexión se rompe, se termina esta vida y el bucle de `main`
  // reconecta desde cero.
  const caida = new Promise<void>((resolve) => {
    const fin = (que: string) => (err: Error) => {
      console.error(`[sync] conexión ${que} caída: ${err.message}`);
      resolve();
    };
    node.once('error', fin('local'));
    cloud.once('error', fin('nube'));
  });

  const engine = new SyncEngine(node, cloud, {
    pushIntervalMs: flagNum('push') ?? 5_000,
    pullIntervalMs: flagNum('pull') ?? 30_000,
  });

  engine.observar((ev) => {
    if (ev.tipo === 'fallo') {
      console.warn(`[sync] fallo en ${ev.fase}: ${ev.error} · reintento en ${Math.round(ev.esperaMs / 1000)}s`);
    } else if (ev.tipo === 'degradado') {
      console.warn('[sync] modo degradado: demasiado tiempo sin sincronizar');
    } else if (ev.tipo === 'recuperado') {
      console.log(`[sync] recuperado tras ${ev.trasFallos} fallo(s)`);
    } else if (ev.tipo === 'push_ok' && ev.resultado.enviadas > 0) {
      const r = ev.resultado;
      console.log(`[sync] push: ${r.aceptadas} aceptadas, ${r.ignoradas} ignoradas, ${r.conflictos} conflictos, ${r.rechazadas} rechazadas`);
    } else if (ev.tipo === 'pull_ok' && ev.resultado.aplicadas > 0) {
      console.log(`[sync] pull: ${ev.resultado.aplicadas} aplicadas`);
    }
  });

  await engine.iniciar();
  console.log('[sync] motor en marcha');

  await Promise.race([caida, detencion]);
  await engine.detener();
  await node.end().catch(() => { /* ya cerrada */ });
  await cloud.end().catch(() => { /* ya cerrada */ });
}

let resolverDetencion: () => void;
const detencion = new Promise<void>((r) => { resolverDetencion = r; });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (!corriendo) return;
    corriendo = false;
    console.log(`\n[sync] ${sig}: deteniendo…`);
    resolverDetencion();
  });
}

async function main(): Promise<void> {
  while (corriendo) {
    try {
      await unaVida();
    } catch (err) {
      console.error(`[sync] error de arranque: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (corriendo) {
      console.log(`[sync] reconectando en ${REINTENTO_CONEXION_MS / 1000}s…`);
      await new Promise((r) => setTimeout(r, REINTENTO_CONEXION_MS));
    }
  }
  console.log('[sync] detenido.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
