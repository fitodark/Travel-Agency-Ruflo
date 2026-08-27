/**
 * Transporte en memoria: captura los bytes en vez de imprimirlos.
 *
 * Es lo que permite tener la capa ESC/POS cubierta por pruebas sin la Enduro física
 * enfrente, y lo que hace que la PoC de F0 con hardware sea una verificación y no un
 * descubrimiento.
 */

import type { EscPosTransport, ProbeResult } from './types.js';

export class CaptureTransport implements EscPosTransport {
  readonly kind = 'capture' as const;
  readonly label = 'captura en memoria';

  private chunks: Buffer[] = [];
  private opened = false;
  private closed = false;

  async open(): Promise<void> {
    this.opened = true;
    this.closed = false;
  }

  async write(bytes: Buffer): Promise<void> {
    if (!this.opened || this.closed) {
      throw new Error('CaptureTransport: write() sin open() previo');
    }
    this.chunks.push(Buffer.from(bytes));
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, latencyMs: 0 };
  }

  /** Todo lo escrito, concatenado. */
  get buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Texto imprimible, con los comandos de control retirados. Para aserciones legibles. */
  get plainText(): string {
    return stripCommands(this.buffer);
  }

  reset(): void {
    this.chunks = [];
  }
}

/**
 * Retira secuencias de control ESC/POS y devuelve solo el texto.
 *
 * Es una aproximación deliberada: reconoce los comandos que este código emite, no la
 * especificación completa. Sirve para pruebas y para el volcado legible del hexdump,
 * nunca para interpretar salida de una impresora real.
 */
export function stripCommands(buf: Buffer): string {
  return stripCommandsRaw(buf).toString('latin1');
}

/**
 * Igual que `stripCommands` pero devuelve los BYTES del texto, sin interpretarlos.
 *
 * Necesario para previsualizar: los bytes están en la code page de la impresora, así que
 * hay que pasarlos por `decodeText` y no por una conversión latin1, que mostraría acentos
 * incorrectos sobre un ticket perfectamente bien codificado.
 */
export function stripCommandsRaw(buf: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;

  while (i < buf.length) {
    const b = buf[i]!;

    if (b === 0x1b) {
      const cmd = buf[i + 1];
      // ESC @ no lleva parámetros; el resto de los que emitimos llevan uno.
      i += cmd === 0x40 ? 2 : 3;
      continue;
    }

    if (b === 0x1d) {
      const cmd = buf[i + 1];
      if (cmd === 0x28 && buf[i + 2] === 0x6b) {
        // GS ( k — longitud en pL/pH tras el prefijo de 3 bytes.
        const pL = buf[i + 3] ?? 0;
        const pH = buf[i + 4] ?? 0;
        i += 5 + ((pH << 8) | pL);
        continue;
      }
      if (cmd === 0x76 && buf[i + 2] === 0x30) {
        // GS v 0 — cabecera de 8 bytes + bytesPerRow * height.
        const bytesPerRow = (buf[i + 5]! << 8) | buf[i + 4]!;
        const height = (buf[i + 7]! << 8) | buf[i + 6]!;
        i += 8 + bytesPerRow * height;
        continue;
      }
      if (cmd === 0x56) {
        i += buf[i + 2] === 66 ? 4 : 3;
        continue;
      }
      i += 3; // GS ! n, GS r n
      continue;
    }

    out.push(b);
    i++;
  }

  return Buffer.from(out);
}
