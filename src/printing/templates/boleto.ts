/**
 * Plantilla del boleto de viaje.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.4
 *
 * UN TICKET POR PASAJERO. El requerimiento es explícito: una venta de 5 boletos imprime
 * 5 tickets separados, no uno con 5 cortes. Esta plantilla renderiza exactamente uno;
 * el spooler crea un `print_job` por boleto.
 */

import { EscPosDocument } from '../escpos/document.js';
import type { CodePageName } from '../escpos/codepage.js';
import { buildQrText, type QrTicketData } from '../qr-text.js';

export interface DatosSucursal {
  nombre: string;
  direccion: string;
  telefono: string;
}

export interface DatosBoleto {
  folio: string;
  pasajero: string;
  asiento: number;
  origen: DatosSucursal;
  destino: string;
  /** Fecha y hora de viaje, `YYYY-MM-DD HH:mm`. */
  fechaHoraViaje: string;
  unidad: string;
  importe: number;
  /** Usuario que atiende, para el header. */
  vendedor: string;
  /** Momento de emisión, `YYYY-MM-DD HH:mm`. */
  emitidoEn: string;
  /** Marca cuando el boleto proviene de una reservación (para reportes y para el papel). */
  porReservacion?: boolean;
  /** Saldo pendiente si la reservación no está liquidada. */
  saldoPendiente?: number;
}

export interface ConfigTicket {
  leyendaPie: string;
  telefonosAtencion: string;
  proveedor: string;
  cols?: number;
  codePage?: CodePageName;
  /** Clave HMAC de la agencia para el campo `V:` del QR. */
  hmacKey?: string;
  incluirHmac?: boolean;
  qrModuleSize?: number;
}

const money = (n: number): string =>
  n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Renderiza un boleto completo a bytes ESC/POS, listo para cualquier transporte.
 *
 * No hace E/S y no depende del transporte: eso es lo que permite probar la maqueta
 * completa sin la impresora física enfrente.
 */
export function renderBoleto(b: DatosBoleto, cfg: ConfigTicket): Buffer {
  const doc = new EscPosDocument({
    ...(cfg.cols !== undefined ? { cols: cfg.cols } : {}),
    ...(cfg.codePage !== undefined ? { codePage: cfg.codePage } : {}),
  });

  // ---- Header: sucursal, atención, folio -----------------------------------
  doc.align('center').bold(true).size(2, 2).line(b.origen.nombre).size(1, 1).bold(false);
  doc.wrap(b.origen.direccion);
  doc.line(`Tel. ${b.origen.telefono}`);
  doc.align('left').divider();

  doc.twoCol('Atiende:', b.vendedor);
  doc.twoCol('Emitido:', b.emitidoEn);
  doc.bold(true).size(2, 2).align('center').line(`FOLIO ${b.folio}`).size(1, 1).align('left').bold(false);
  doc.divider();

  // ---- Body: pasajero y viaje ----------------------------------------------
  doc.bold(true).line('PASAJERO').bold(false);
  doc.wrap(b.pasajero);
  doc.feed(1);

  doc.bold(true).size(2, 2).line(`ASIENTO ${b.asiento}`).size(1, 1).bold(false);
  doc.feed(1);

  doc.twoCol('Origen:', b.origen.nombre);
  doc.twoCol('Destino:', b.destino);
  doc.twoCol('Fecha y hora:', b.fechaHoraViaje);
  doc.twoCol('Unidad:', b.unidad);
  doc.divider();

  doc.bold(true).twoCol('IMPORTE', `$${money(b.importe)}`, '.').bold(false);

  // Un saldo pendiente tiene que gritar en el papel: es lo que el pasajero debe
  // liquidar antes de abordar, y el operador de la terminal lo lee de este ticket.
  if (b.saldoPendiente && b.saldoPendiente > 0) {
    doc.bold(true).size(1, 2);
    doc.twoCol('SALDO PENDIENTE', `$${money(b.saldoPendiente)}`, '.');
    doc.size(1, 1).bold(false);
    doc.align('center').line('*** LIQUIDAR ANTES DE ABORDAR ***').align('left');
  }
  if (b.porReservacion) {
    doc.align('center').line('(por reservacion)').align('left');
  }

  doc.divider();

  // ---- Footer: QR de texto plano, leyendas, proveedor ------------------------
  const qrData: QrTicketData = {
    folio: b.folio,
    pasajero: b.pasajero,
    asiento: b.asiento,
    origen: b.origen.nombre,
    destino: b.destino,
    fechaHora: b.fechaHoraViaje,
    unidad: b.unidad,
    importe: money(b.importe),
  };
  const qrText = buildQrText(qrData, {
    ...(cfg.hmacKey !== undefined ? { key: cfg.hmacKey } : {}),
    includeHmac: cfg.incluirHmac ?? cfg.hmacKey !== undefined,
  });

  doc.feed(1);
  doc.qrNative(qrText, { moduleSize: cfg.qrModuleSize ?? 6, errorCorrection: 'M' });
  doc.feed(1);

  doc.align('center');
  doc.wrap(cfg.leyendaPie);
  doc.feed(1);
  doc.wrap(cfg.telefonosAtencion);
  doc.wrap(cfg.proveedor);
  doc.align('left');

  doc.feed(3).cut();
  return doc.build();
}
