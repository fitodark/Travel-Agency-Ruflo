/**
 * Plantilla del comprobante de anticipo (Ses. 71).
 *
 * Una reservación con abono parcial NO imprime boleto (eso sigue esperando a
 * que el saldo llegue a cero, sin importar el método — 02b §2.1). En su lugar
 * se imprime ESTE comprobante: lo que el cliente necesita para identificar la
 * reservación al presentarse a cubrir el resto en la sucursal de origen.
 *
 * UN COMPROBANTE POR VENTA, no por boleto: cubre a todos los pasajeros que se
 * reservaron juntos.
 */

import { EscPosDocument } from '../escpos/document.js';
import type { CodePageName } from '../escpos/codepage.js';
import type { DatosSucursal } from './boleto.js';

export interface PasajeroComprobante {
  nombre: string;
  asiento: number;
  importe: number;
}

export interface DatosComprobante {
  /** Folio de cada boleto de la venta; cualquiera de ellos consulta la reservación completa. */
  folios: string[];
  clienteNombre: string | null;
  clienteTelefono: string;
  pasajeros: PasajeroComprobante[];
  origen: DatosSucursal;
  destino: string;
  /** Fecha y hora de viaje, `YYYY-MM-DD HH:mm`. */
  fechaHoraViaje: string;
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
  /** Sucursal donde se recibió el abono (imprime ahí). */
  sucursalCobro: string;
  vendedor: string;
  /** Momento en que se generó el comprobante, `YYYY-MM-DD HH:mm`. */
  generadoEn: string;
}

export interface ConfigComprobante {
  leyendaPie: string;
  telefonosAtencion: string;
  proveedor: string;
  cols?: number;
  codePage?: CodePageName;
}

const money = (n: number): string =>
  n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatoAsiento = (n: number): string => String(n).padStart(2, '0');

const NOMBRE_AGENCIA = 'DONAJI';

/**
 * Renderiza el comprobante de anticipo a bytes ESC/POS. No hace E/S y no
 * depende del transporte (mismo criterio que `renderBoleto`).
 */
export function renderComprobanteReserva(c: DatosComprobante, cfg: ConfigComprobante): Buffer {
  const doc = new EscPosDocument({
    ...(cfg.cols !== undefined ? { cols: cfg.cols } : {}),
    ...(cfg.codePage !== undefined ? { codePage: cfg.codePage } : {}),
  });

  doc.align('center').bold(true).size(2, 2).line(NOMBRE_AGENCIA).size(1, 1).bold(false);
  doc.line('COMPROBANTE DE ANTICIPO');
  doc.align('left').divider();

  doc.twoCol('Generado', c.generadoEn);
  doc.twoCol('Sucursal', c.sucursalCobro);
  doc.twoCol('Atendió', c.vendedor);
  doc.divider();

  // El folio es lo que el cliente dicta/teclea para consultar la reservación
  // (0006: alfabeto sin I/L/O/U, pensado para dictarse por teléfono).
  doc.bold(true);
  if (c.folios.length === 1) {
    doc.twoCol('FOLIO', c.folios[0]!);
  } else {
    doc.line('FOLIOS');
    for (const f of c.folios) doc.line(`  ${f}`);
  }
  doc.bold(false);
  doc.divider();

  doc.twoCol('Cliente', c.clienteNombre ?? '(sin registrar)');
  doc.twoCol('Teléfono', c.clienteTelefono);
  doc.divider();

  doc.line('PASAJEROS');
  for (const p of c.pasajeros) {
    doc.twoCol(p.nombre.toUpperCase(), `Asiento ${formatoAsiento(p.asiento)}`);
  }
  doc.divider();

  doc.twoCol('Origen', c.origen.nombre);
  doc.twoCol('Destino', c.destino);
  doc.twoCol('Salida', c.fechaHoraViaje);
  doc.divider();

  doc.twoCol('Total', `$${money(c.importeTotal)}`);
  doc.twoCol('Abonado', `$${money(c.pagado)}`);
  doc.bold(true).size(1, 2);
  doc.twoCol('SALDO', `$${money(c.saldoPendiente)}`, '.');
  doc.size(1, 1).bold(false);
  doc.divider();

  doc.align('center');
  doc.wrap('Presenta este comprobante en la sucursal de ORIGEN para cubrir el saldo y recibir tus boletos de abordar.');
  doc.feed(1);
  doc.wrap(cfg.leyendaPie);
  doc.feed(1);
  doc.wrap(cfg.telefonosAtencion);
  doc.wrap(cfg.proveedor);
  doc.align('left');

  doc.feed(1).cut();
  return doc.build();
}
