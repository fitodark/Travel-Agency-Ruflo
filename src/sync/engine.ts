/**
 * Motor de sincronización: el ciclo continuo que corre en la terminal.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.3
 *
 * La PoC de F0 demostró que el mecanismo funciona invocando push y pull a mano. Esto es
 * lo que lo convierte en algo que opera solo durante meses en una PC de mostrador sin
 * que nadie lo mire.
 *
 * PRINCIPIO RECTOR: **la nube nunca está en el camino crítico de una venta** (driver D1).
 * El ciclo es asíncrono respecto de la caja. Que la sincronización falle, se atrase o
 * lleve tres días caída no debe impedir vender un boleto — solo encender avisos.
 */

import type { Client } from 'pg';
import { push, outboxPendiente, type PushResult } from './push.js';
import { pull, type PullResult } from './pull.js';

export interface EngineOptions {
  /** Cadencia de subida en operación normal. Blueprint: 5 s. */
  pushIntervalMs?: number;
  /** Cadencia de bajada en operación normal. Blueprint: 30 s. */
  pullIntervalMs?: number;
  /** Filas por lote. Blueprint: 500 en drenaje tras corte largo. */
  batchSize?: number;
  /** Antigüedad de sync que dispara el modo degradado. Blueprint S9: 72 h. */
  staleThresholdMs?: number;
  /** Espera inicial del backoff exponencial. */
  backoffBaseMs?: number;
  /** Techo del backoff: nunca se deja de reintentar, solo se espacia. */
  backoffMaxMs?: number;
  versionNodo?: string;
  /** Reloj inyectable, para poder probar el paso del tiempo sin esperarlo. */
  now?: () => number;
}

export interface EngineState {
  corriendo: boolean;
  /** Última subida Y bajada exitosas. Alimenta el stale-guard. */
  ultimaSyncExitosa: Date | null;
  outboxPendiente: number;
  fallosConsecutivos: number;
  /** Espera actual del backoff, en ms. 0 cuando todo va bien. */
  esperaBackoffMs: number;
  degradado: boolean;
  ultimoError: string | null;
  ciclosPush: number;
  ciclosPull: number;
}

export type EventoSync =
  | { tipo: 'push_ok'; resultado: PushResult }
  | { tipo: 'pull_ok'; resultado: PullResult }
  | { tipo: 'fallo'; fase: 'push' | 'pull'; error: string; esperaMs: number }
  | { tipo: 'degradado'; desde: Date | null }
  | { tipo: 'recuperado'; trasFallos: number };

export type Observador = (evento: EventoSync) => void;

const DEFAULTS = {
  pushIntervalMs: 5_000,
  pullIntervalMs: 30_000,
  batchSize: 500,
  staleThresholdMs: 72 * 60 * 60 * 1000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 5 * 60 * 1000,
};

/**
 * Backoff exponencial con tope y jitter.
 *
 * El tope importa: sin él, tras un corte de un día la espera crecería a horas y la
 * terminal seguiría desconectada mucho después de que volviera el internet. El techo de
 * 5 minutos garantiza que se reconecta pronto sin martillar la red.
 *
 * El jitter (±20%) evita que las 4 sucursales, que se cayeron juntas por un corte
 * regional, reintenten exactamente en el mismo instante contra la misma nube.
 */
export function calcularBackoff(
  fallos: number,
  baseMs = DEFAULTS.backoffBaseMs,
  maxMs = DEFAULTS.backoffMaxMs,
  aleatorio: () => number = Math.random,
): number {
  if (fallos <= 0) return 0;
  const exponencial = Math.min(baseMs * 2 ** (fallos - 1), maxMs);
  const jitter = 1 + (aleatorio() - 0.5) * 0.4;
  return Math.round(Math.min(exponencial * jitter, maxMs));
}

/**
 * Motor de sincronización de una terminal.
 *
 * Deliberadamente NO usa `setInterval`: un intervalo fijo puede solapar corridas si una
 * tarda más que el periodo, y dos push simultáneos sobre el mismo outbox se pisan. Cada
 * ciclo agenda el siguiente al terminar.
 */
export class SyncEngine {
  private readonly opts: Required<Omit<EngineOptions, 'versionNodo' | 'now'>> & {
    versionNodo: string | undefined;
    now: () => number;
  };

  private estado: EngineState = {
    corriendo: false,
    ultimaSyncExitosa: null,
    outboxPendiente: 0,
    fallosConsecutivos: 0,
    esperaBackoffMs: 0,
    degradado: false,
    ultimoError: null,
    ciclosPush: 0,
    ciclosPull: 0,
  };

  private timerPush: NodeJS.Timeout | null = null;
  private timerPull: NodeJS.Timeout | null = null;
  private observadores: Observador[] = [];

  /** Evita que dos ciclos se solapen sobre el mismo outbox. */
  private pushEnCurso = false;
  private pullEnCurso = false;

  constructor(
    private readonly node: Client,
    private readonly cloud: Client,
    opts: EngineOptions = {},
  ) {
    this.opts = {
      pushIntervalMs: opts.pushIntervalMs ?? DEFAULTS.pushIntervalMs,
      pullIntervalMs: opts.pullIntervalMs ?? DEFAULTS.pullIntervalMs,
      batchSize: opts.batchSize ?? DEFAULTS.batchSize,
      staleThresholdMs: opts.staleThresholdMs ?? DEFAULTS.staleThresholdMs,
      backoffBaseMs: opts.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
      backoffMaxMs: opts.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
      versionNodo: opts.versionNodo,
      now: opts.now ?? Date.now,
    };
  }

  observar(fn: Observador): () => void {
    this.observadores.push(fn);
    return () => {
      this.observadores = this.observadores.filter((o) => o !== fn);
    };
  }

  private emitir(evento: EventoSync): void {
    for (const o of this.observadores) {
      // Un observador que lanza no puede tumbar el ciclo de sincronización: el tablero
      // de salud es un espectador, no un participante.
      try {
        o(evento);
      } catch { /* ignorado a propósito */ }
    }
  }

  get snapshot(): Readonly<EngineState> {
    return { ...this.estado };
  }

  /** Arranca los dos ciclos. Idempotente. */
  async iniciar(): Promise<void> {
    if (this.estado.corriendo) return;
    this.estado.corriendo = true;

    await this.recuperarUltimaSync();
    this.agendarPush(0);
    this.agendarPull(0);
  }

  /** Detiene los ciclos. No cancela una corrida en vuelo; espera a que termine. */
  async detener(): Promise<void> {
    this.estado.corriendo = false;
    if (this.timerPush) clearTimeout(this.timerPush);
    if (this.timerPull) clearTimeout(this.timerPull);
    this.timerPush = null;
    this.timerPull = null;

    while (this.pushEnCurso || this.pullEnCurso) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Dispara una subida inmediata, fuera de cadencia.
   *
   * Blueprint §3.3: "cada 5 s, **e inmediato tras una venta**". Que un boleto llegue a la
   * nube en el segundo siguiente y no en el quinto es lo que reduce la ventana en la que
   * otra sucursal podría vender el mismo asiento.
   */
  async pushInmediato(): Promise<PushResult | null> {
    return this.ejecutarPush();
  }

  /**
   * El nodo recuerda su última sincronización exitosa ENTRE REINICIOS.
   *
   * Sin esto, apagar y encender la PC reiniciaría el contador de antigüedad y el modo
   * degradado nunca se activaría en la sucursal que más lo necesita: la que lleva días
   * sin internet y se reinicia cada mañana.
   */
  private async recuperarUltimaSync(): Promise<void> {
    try {
      const { rows } = await this.node.query<{ ts: Date | null }>(
        `SELECT ultima_sync_exitosa AS ts FROM sync.salud
          WHERE sucursal_id = sync.sucursal_local()`,
      );
      this.estado.ultimaSyncExitosa = rows[0]?.ts ?? null;
    } catch {
      this.estado.ultimaSyncExitosa = null;
    }
    this.evaluarDegradacion();
  }

  private agendarPush(esperaMs: number): void {
    if (!this.estado.corriendo) return;
    this.timerPush = setTimeout(() => {
      void this.ejecutarPush().finally(() => {
        this.agendarPush(this.esperaSiguientePush());
      });
    }, esperaMs);
  }

  private agendarPull(esperaMs: number): void {
    if (!this.estado.corriendo) return;
    this.timerPull = setTimeout(() => {
      void this.ejecutarPull().finally(() => {
        this.agendarPull(this.esperaSiguientePull());
      });
    }, esperaMs);
  }

  private esperaSiguientePush(): number {
    return this.estado.fallosConsecutivos > 0
      ? this.estado.esperaBackoffMs
      : this.opts.pushIntervalMs;
  }

  private esperaSiguientePull(): number {
    return this.estado.fallosConsecutivos > 0
      ? Math.max(this.estado.esperaBackoffMs, this.opts.pullIntervalMs)
      : this.opts.pullIntervalMs;
  }

  private async ejecutarPush(): Promise<PushResult | null> {
    if (this.pushEnCurso) return null;
    this.pushEnCurso = true;

    try {
      const opts: Parameters<typeof push>[2] = { batchSize: this.opts.batchSize };
      if (this.opts.versionNodo !== undefined) opts.versionNodo = this.opts.versionNodo;

      const resultado = await push(this.node, this.cloud, opts);
      this.estado.ciclosPush++;
      this.estado.outboxPendiente = await outboxPendiente(this.node);
      this.registrarExito();
      this.emitir({ tipo: 'push_ok', resultado });
      return resultado;
    } catch (err) {
      this.registrarFallo('push', err);
      return null;
    } finally {
      this.pushEnCurso = false;
    }
  }

  private async ejecutarPull(): Promise<PullResult | null> {
    if (this.pullEnCurso) return null;
    this.pullEnCurso = true;

    try {
      const resultado = await pull(this.node, this.cloud, { batchSize: this.opts.batchSize });
      this.estado.ciclosPull++;
      this.registrarExito();
      this.emitir({ tipo: 'pull_ok', resultado });
      return resultado;
    } catch (err) {
      this.registrarFallo('pull', err);
      return null;
    } finally {
      this.pullEnCurso = false;
    }
  }

  private registrarExito(): void {
    const veniaFallando = this.estado.fallosConsecutivos;

    this.estado.ultimaSyncExitosa = new Date(this.opts.now());
    this.estado.fallosConsecutivos = 0;
    this.estado.esperaBackoffMs = 0;
    this.estado.ultimoError = null;

    if (veniaFallando > 0) this.emitir({ tipo: 'recuperado', trasFallos: veniaFallando });
    this.evaluarDegradacion();
    void this.persistirSalud();
  }

  private registrarFallo(fase: 'push' | 'pull', err: unknown): void {
    this.estado.fallosConsecutivos++;
    this.estado.ultimoError = err instanceof Error ? err.message : String(err);
    this.estado.esperaBackoffMs = calcularBackoff(
      this.estado.fallosConsecutivos,
      this.opts.backoffBaseMs,
      this.opts.backoffMaxMs,
    );

    this.evaluarDegradacion();
    this.emitir({
      tipo: 'fallo',
      fase,
      error: this.estado.ultimoError,
      esperaMs: this.estado.esperaBackoffMs,
    });
  }

  /**
   * Stale-guard (Blueprint 03 §1.5, SUPUESTO S9: 72 h).
   *
   * Entrar en modo degradado NO detiene la venta — D1 es innegociable y la agencia no
   * puede parar porque falle el internet. Lo que hace es encender el banner permanente y
   * habilitar las restricciones que el resto del sistema consulta: se prohíben overrides
   * de asiento fuera de cupo y cambios de conductor incompatibles, porque el arbitraje
   * sería a ciegas.
   *
   * Un nodo que NUNCA ha sincronizado (recién instalado) no se considera degradado: no
   * está atrasado, está empezando.
   */
  private evaluarDegradacion(): void {
    const antes = this.estado.degradado;
    const ultima = this.estado.ultimaSyncExitosa;

    this.estado.degradado =
      ultima !== null && this.opts.now() - ultima.getTime() > this.opts.staleThresholdMs;

    if (this.estado.degradado && !antes) {
      this.emitir({ tipo: 'degradado', desde: ultima });
    }
  }

  /**
   * Publica el estado en `sync.salud`.
   *
   * Es la herramienta de diagnóstico remoto: con las sucursales a 3-6 horas y solo
   * TeamViewer en la madrugada, saber desde el tablero que una terminal lleva 40 h sin
   * subir es la diferencia entre detectarlo y enterarse en el corte de mes.
   *
   * Nunca lanza: un fallo al escribir la salud no debe tumbar la sincronización, que es
   * lo que de verdad importa.
   */
  private async persistirSalud(): Promise<void> {
    try {
      await this.node.query(
        `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa, outbox_pendiente,
                                 version_binario, reportado_en)
         VALUES (sync.sucursal_local(), $1, $2, $3, now())
         ON CONFLICT (sucursal_id) DO UPDATE
            SET ultima_sync_exitosa = EXCLUDED.ultima_sync_exitosa,
                outbox_pendiente    = EXCLUDED.outbox_pendiente,
                version_binario     = EXCLUDED.version_binario,
                reportado_en        = now()`,
        [this.estado.ultimaSyncExitosa, this.estado.outboxPendiente, this.opts.versionNodo ?? null],
      );
    } catch { /* la salud es observabilidad, no operación */ }
  }
}
