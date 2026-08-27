/**
 * Transcodificación a code page de impresora térmica.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.3
 *
 * Los nombres de pasajero llevan acentos y `ñ`. Una térmica NO habla UTF-8: interpreta
 * cada byte según la code page seleccionada con `ESC t n`. Mandar UTF-8 crudo produce
 * los caracteres basura que el documento marca como la fuente #1 de tickets defectuosos.
 *
 * Por defecto CP858 (CP850 + símbolo de euro), que cubre el español completo.
 * El valor de `n` para `ESC t` varía entre fabricantes: se verifica con la Enduro
 * física en F0 y queda en `config_impresora.code_page`.
 */

export type CodePageName = 'CP437' | 'CP850' | 'CP858';

/** Valor de `n` en `ESC t n` por code page (valores Epson estándar). */
export const CODE_PAGE_SELECTOR: Record<CodePageName, number> = {
  CP437: 0,
  CP850: 2,
  CP858: 19,
};

/**
 * Mapa Unicode → byte para el rango que nos importa (español).
 * CP850 y CP858 comparten estas posiciones; CP437 difiere en varias, por eso se
 * declara por separado.
 */
const CP850_858: ReadonlyMap<string, number> = new Map<string, number>([
  ['á', 0xa0], ['é', 0x82], ['í', 0xa1], ['ó', 0xa2], ['ú', 0xa3],
  ['Á', 0xb5], ['É', 0x90], ['Í', 0xd6], ['Ó', 0xe0], ['Ú', 0xe9],
  ['ñ', 0xa4], ['Ñ', 0xa5],
  ['ü', 0x81], ['Ü', 0x9a],
  ['¿', 0xa8], ['¡', 0xad],
  ['°', 0xf8], ['ª', 0xa6], ['º', 0xa7],
  ['«', 0xae], ['»', 0xaf],
  ['€', 0xd5], // solo CP858
]);

const CP437: ReadonlyMap<string, number> = new Map<string, number>([
  ['á', 0xa0], ['é', 0x82], ['í', 0xa1], ['ó', 0xa2], ['ú', 0xa3],
  ['ñ', 0xa4], ['Ñ', 0xa5],
  ['ü', 0x81], ['Ü', 0x9a],
  ['¿', 0xa8], ['¡', 0xad],
  ['°', 0xf8], ['ª', 0xa6], ['º', 0xa7],
  // CP437 NO tiene Á É Í Ó Ú mayúsculas acentuadas: caen al degradado ASCII.
]);

/** Degradado sin acentos, último recurso antes de imprimir un `?`. */
const ASCII_FOLD: ReadonlyMap<string, string> = new Map<string, string>([
  ['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u'],
  ['Á', 'A'], ['É', 'E'], ['Í', 'I'], ['Ó', 'O'], ['Ú', 'U'],
  ['ñ', 'n'], ['Ñ', 'N'], ['ü', 'u'], ['Ü', 'U'],
  ['¿', '?'], ['¡', '!'], ['°', 'o'], ['€', 'E'],
]);

/**
 * Codifica texto a bytes de la code page indicada.
 *
 * Estrategia por carácter, en orden:
 *   1. ASCII imprimible (0x20–0x7E) → tal cual.
 *   2. Presente en la tabla de la code page → su byte.
 *   3. Degradable a ASCII → se degrada (mejor "Nunez" que "NuÃ±ez").
 *   4. Cualquier otra cosa → '?' (0x3F).
 *
 * Nunca lanza: un nombre exótico no debe impedir que salga el boleto.
 */
export function encodeText(text: string, page: CodePageName = 'CP858'): Buffer {
  const table = page === 'CP437' ? CP437 : CP850_858;
  const out: number[] = [];

  for (const ch of text) {
    const code = ch.codePointAt(0)!;

    if (code >= 0x20 && code <= 0x7e) {
      out.push(code);
      continue;
    }
    if (ch === '\n') {
      out.push(0x0a);
      continue;
    }

    const mapped = table.get(ch);
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }

    const folded = ASCII_FOLD.get(ch);
    if (folded !== undefined) {
      for (const f of folded) out.push(f.charCodeAt(0));
      continue;
    }

    out.push(0x3f); // '?'
  }

  return Buffer.from(out);
}

/**
 * Longitud en columnas de impresión.
 *
 * Distinta de `string.length`: un carácter acentuado ocupa 1 columna aunque en UTF-16
 * pueda ser más de una unidad. Se usa para alinear y truncar sin descuadrar el ticket.
 */
export function columnWidth(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * Decodifica bytes de code page de vuelta a Unicode.
 *
 * Inverso de `encodeText`, exclusivamente para PREVISUALIZAR: la impresora falsa y los
 * volcados de diagnóstico. Sin esto, un ticket correctamente codificado en CP858 se ve
 * como basura en la consola (0xA2 es `ó` en CP858 pero `¢` en latin1) y parece un bug
 * donde no lo hay — justo el falso positivo que costaría tiempo en la PoC de F0.
 */
export function decodeText(bytes: Buffer, page: CodePageName = 'CP858'): string {
  const table = page === 'CP437' ? CP437 : CP850_858;
  const reverse = new Map<number, string>();
  for (const [ch, byte] of table) if (!reverse.has(byte)) reverse.set(byte, ch);

  let out = '';
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else if (b === 0x0a) out += '\n';
    else out += reverse.get(b) ?? '\ufffd';
  }
  return out;
}
