/**
 * Servicio del spooler: imprime `core.print_job` al instante.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.2
 *                  docs/architecture/blueprint.md §1.3 (venta → ticket < 3 s p95)
 *
 * Antes el spooler vaciaba la cola por poll (cada ~10 s). Ahora hace
 * `LISTEN print_job_nuevo` y corre una pasada en cuanto `core.registrar_venta`
 * (o el manifiesto, o una reimpresión) encola un job — el trigger `pg_notify`
 * (migración 0047) entrega el aviso en el commit de la venta. Un poll lento de
 * respaldo (60 s) recoge lo que se encoló mientras el proceso estaba caído.
 *
 * La venta NO se bloquea ni falla por la impresora: el aviso es un "corre ya",
 * no una impresión síncrona. Sigue habiendo UN spooler por terminal (D-1).
 */

import { Client, type ClientConfig } from 'pg';
import { procesarCola, type OpcionesSpooler, type ResumenSpooler } from './spooler.js';

const CANAL = 'print_job_nuevo';

/**
 * Coalescedor: junta varias solicitudes en una sola corrida y, si llega otra
 * MIENTRAS corre, encadena exactamente una más al terminar. Así los N boletos de
 * una misma venta (N avisos casi simultáneos) disparan una pasada, no N.
 */
export function crearEjecutor(
  correr: () => Promise<void>,
  opts: { debounceMs?: number } = {},
): { solicitar: () => void; detener: () => Promise<void> } {
  const debounceMs = opts.debounceMs ?? 120;
  let timer: NodeJS.Timeout | null = null;
  let enCurso = false;
  let repetir = false;
  let vivo = true;

  const disparar = async (): Promise<void> => {
    if (enCurso) { repetir = true; return; }
    enCurso = true;
    try {
      do {
        repetir = false;
        await correr();
      } while (repetir && vivo);
    } finally {
      enCurso = false;
    }
  };

  return {
    solicitar: () => {
      if (!vivo) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void disparar(); }, debounceMs);
    },
    detener: async () => {
      vivo = false;
      if (timer) { clearTimeout(timer); timer = null; }
      while (enCurso) await new Promise((r) => setTimeout(r, 20));
    },
  };
}

export interface SpoolerServicioOpts {
  /** Poll de respaldo para jobs de cuando el proceso estaba caído. Por defecto 60 s. */
  intervaloRespaldoMs?: number;
  /** Espera tras un aviso, para juntar los N boletos de una misma venta. */
  debounceMs?: number;
  /** Espera antes de reconectar tras una caída del LISTEN. */
  reintentoMs?: number;
  log?: (linea: string) => void;
  /** Inyectable en pruebas. Por defecto `procesarCola`. */
  procesar?: (db: Client, opts?: OpcionesSpooler) => Promise<ResumenSpooler>;
  opcionesSpooler?: OpcionesSpooler;
}

export interface SpoolerServicio {
  detener: () => Promise<void>;
}

/**
 * Arranca el spooler como servicio: escucha `print_job_nuevo`, corre una pasada
 * por aviso (coalescido) y un poll de respaldo. Reconecta si el LISTEN se cae.
 */
export function iniciarSpooler(
  config: ClientConfig,
  opts: SpoolerServicioOpts = {},
): SpoolerServicio {
  const log = opts.log ?? ((l) => console.log(l));
  const intervaloRespaldoMs = opts.intervaloRespaldoMs ?? 60_000;
  const reintentoMs = opts.reintentoMs ?? 5_000;
  const procesar = opts.procesar ?? procesarCola;

  let corriendo = true;
  let client: Client | null = null;
  let respaldo: NodeJS.Timeout | null = null;

  const pasada = async (): Promise<void> => {
    const db = client;
    if (!db) return;
    try {
      const r = await procesar(db, opts.opcionesSpooler);
      if (r.impresos + r.fallidos + r.revisionManual + r.reanudados > 0) {
        log(
          `[spooler] impresos ${r.impresos}` +
            (r.fallidos ? ` · fallidos ${r.fallidos}` : '') +
            (r.revisionManual ? ` · revisión manual ${r.revisionManual}` : '') +
            (r.reanudados ? ` · reanudados ${r.reanudados}` : '') +
            (r.impresoraFuera ? ` · impresora fuera ${r.impresoraFuera}` : ''),
        );
      }
    } catch (err) {
      log(`[spooler] fallo en la pasada: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const ejecutor = crearEjecutor(pasada, { debounceMs: opts.debounceMs ?? 120 });

  const conectar = async (): Promise<void> => {
    if (!corriendo) return;
    const c = new Client(config);
    c.once('error', (err: Error) => {
      // Un error durante `connect()` lo maneja el catch de abajo, no esto.
      if (client !== c) return;
      log(`[spooler] conexión caída: ${err.message}`);
      client = null;
      c.removeAllListeners('notification');
      void c.end().catch(() => { /* ya cerrada */ });
      if (corriendo) setTimeout(() => void conectar(), reintentoMs);
    });

    try {
      await c.connect();
      await c.query(`LISTEN ${CANAL}`);
      c.on('notification', () => ejecutor.solicitar());
      client = c;
      log(`[spooler] escuchando ${CANAL}`);
      // Catch-up: al (re)conectar puede haber jobs de mientras estuvo caído.
      ejecutor.solicitar();
    } catch (err) {
      log(`[spooler] no se pudo conectar: ${err instanceof Error ? err.message : String(err)}`);
      await c.end().catch(() => { /* nada */ });
      if (corriendo) setTimeout(() => void conectar(), reintentoMs);
    }
  };

  respaldo = setInterval(() => ejecutor.solicitar(), intervaloRespaldoMs);
  void conectar();

  return {
    detener: async () => {
      corriendo = false;
      if (respaldo) { clearInterval(respaldo); respaldo = null; }
      await ejecutor.detener();
      if (client) {
        await client.end().catch(() => { /* nada */ });
        client = null;
      }
    },
  };
}
