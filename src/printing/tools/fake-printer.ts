/**
 * Impresora térmica falsa: escucha en TCP 9100 y vuelca lo que reciba.
 *
 * Sirve para desarrollar y probar la capa ESC/POS completa sin la Enduro enfrente. La
 * PoC de F0 con hardware real deja de ser un descubrimiento y pasa a ser una
 * verificación de lo que ya funciona contra este servidor.
 *
 *   npm run printer:fake -- --port 9100
 */

import net from 'node:net';
import { decodeText } from '../escpos/codepage.js';
import { stripCommandsRaw } from '../transport/capture.js';

const args = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const port = Number(readArg('port', '9100'));
const host = readArg('host', '127.0.0.1');

function hexdump(buf: Buffer, width = 16): string {
  const lines: string[] = [];
  for (let off = 0; off < buf.length; off += width) {
    const slice = buf.subarray(off, off + width);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(width * 3 - 1)}  |${ascii}|`);
  }
  return lines.join('\n');
}

/** Resume qué comandos ESC/POS aparecieron, para verificar que se emitió lo esperado. */
function summarize(buf: Buffer): string[] {
  const found: string[] = [];
  const has = (...seq: number[]): boolean => buf.includes(Buffer.from(seq));
  if (has(0x1b, 0x40)) found.push('ESC @   init');
  if (has(0x1b, 0x74)) found.push('ESC t   code page');
  if (has(0x1d, 0x28, 0x6b)) found.push('GS ( k  QR nativo');
  if (has(0x1d, 0x76, 0x30)) found.push('GS v 0  raster');
  if (has(0x1d, 0x56)) found.push('GS V    corte');
  return found;
}

const server = net.createServer((socket) => {
  const chunks: Buffer[] = [];
  const from = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n=== conexión de ${from} ===`);

  socket.on('data', (d) => chunks.push(d));

  socket.on('close', () => {
    const buf = Buffer.concat(chunks);
    console.log(`--- ${buf.length} bytes recibidos ---`);
    console.log(hexdump(buf));
    console.log('--- comandos detectados ---');
    for (const c of summarize(buf)) console.log(`  ${c}`);
    console.log('--- texto imprimible (papel simulado) ---');
    console.log(decodeText(stripCommandsRaw(buf)));
    console.log('=== fin ===\n');
  });

  socket.on('error', (err) => console.error(`error en ${from}:`, err.message));
});

server.listen(port, host, () => {
  console.log(`Impresora falsa escuchando en ${host}:${port} (Ctrl+C para salir)`);
});
