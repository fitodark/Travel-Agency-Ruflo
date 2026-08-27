/**
 * Comandos ESC/POS crudos.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.3
 *
 * Este módulo produce bytes y nada más: no conoce plantillas ni transportes.
 * Referencia: especificación ESC/POS de Epson, que la Enduro implementa como
 * compatible (a verificar en la PoC de F0).
 */

import { CODE_PAGE_SELECTOR, encodeText, type CodePageName } from './codepage.js';

export const ESC = 0x1b;
export const GS = 0x1d;

export type Align = 'left' | 'center' | 'right';

const ALIGN_CODE: Record<Align, number> = { left: 0, center: 1, right: 2 };

/** `ESC @` — reinicia la impresora: limpia estilos, alineación y buffer. */
export const init = (): Buffer => Buffer.from([ESC, 0x40]);

/** `ESC t n` — selecciona code page. */
export const selectCodePage = (page: CodePageName): Buffer =>
  Buffer.from([ESC, 0x74, CODE_PAGE_SELECTOR[page]]);

/** `ESC a n` — alineación. */
export const align = (a: Align): Buffer => Buffer.from([ESC, 0x61, ALIGN_CODE[a]]);

/** `ESC E n` — negritas. */
export const bold = (on: boolean): Buffer => Buffer.from([ESC, 0x45, on ? 1 : 0]);

/** `ESC - n` — subrayado (0 = off, 1 = 1 punto, 2 = 2 puntos). */
export const underline = (dots: 0 | 1 | 2): Buffer => Buffer.from([ESC, 0x2d, dots]);

/**
 * `GS ! n` — tamaño de carácter. Ancho y alto se multiplican por separado (1..8).
 * El byte combina ancho en el nibble alto y alto en el nibble bajo.
 */
export function textSize(width: number, height: number): Buffer {
  const w = Math.min(Math.max(width, 1), 8) - 1;
  const h = Math.min(Math.max(height, 1), 8) - 1;
  return Buffer.from([GS, 0x21, (w << 4) | h]);
}

/** `ESC M n` — fuente A (0, 48 col en 80 mm) o B (1, 64 col). */
export const font = (which: 'A' | 'B'): Buffer =>
  Buffer.from([ESC, 0x4d, which === 'A' ? 0 : 1]);

/** `ESC d n` — avanza n líneas. */
export const feed = (lines: number): Buffer =>
  Buffer.from([ESC, 0x64, Math.min(Math.max(lines, 0), 255)]);

/**
 * `GS V 66 n` — corte parcial tras avanzar n puntos.
 *
 * Se prefiere el corte parcial al total: deja una pestaña de papel unida que evita que
 * el ticket caiga al suelo antes de que el vendedor lo tome.
 */
export const cut = (feedDots = 3): Buffer =>
  Buffer.from([GS, 0x56, 66, Math.min(Math.max(feedDots, 0), 255)]);

/** Texto codificado a la code page activa. */
export const text = (s: string, page: CodePageName = 'CP858'): Buffer =>
  encodeText(s, page);

/** `GS r n` — solicita estado (n=1 transmite estado de papel). Usado por `probe()`. */
export const requestStatus = (): Buffer => Buffer.from([GS, 0x72, 1]);

// ---------------------------------------------------------------------------
// QR nativo — GS ( k, funciones 165 / 167 / 169 / 180 / 181
// ---------------------------------------------------------------------------

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

const EC_CODE: Record<QrErrorCorrection, number> = { L: 48, M: 49, Q: 50, H: 51 };

/** fn 165 — modelo de símbolo (49 = modelo 1, 50 = modelo 2, 51 = micro QR). */
export const qrModel = (model: 1 | 2 = 2): Buffer =>
  Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, model === 1 ? 49 : 50, 0x00]);

/** fn 167 — tamaño de módulo en puntos (1..16). */
export const qrModuleSize = (size: number): Buffer =>
  Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(Math.max(size, 1), 16)]);

/** fn 169 — nivel de corrección de error. */
export const qrErrorCorrection = (level: QrErrorCorrection): Buffer =>
  Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, EC_CODE[level]]);

/**
 * fn 180 — almacena los datos en el buffer de símbolo.
 *
 * `pL`/`pH` cuentan los datos MÁS los 3 bytes de cabecera (`31 50 30`), que es el
 * error de implementación más común de este comando.
 */
export function qrStore(data: Buffer): Buffer {
  const len = data.length + 3;
  if (len > 0xffff) throw new RangeError('QR: datos demasiado largos para GS ( k');
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;
  return Buffer.concat([
    Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
    data,
  ]);
}

/** fn 181 — imprime el símbolo almacenado. */
export const qrPrint = (): Buffer =>
  Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);

export interface QrOptions {
  moduleSize?: number;
  errorCorrection?: QrErrorCorrection;
  model?: 1 | 2;
}

/**
 * Secuencia completa de QR nativo.
 *
 * El texto del QR es ASCII por construcción (ver `qr-text.ts`), así que se codifica
 * como latin1 sin pasar por la tabla de code page: lo que se escanea debe ser
 * byte-por-byte lo que se generó, no una versión transcodificada.
 */
export function qrNative(payload: string, opts: QrOptions = {}): Buffer {
  return Buffer.concat([
    qrModel(opts.model ?? 2),
    qrModuleSize(opts.moduleSize ?? 6),
    qrErrorCorrection(opts.errorCorrection ?? 'M'),
    qrStore(Buffer.from(payload, 'latin1')),
    qrPrint(),
  ]);
}

// ---------------------------------------------------------------------------
// Raster — GS v 0, fallback cuando la impresora no soporta QR nativo
// ---------------------------------------------------------------------------

/** Matriz booleana cuadrada: `true` = módulo negro. */
export type BitMatrix = readonly (readonly boolean[])[];

/**
 * `GS v 0 m xL xH yL yH d1...dk` — imprime un mapa de bits.
 *
 * Cada byte cubre 8 píxeles horizontales, bit más significativo a la izquierda.
 * `scale` repite cada módulo N veces en ambos ejes: sin esto, un QR de 33 módulos
 * mide 4 mm en papel y ningún lector lo lee.
 */
export function rasterBitmap(matrix: BitMatrix, scale = 4): Buffer {
  const rows = matrix.length;
  if (rows === 0) return Buffer.alloc(0);
  const cols = matrix[0]!.length;

  const width = cols * scale;
  const height = rows * scale;
  const bytesPerRow = Math.ceil(width / 8);
  const data = Buffer.alloc(bytesPerRow * height, 0);

  for (let y = 0; y < height; y++) {
    const srcRow = matrix[Math.floor(y / scale)]!;
    for (let x = 0; x < width; x++) {
      if (!srcRow[Math.floor(x / scale)]) continue;
      const idx = y * bytesPerRow + (x >> 3);
      data[idx] = data[idx]! | (0x80 >> (x & 7));
    }
  }

  return Buffer.concat([
    Buffer.from([
      GS, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
    ]),
    data,
  ]);
}
