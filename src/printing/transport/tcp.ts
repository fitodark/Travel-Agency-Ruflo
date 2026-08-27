/**
 * Transporte primario: socket TCP crudo al puerto 9100 (RAW / JetDirect).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.1
 *
 * Viable porque P2 confirmó que la impresora tiene IP fija por su propia
 * configuración. La IP de la PC puede seguir en DHCP: hoy todo vive en `localhost`
 * (D-1) y el nodo es quien inicia la conexión.
 */

import net from 'node:net';
import { TransportError, type EscPosTransport, type ProbeResult } from './types.js';

export interface TcpTransportOptions {
  host: string;
  port?: number;
  /** Timeout de conexión y de escritura. Una térmica en LAN responde en decenas de ms. */
  timeoutMs?: number;
}

export class TcpTransport implements EscPosTransport {
  readonly kind = 'tcp' as const;
  readonly label: string;

  private socket: net.Socket | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(opts: TcpTransportOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 9100;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.label = `tcp://${this.host}:${this.port}`;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(this.timeoutMs);

      const fail = (err: unknown): void => {
        socket.destroy();
        this.socket = null;
        reject(new TransportError(`No se pudo conectar a ${this.label}`, 'tcp', err));
      };

      socket.once('error', fail);
      socket.once('timeout', () => fail(new Error(`timeout tras ${this.timeoutMs} ms`)));

      socket.connect(this.port, this.host, () => {
        socket.removeListener('error', fail);
        // Una vez conectados, un error deja de ser de conexión: se propaga en write().
        socket.on('error', () => { /* manejado por write/close */ });
        this.socket = socket;
        resolve();
      });
    });
  }

  write(bytes: Buffer): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new TransportError('write() sin open() previo', 'tcp'));
    }

    return new Promise((resolve, reject) => {
      socket.write(bytes, (err) => {
        if (err) reject(new TransportError(`Fallo al escribir en ${this.label}`, 'tcp', err));
        else resolve();
      });
    });
  }

  close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return Promise.resolve();

    return new Promise((resolve) => {
      // `end()` vacía el buffer de salida antes de cerrar: cortar antes perdería el
      // final del ticket, que es justamente donde va el corte de papel.
      socket.end(() => {
        socket.destroy();
        resolve();
      });
    });
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      await this.open();
      await this.close();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
