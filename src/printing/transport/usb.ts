/**
 * Transporte alternativo: USB a través de la cola de impresión de Windows en modo RAW.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.1
 *
 * P2 ofreció USB como alternativa porque la impresora está junto a la PC. Existe desde
 * F0 y no "por si acaso": tenerlo probado convierte un problema de campo (la IP fija de
 * la impresora dando guerra en una sucursal) en un cambio de configuración.
 *
 * En Windows una térmica USB se expone como cola de impresión. Mandarle ESC/POS por el
 * driver lo reinterpretaría como texto y destruiría los comandos, así que se escribe con
 * datatype RAW vía `winspool.drv` (ver `raw-print.ps1`).
 *
 * A DIFERENCIA de TCP, este transporte acumula en memoria y entrega el documento
 * completo en `close()`: la cola de Windows es orientada a documento, no a flujo, y
 * partir un ticket en varios trabajos produciría varios cortes de papel.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TransportError, type EscPosTransport, type ProbeResult } from './types.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'raw-print.ps1');

export interface UsbTransportOptions {
  /** Nombre exacto de la cola en Windows, tal como aparece en Impresoras y escáneres. */
  printerName: string;
  timeoutMs?: number;
}

export class UsbTransport implements EscPosTransport {
  readonly kind = 'usb' as const;
  readonly label: string;

  private chunks: Buffer[] = [];
  private opened = false;
  private readonly printerName: string;
  private readonly timeoutMs: number;

  constructor(opts: UsbTransportOptions) {
    this.printerName = opts.printerName;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.label = `usb://${this.printerName}`;
  }

  async open(): Promise<void> {
    this.chunks = [];
    this.opened = true;
  }

  async write(bytes: Buffer): Promise<void> {
    if (!this.opened) throw new TransportError('write() sin open() previo', 'usb');
    this.chunks.push(Buffer.from(bytes));
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;

    const payload = Buffer.concat(this.chunks);
    this.chunks = [];
    if (payload.length === 0) return;

    const dir = await mkdtemp(path.join(tmpdir(), 'donaji-print-'));
    const file = path.join(dir, 'job.bin');
    try {
      await writeFile(file, payload);
      await this.runScript(['-PrinterName', this.printerName, '-FilePath', file]);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => { /* temp */ });
    }
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      await this.runScript(['-PrinterName', this.printerName, '-Probe']);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private runScript(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
        { windowsHide: true },
      );

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        reject(new TransportError(`Timeout tras ${this.timeoutMs} ms en ${this.label}`, 'usb'));
      }, this.timeoutMs);

      child.once('error', (err) => {
        clearTimeout(timer);
        reject(new TransportError(`No se pudo invocar PowerShell`, 'usb', err));
      });

      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new TransportError(`RAW print falló (código ${code}): ${stderr.trim()}`, 'usb'));
      });
    });
  }
}
