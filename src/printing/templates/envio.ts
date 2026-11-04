/**
 * Plantillas de paquetería (Fase D, 0085).
 *
 * docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P7)
 *
 *   * `renderReciboEnvio`  — el recibo del cliente: datos del envío, cobro y un
 *     QR firmado (`DONAJI-ENV`) que también lleva el monto si es por cobrar.
 *   * `renderEtiquetaEnvio` — UN ticket por bulto ("2/5"), para pegarlo con
 *     cinta: destino grande, destinatario, POR COBRAR si aplica y su propio QR
 *     firmado (`DONAJI-BUL`). Corto a propósito: es rollo normal de la Enduro.
 *
 * No hacen E/S ni conocen el transporte (mismo criterio que `renderBoleto`).
 */

import { EscPosDocument } from '../escpos/document.js';
import type { CodePageName } from '../escpos/codepage.js';
import { buildQrBulto, buildQrEnvio } from '../qr-text.js';

export interface DatosEnvio {
  folio: string;
  remitenteNombre: string;
  remitenteTelefono: string;
  destinatarioNombre: string;
  destinatarioTelefono: string;
  descripcion: string;
  bultos: number;
  importe: number;
  modalidad: 'pagado' | 'por_cobrar';
  estadoPago: 'pagado' | 'por_confirmar' | 'pendiente';
  porCobrar: number;
  metodo: 'efectivo' | 'transferencia' | null;
  origen: { nombre: string; direccion: string; telefono: string };
  destino: { nombre: string; direccion: string; telefono: string };
  /** `YYYY-MM-DD HH:mm` de la salida por el origen. */
  fechaHoraSalida: string;
  unidad: string;
  vendedor: string;
  registradoEn: string;
  /** Solo la etiqueta: qué bulto es (1..bultos). */
  bulto?: number;
  reimpreso?: boolean;
}

export interface ConfigEnvio {
  leyendaPie?: string;
  telefonosAtencion?: string;
  leyendaReimpresion?: string;
  cols?: number;
  codePage?: CodePageName;
  hmacKey?: string;
  incluirHmac?: boolean;
  qrModuleSize?: number;
}

const money = (n: number): string =>
  n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const NOMBRE_AGENCIA = 'DONAJI';

const qrOpts = (cfg: ConfigEnvio) => ({
  ...(cfg.hmacKey !== undefined ? { key: cfg.hmacKey } : {}),
  includeHmac: cfg.incluirHmac ?? cfg.hmacKey !== undefined,
});

const nuevoDoc = (cfg: ConfigEnvio): EscPosDocument => new EscPosDocument({
  ...(cfg.cols !== undefined ? { cols: cfg.cols } : {}),
  ...(cfg.codePage !== undefined ? { codePage: cfg.codePage } : {}),
});

const pieReimpresion = (doc: EscPosDocument, e: DatosEnvio, cfg: ConfigEnvio): void => {
  if (e.reimpreso) {
    doc.align('center').bold(true).wrap(cfg.leyendaReimpresion ?? 'REIMPRESION').bold(false).align('left');
  }
};

/** El recibo del cliente (REQ-6). */
export function renderReciboEnvio(e: DatosEnvio, cfg: ConfigEnvio = {}): Buffer {
  const doc = nuevoDoc(cfg);

  doc.align('center').bold(true).size(2, 2).line(NOMBRE_AGENCIA).size(1, 1);
  doc.line('RECIBO DE ENVIO DE PAQUETERIA').bold(false);
  doc.wrap(`${e.origen.direccion}, Tel. ${e.origen.telefono}`);
  doc.align('left').divider();

  doc.twoCol('Folio', e.folio);
  doc.twoCol('Registrado', e.registradoEn);
  doc.twoCol('Atendio', e.vendedor);
  doc.divider();

  doc.bold(true).line('ENVIA').bold(false);
  doc.line(e.remitenteNombre.toUpperCase());
  doc.line(`Cel. ${e.remitenteTelefono}`);
  doc.bold(true).line('RECIBE').bold(false);
  doc.line(e.destinatarioNombre.toUpperCase());
  doc.line(`Cel. ${e.destinatarioTelefono}`);
  doc.divider();

  doc.twoCol('Origen', e.origen.nombre);
  doc.twoCol('Destino', e.destino.nombre);
  doc.twoCol('Salida', e.fechaHoraSalida);
  if (e.unidad) doc.twoCol('Unidad', e.unidad);
  doc.twoCol('Bultos', String(e.bultos));
  doc.wrap(`Contenido: ${e.descripcion}`);
  doc.divider();

  doc.bold(true).twoCol('IMPORTE', `$${money(e.importe)}`).bold(false);
  if (e.modalidad === 'por_cobrar') {
    doc.bold(true).size(1, 2).twoCol('POR COBRAR EN DESTINO', `$${money(e.porCobrar)}`, '.')
      .size(1, 1).bold(false);
  } else if (e.estadoPago === 'por_confirmar') {
    doc.bold(true).line('PAGADO POR TRANSFERENCIA - POR CONFIRMAR').bold(false);
  } else {
    doc.twoCol('Pagado', e.metodo === 'transferencia' ? 'Transferencia' : 'Efectivo');
  }
  doc.divider();

  doc.align('center');
  doc.wrap(`Recoge en: ${e.destino.nombre}, ${e.destino.direccion}, Tel. ${e.destino.telefono}`);
  doc.wrap('Quien recoge debe presentar su credencial de elector y este folio.');
  doc.feed(1);
  doc.qrNative(buildQrEnvio({
    folio: e.folio,
    remitente: e.remitenteNombre,
    destinatario: e.destinatarioNombre,
    destinatarioTelefono: e.destinatarioTelefono,
    origen: e.origen.nombre,
    destino: e.destino.nombre,
    fechaHora: e.fechaHoraSalida,
    bultos: e.bultos,
    importe: money(e.importe),
    modalidad: e.modalidad,
    ...(e.modalidad === 'por_cobrar' ? { porCobrar: money(e.porCobrar) } : {}),
  }, qrOpts(cfg)), { moduleSize: cfg.qrModuleSize ?? 4, errorCorrection: 'M' });
  if (cfg.telefonosAtencion) doc.wrap(cfg.telefonosAtencion);
  if (cfg.leyendaPie) doc.wrap(cfg.leyendaPie);
  doc.align('left');
  pieReimpresion(doc, e, cfg);

  doc.feed(1).cut();
  return doc.build();
}

/** El ticket que va pegado en UN bulto (REQ-8/9). */
export function renderEtiquetaEnvio(e: DatosEnvio, cfg: ConfigEnvio = {}): Buffer {
  const bulto = e.bulto ?? 1;
  const doc = nuevoDoc(cfg);

  doc.align('center').bold(true).line(`${NOMBRE_AGENCIA} - PAQUETERIA`);
  doc.size(2, 2).line(`${bulto}/${e.bultos}`).size(1, 1);
  doc.line(`FOLIO ${e.folio}`).bold(false);
  doc.divider();
  doc.bold(true).size(1, 2).line(`DESTINO: ${e.destino.nombre.toUpperCase()}`).size(1, 1).bold(false);
  doc.align('left');
  doc.twoCol('Recoge', e.destinatarioNombre.toUpperCase());
  doc.twoCol('Cel.', e.destinatarioTelefono);
  doc.twoCol('Origen', e.origen.nombre);
  doc.twoCol('Salida', e.fechaHoraSalida);
  if (e.modalidad === 'por_cobrar') {
    doc.bold(true).twoCol('POR COBRAR', `$${money(e.porCobrar)}`, '.').bold(false);
  }
  doc.align('center');
  doc.qrNative(buildQrBulto({
    folio: e.folio,
    bulto,
    bultos: e.bultos,
    destino: e.destino.nombre,
    destinatario: e.destinatarioNombre,
    ...(e.modalidad === 'por_cobrar' ? { porCobrar: money(e.porCobrar) } : {}),
  }, qrOpts(cfg)), { moduleSize: cfg.qrModuleSize ?? 4, errorCorrection: 'M' });
  doc.align('left');
  pieReimpresion(doc, e, cfg);

  doc.feed(1).cut();
  return doc.build();
}
