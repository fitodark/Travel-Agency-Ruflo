/**
 * Diagnóstico de impresoras: qué hay conectado y por dónde responde. NO imprime nada.
 *
 * Existe para el soporte remoto. Las terminales están a 3-6 horas de distancia y quien
 * está frente al equipo es un vendedor, no un técnico: hay que poder distinguir por
 * teléfono entre "la impresora está apagada", "está encendida pero no escucha el puerto
 * de impresión" y "la cola de Windows no existe", sin gastar papel ni pedirle a nadie
 * que interprete un mensaje de error.
 *
 *   npm run printer:probe                          sondea las colas de Windows
 *   npm run printer:probe -- --host 192.168.1.110  sondea además una IP por TCP 9100
 */

import net from 'node:net';
import { UsbTransport } from '../transport/usb.js';
import type { ProbeResult } from '../transport/types.js';

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : undefined;
};

/** Conexión TCP cruda sin enviar un solo byte. */
function probeTcp(host: string, port: number, timeoutMs = 4000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;

    const end = (ok: boolean, detail?: string): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - started, ...(detail ? { detail } : {}) });
    };

    socket.setTimeout(timeoutMs);
    socket.once('error', (err: NodeJS.ErrnoException) => end(false, err.code ?? err.message));
    socket.once('timeout', () => end(false, `sin respuesta en ${timeoutMs} ms`));
    socket.connect(port, host, () => end(true, 'acepta conexión'));
  });
}

/**
 * Traduce el estado numérico de `Get-Printer`.
 *
 * `ConvertTo-Json` serializa el enum como número, no como texto: una cola en error sale
 * como `6`, no como "Error, PendingDeletion". Sin esta traducción el filtro de más abajo
 * daría por buena una cola que Windows está borrando, y el diagnóstico diría "OK" sobre
 * una impresora que no va a imprimir.
 */
function describeStatus(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const code = Number(raw);
  if (!Number.isFinite(code)) return 'desconocido';

  const banderas: [number, string][] = [
    [0x00001, 'en pausa'],
    [0x00002, 'error'],
    [0x00004, 'eliminándose'],
    [0x00008, 'atascada'],
    [0x00010, 'sin papel'],
    [0x00080, 'sin conexión'],
    [0x00400, 'sin tóner'],
    [0x00800, 'requiere atención'],
  ];

  const activas = banderas.filter(([bit]) => (code & bit) !== 0).map(([, texto]) => texto);
  if (activas.length === 0) return code === 0 ? 'normal' : `código ${code}`;
  return activas.join(', ');
}

/** Colas de impresión de Windows, con su puerto y estado. */
async function colasWindows(): Promise<{ name: string; port: string; status: string }[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  try {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-Printer | Select-Object Name,PortName,PrinterStatus | ConvertTo-Json -Compress',
    ], { windowsHide: true });

    const parsed: unknown = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => {
      const o = p as Record<string, unknown>;
      return {
        name: String(o['Name'] ?? ''),
        port: String(o['PortName'] ?? ''),
        status: describeStatus(o['PrinterStatus']),
      };
    });
  } catch {
    return [];
  }
}

const linea = (etiqueta: string, r: ProbeResult): string =>
  `   ${r.ok ? 'OK   ' : 'FALLA'} ${etiqueta.padEnd(26)} (${r.latencyMs} ms) ${r.detail ?? ''}`;

async function main(): Promise<void> {
  const colas = await colasWindows();

  console.log('Colas de impresión de Windows');
  if (colas.length === 0) {
    console.log('   (ninguna, o no se pudo consultar)');
  }
  for (const c of colas) {
    console.log(`   ${c.name.padEnd(30)} puerto=${c.port.padEnd(16)} estado=${c.status}`);
  }

  // Solo las térmicas plausibles: mandarle ESC/POS a "Microsoft Print to PDF" no
  // aporta nada y confunde la salida.
  const termicas = colas.filter(
    (c) => /xp-?\d|enduro|pos|thermal|term/i.test(c.name) && !/eliminándose|error/i.test(c.status),
  );

  if (termicas.length > 0) {
    console.log('\nSonda de colas térmicas (no imprime)');
    for (const c of termicas) {
      const r = await new UsbTransport({ printerName: c.name, timeoutMs: 20000 }).probe();
      console.log(linea(c.name, r));
    }
  }

  const host = value('host');
  if (host) {
    const port = Number(value('port') ?? '9100');
    console.log(`\nSonda de red (no imprime)`);
    console.log(linea(`${host}:${port}`, await probeTcp(host, port)));
  }

  console.log('\nEsto NO verifica que imprima: solo que el camino está abierto.');
  console.log('Para el ticket real: npm run printer:poc -- --transport tcp --host <IP>');
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
