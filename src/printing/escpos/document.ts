/**
 * Constructor de documentos ESC/POS.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.3
 *
 * Compone bytes con helpers de maquetación en columnas. Ninguna plantilla asume el
 * ancho: se toma de `config_impresora.ancho_cols` (48 en fuente A a 80 mm, 64 en
 * fuente B), así que cambiar a papel de 58 mm es cambiar un número, no reescribir.
 */

import { columnWidth } from './codepage.js';
import type { CodePageName } from './codepage.js';
import * as cmd from './commands.js';
import type { Align, QrOptions } from './commands.js';

export interface DocumentOptions {
  cols?: number;
  codePage?: CodePageName;
}

export class EscPosDocument {
  private readonly chunks: Buffer[] = [];
  readonly cols: number;
  readonly codePage: CodePageName;

  constructor(opts: DocumentOptions = {}) {
    this.cols = opts.cols ?? 48;
    this.codePage = opts.codePage ?? 'CP858';
    this.raw(cmd.init());
    this.raw(cmd.selectCodePage(this.codePage));
  }

  raw(bytes: Buffer): this {
    this.chunks.push(bytes);
    return this;
  }

  align(a: Align): this { return this.raw(cmd.align(a)); }
  bold(on: boolean): this { return this.raw(cmd.bold(on)); }
  size(w: number, h: number): this { return this.raw(cmd.textSize(w, h)); }
  font(which: 'A' | 'B'): this { return this.raw(cmd.font(which)); }
  feed(n = 1): this { return this.raw(cmd.feed(n)); }
  cut(feedDots = 3): this { return this.raw(cmd.cut(feedDots)); }

  /** Texto sin salto de línea. */
  text(s: string): this { return this.raw(cmd.text(s, this.codePage)); }

  /** Texto con salto de línea, truncado al ancho para no descuadrar la maqueta. */
  line(s = ''): this {
    return this.text(`${truncate(s, this.cols)}\n`);
  }

  /** Línea de separación (por defecto guiones, ancho completo). */
  divider(ch = '-'): this {
    return this.line(ch.repeat(this.cols));
  }

  /**
   * Etiqueta a la izquierda, valor a la derecha, rellenando con puntos.
   *
   * Si no caben, se trunca la ETIQUETA y no el valor: en un boleto el importe y el
   * número de asiento son lo que no se puede perder.
   */
  twoCol(label: string, value: string, filler = ' '): this {
    const v = truncate(value, this.cols);
    const room = this.cols - columnWidth(v);
    const l = truncate(label, Math.max(room - 1, 0));
    const gap = Math.max(room - columnWidth(l), 0);
    return this.line(`${l}${filler.repeat(gap)}${v}`);
  }

  /** Envuelve texto largo en varias líneas respetando palabras. */
  wrap(s: string): this {
    for (const l of wrapText(s, this.cols)) this.line(l);
    return this;
  }

  /** Bloque centrado y en negritas, para títulos. */
  title(s: string): this {
    return this.align('center').bold(true).line(s).bold(false).align('left');
  }

  /** QR nativo (`GS ( k`). Requiere `soporta_qr_nativo` en la configuración. */
  qrNative(payload: string, opts?: QrOptions): this {
    return this.align('center').raw(cmd.qrNative(payload, opts)).align('left');
  }

  /** QR por raster (`GS v 0`) para impresoras sin QR nativo. */
  qrRaster(matrix: cmd.BitMatrix, scale = 4): this {
    return this.align('center').raw(cmd.rasterBitmap(matrix, scale)).align('left');
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export function truncate(s: string, cols: number): string {
  if (cols <= 0) return '';
  if (columnWidth(s) <= cols) return s;
  return [...s].slice(0, cols).join('');
}

export function wrapText(s: string, cols: number): string[] {
  const lines: string[] = [];
  for (const paragraph of s.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (columnWidth(candidate) <= cols) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = columnWidth(word) > cols ? truncate(word, cols) : word;
      }
    }
    lines.push(current);
  }
  return lines;
}
