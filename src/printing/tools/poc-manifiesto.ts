/**
 * PoC de impresión del manifiesto: renderiza una salida real y la manda por el
 * transporte elegido, SIN tocar `core.print_job`.
 *
 *   npm run printer:poc-manifiesto -- --salida <uuid>
 *   npm run printer:poc-manifiesto -- --salida <uuid> --copia conductor
 *   npm run printer:poc-manifiesto -- --salida <uuid> --transport tcp --host 1.2.3.4
 *
 * Por defecto captura en memoria y vuelca el papel simulado: es la forma de ver
 * la maqueta contra datos reales mientras la Enduro no está instalada. Con
 * `--transport tcp|usb` es la verificación física del criterio de aceptación de
 * F5 (manifiesto correcto por ambos transportes).
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../db/connection.js';
import { datosManifiesto, type CopiaManifiesto } from '../../fleet/manifiesto.js';
import { renderManifiesto, type DatosManifiesto } from '../templates/manifiesto.js';
import { decodeText } from '../escpos/codepage.js';
import { CaptureTransport, stripCommandsRaw } from '../transport/capture.js';
import { TcpTransport } from '../transport/tcp.js';
import { UsbTransport } from '../transport/usb.js';
import type { EscPosTransport } from '../transport/types.js';

const args = process.argv.slice(2);
const readArg = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

function crearTransporte(): EscPosTransport {
  switch (readArg('transport', 'capture')) {
    case 'tcp': {
      const host = readArg('host');
      if (!host) throw new Error('--transport tcp requiere --host');
      return new TcpTransport({ host, port: Number(readArg('port', '9100')) });
    }
    case 'usb': {
      const printerName = readArg('printer');
      if (!printerName) throw new Error('--transport usb requiere --printer "NOMBRE DE LA COLA"');
      return new UsbTransport({ printerName });
    }
    default:
      return new CaptureTransport();
  }
}

async function main(): Promise<void> {
  const salidaId = readArg('salida');
  if (!salidaId) throw new Error('falta --salida <uuid>');
  const copia = (readArg('copia', 'terminal') as CopiaManifiesto);
  const cols = Number(readArg('cols', '48'));

  const db = new Client(resolveConnection('local').config);
  await db.connect();
  try {
    const datos = (await datosManifiesto(db, salidaId, copia)) as unknown as DatosManifiesto;
    const bytes = renderManifiesto(datos, { cols });
    const transporte = crearTransporte();

    console.log(`Salida     : ${salidaId} · copia ${copia}`);
    console.log(`Transporte : ${transporte.label}`);
    console.log(`Documento  : ${bytes.length} bytes, ${cols} columnas`);

    const sonda = await transporte.probe();
    console.log(`Sonda      : ${sonda.ok ? 'OK' : 'FALLA'} (${sonda.latencyMs} ms)${sonda.detail ? ` — ${sonda.detail}` : ''}`);
    if (!sonda.ok) {
      console.error('\nLa impresora no responde. No se envía el documento.');
      process.exitCode = 1;
      return;
    }

    await transporte.open();
    await transporte.write(bytes);
    await transporte.close();

    if (transporte instanceof CaptureTransport) {
      console.log('\n--- papel simulado ---');
      console.log(decodeText(stripCommandsRaw(transporte.buffer)));
    }
    console.log('\nEnviado.');
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error('PoC falló:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
