/**
 * Supervisor del motor de sincronización.
 *
 * Blueprint §4.1/§4.2: el motor empuja el outbox y jala cambios SIEMPRE, sin que
 * nadie dispare nada. Mantiene conexiones a local y nube; si alguna se cae,
 * reconecta desde cero. Sobrevive a que la nube no exista al arrancar (el caso
 * normal en una terminal sin internet): opera en local y drena cuando vuelve.
 *
 * Lo usan tanto el runner standalone (`npm run sync`, servicio de Windows en
 * producción) como la API en desarrollo (motor embebido, para no obligar a QA a
 * abrir otra terminal). En producción la API arranca con `API_SIN_SYNC=1` y el
 * servicio corre aparte.
 */

import { Client } from 'pg';
import { resolveConnection } from '../db/connection.js';
import { SyncEngine, type EventoSync } from './engine.js';

export interface MotorOpts {
  pushIntervalMs?: number;
  pullIntervalMs?: number;
  versionNodo?: string;
  onEvento?: (ev: EventoSync) => void;
  /** Espera antes de reconectar tras una caída. */
  reintentoMs?: number;
  log?: (linea: string) => void;
}

export interface Motor {
  detener: () => Promise<void>;
}

export function iniciarMotor(opts: MotorOpts = {}): Motor {
  const log = opts.log ?? ((l) => console.log(l));
  const reintentoMs = opts.reintentoMs ?? 5_000;
  let corriendo = true;
  let engineActual: SyncEngine | null = null;
  let nodeActual: Client | null = null;
  let cloudActual: Client | null = null;

  const cerrarConexiones = async (): Promise<void> => {
    await nodeActual?.end().catch(() => { /* ya cerrada */ });
    await cloudActual?.end().catch(() => { /* ya cerrada */ });
    nodeActual = null;
    cloudActual = null;
  };

  const bucle = async (): Promise<void> => {
    while (corriendo) {
      try {
        const node = new Client(resolveConnection('local').config);
        const cloud = new Client(resolveConnection('nube').config);
        nodeActual = node;
        cloudActual = cloud;

        await node.connect();
        await cloud.connect();
        log('[sync] conectado a local y nube');

        const caida = new Promise<void>((resolve) => {
          const fin = (que: string) => (err: Error): void => {
            log(`[sync] conexión ${que} caída: ${err.message}`);
            resolve();
          };
          node.once('error', fin('local'));
          cloud.once('error', fin('nube'));
        });

        const engine = new SyncEngine(node, cloud, {
          pushIntervalMs: opts.pushIntervalMs ?? 5_000,
          pullIntervalMs: opts.pullIntervalMs ?? 30_000,
          ...(opts.versionNodo !== undefined ? { versionNodo: opts.versionNodo } : {}),
        });
        engineActual = engine;
        if (opts.onEvento) engine.observar(opts.onEvento);
        engine.observar((ev) => {
          if (ev.tipo === 'fallo') {
            log(`[sync] fallo en ${ev.fase}: ${ev.error} · reintento en ${Math.round(ev.esperaMs / 1000)}s`);
          } else if (ev.tipo === 'recuperado') {
            log(`[sync] recuperado tras ${ev.trasFallos} fallo(s)`);
          } else if (ev.tipo === 'push_ok' && ev.resultado.enviadas > 0) {
            const r = ev.resultado;
            log(`[sync] push: ${r.aceptadas} aceptadas, ${r.ignoradas} ignoradas, ${r.conflictos} conflictos, ${r.rechazadas} rechazadas`);
          } else if (ev.tipo === 'pull_ok' && ev.resultado.aplicadas > 0) {
            log(`[sync] pull: ${ev.resultado.aplicadas} aplicadas`);
          }
        });

        await engine.iniciar();
        log('[sync] motor en marcha');

        await Promise.race([caida, detencion]);
        await engine.detener();
        engineActual = null;
        await cerrarConexiones();
      } catch (err) {
        log(`[sync] no se pudo arrancar: ${err instanceof Error ? err.message : String(err)}`);
        await cerrarConexiones();
      }

      if (corriendo) {
        log(`[sync] reintentando en ${reintentoMs / 1000}s…`);
        await new Promise((r) => setTimeout(r, reintentoMs));
      }
    }
  };

  let resolverDetencion!: () => void;
  const detencion = new Promise<void>((r) => { resolverDetencion = r; });

  void bucle();

  return {
    detener: async () => {
      corriendo = false;
      resolverDetencion();
      await engineActual?.detener().catch(() => { /* ya detenido */ });
      await cerrarConexiones();
    },
  };
}
