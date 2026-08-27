/**
 * PoC de impresión de F0: imprime un boleto de muestra por el transporte elegido.
 *
 * Criterio de aceptación de F0 (docs/architecture/04-riesgos-roadmap.md §3):
 * "un ticket físico impreso correctamente por AMBOS transportes".
 *
 *   npm run printer:poc                                   usa core.config_impresora
 *   npm run printer:poc -- --transport capture            fuerza captura en memoria
 *   npm run printer:poc -- --transport tcp --host 1.2.3.4 fuerza red
 *   npm run printer:poc -- --transport usb --printer "XP-80"
 *
 * SIN argumentos lee la configuración de la BASE DE DATOS, que es como opera en una
 * terminal real: dar de alta una impresora es insertar una fila, no editar código. Los
 * argumentos existen para probar antes de que exista esa fila.
 *
 * El boleto de muestra lleva acentos y `ñ` a propósito: la codificación es la fuente
 * #1 de tickets defectuosos y hay que verla en papel, no en un test.
 */

import { Client } from 'pg';
import { resolveConnection } from '../../db/connection.js';
import { cargarConfiguracionImpresion } from '../config.js';
import { renderBoleto, type ConfigTicket, type DatosBoleto } from '../templates/boleto.js';
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

const BOLETO: DatosBoleto = {
  folio: '7K3M9A',
  pasajero: 'MARÍA DE LOS ÁNGELES MUÑOZ PEÑA',
  asiento: 12,
  origen: {
    nombre: 'Terminal Huajuapan',
    direccion: 'Av. Miguel Hidalgo 214, Col. Centro, Huajuapan de León, Oaxaca',
    telefono: '953 532 0000',
  },
  destino: 'Terminal Oaxaca',
  fechaHoraViaje: '2026-03-14 07:00',
  unidad: 'ECO-142',
  importe: 450,
  vendedor: 'Nicolás Ibáñez',
  emitidoEn: '2026-03-13 18:42',
  porReservacion: true,
  saldoPendiente: 150,
};

/** Configuración de respaldo cuando se fuerza el transporte por argumentos. */
const CONFIG_MANUAL: ConfigTicket = {
  leyendaPie: 'Buen viaje, estamos para servirle.',
  telefonosAtencion: 'Atención a clientes: 953 532 0000',
  proveedor: 'Sistema por Fi.TechServices',
  cols: Number(readArg('cols', '48')),
  hmacKey: readArg('hmac-key') ?? 'llave-de-prueba-f0',
  qrModuleSize: Number(readArg('qr-size', '6')),
};

/**
 * Resuelve de dónde sale la configuración.
 *
 * Sin argumentos: de la base de datos, como en una terminal real. Con `--transport`:
 * forzado, para poder probar la maqueta antes de que exista la fila de configuración —
 * que es justo la situación mientras la impresora no está instalada.
 */
async function resolverOrigen(): Promise<{
  transporte: EscPosTransport;
  ticket: ConfigTicket;
  origen: string;
  cerrar: () => Promise<void>;
}> {
  const forzado = readArg('transport');

  if (forzado === 'tcp') {
    const host = readArg('host');
    if (!host) throw new Error('--transport tcp requiere --host');
    return {
      transporte: new TcpTransport({ host, port: Number(readArg('port', '9100')) }),
      ticket: CONFIG_MANUAL,
      origen: 'argumentos',
      cerrar: async () => { /* nada que cerrar */ },
    };
  }

  if (forzado === 'usb') {
    const printerName = readArg('printer');
    if (!printerName) throw new Error('--transport usb requiere --printer "NOMBRE DE LA COLA"');
    return {
      transporte: new UsbTransport({ printerName }),
      ticket: CONFIG_MANUAL,
      origen: 'argumentos',
      cerrar: async () => { /* nada que cerrar */ },
    };
  }

  if (forzado === 'capture') {
    return {
      transporte: new CaptureTransport(),
      ticket: CONFIG_MANUAL,
      origen: 'argumentos',
      cerrar: async () => { /* nada que cerrar */ },
    };
  }

  const sucursalId = readArg('sucursal');
  const agenciaId = readArg('agencia');
  if (!sucursalId || !agenciaId) {
    throw new Error(
      'Sin --transport se lee la configuración de la base y hacen falta --sucursal <uuid> y --agencia <uuid>.\n' +
      'Para probar sin base: npm run printer:poc -- --transport capture',
    );
  }

  const client = new Client(resolveConnection('local').config);
  await client.connect();
  const cfg = await cargarConfiguracionImpresion(client, sucursalId, agenciaId);

  return {
    transporte: cfg.transporte,
    ticket: cfg.ticket,
    origen: `core.config_impresora "${cfg.impresora.nombre}" (${cfg.impresora.ancho_cols} col, ${cfg.impresora.code_page})`,
    cerrar: () => client.end(),
  };
}

async function main(): Promise<void> {
  const { transporte, ticket, origen, cerrar } = await resolverOrigen();

  try {
    const bytes = renderBoleto(BOLETO, ticket);

    console.log(`Configuración: ${origen}`);
    console.log(`Transporte   : ${transporte.label}`);
    console.log(`Documento    : ${bytes.length} bytes, ${ticket.cols ?? 48} columnas`);

    const probe = await transporte.probe();
    console.log(`Sonda        : ${probe.ok ? 'OK' : 'FALLA'} (${probe.latencyMs} ms)${probe.detail ? ` — ${probe.detail}` : ''}`);
    if (!probe.ok) {
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
    await cerrar();
  }
}

main().catch((err: unknown) => {
  console.error('PoC falló:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
