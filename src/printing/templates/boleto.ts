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
  /**
   * Tarifa cobrada (`core.boleto.categoria_pasajero`): `general` | `inapam` | `menor`.
   * Se imprime desde 0069 (D7 revisada, Ses. 68 — decisión de cliente/QA/diseño).
   */
  categoria: string;
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
  /** Punto donde el pasajero sube (== `origen.nombre`; explícito para el papel, D7). */
  puntoAscenso?: string;
  /** El boleto es una reimpresión: agrega la leyenda de `cfg.leyendaReimpresion` (N-4). */
  reimpreso?: boolean;
}

export interface ConfigTicket {
  leyendaPie: string;
  telefonosAtencion: string;
  proveedor: string;
  /** Leyenda que se agrega al pie de un boleto reimpreso (N-4). */
  leyendaReimpresion?: string;
  cols?: number;
  codePage?: CodePageName;
  /** Clave HMAC de la agencia para el campo `V:` del QR. */
  hmacKey?: string;
  incluirHmac?: boolean;
  qrModuleSize?: number;
}

const money = (n: number): string =>
  n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Asiento a 2 dígitos («04», no «4») — mismo criterio que el mapa de asientos de la SPA. */
const formatoAsiento = (n: number): string => String(n).padStart(2, '0');

/** Mismas etiquetas que `CATEGORIAS` en `web/src/paginas/Vender.tsx`. */
const ETIQUETA_CATEGORIA: Record<string, string> = {
  general: 'General',
  inapam: 'INAPAM',
  menor: 'Menor',
};
const etiquetaCategoria = (c: string): string => ETIQUETA_CATEGORIA[c] ?? c;

/** Marca fija (mismo literal que el campo `DONAJI` del payload del QR, `qr-text.ts`). */
const NOMBRE_AGENCIA = 'DONAJI';

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

  // ---- Header: marca, dirección + teléfono ---------------------------------
  // Una sola cadena (no un renglón fijo aparte para el teléfono): el mockup los
  // envuelve juntos — 2 renglones en el caso típico, 3+ si la dirección es larga.
  doc.align('center').bold(true).size(2, 2).line(NOMBRE_AGENCIA).size(1, 1).bold(false);
  // Separador ASCII plano (coma), no «·»: ese carácter no existe en CP437/850/858 y
  // degradaría a «?» en el papel real (`encodeText`, fallback documentado).
  doc.wrap(`${b.origen.direccion}, Tel. ${b.origen.telefono}`);
  doc.align('left').divider();

  // ---- Emitido / folio ------------------------------------------------------
  doc.twoCol('Emitido', b.emitidoEn);
  doc.twoCol('Folio', b.folio);
  doc.divider();

  // ---- Pasajero / asiento -----------------------------------------------
  doc.twoCol('PASAJERO', 'ASIENTO');
  doc.bold(true).twoCol(b.pasajero.toUpperCase(), formatoAsiento(b.asiento)).bold(false);
  doc.divider();

  // ---- Datos del viaje --------------------------------------------------
  doc.twoCol('Origen', b.origen.nombre);
  doc.twoCol('Destino', b.destino);
  doc.twoCol('Salida', b.fechaHoraViaje);
  doc.twoCol('Unidad', b.unidad);
  doc.twoCol('Tarifa', etiquetaCategoria(b.categoria));
  doc.divider();

  doc.bold(true).twoCol('IMPORTE', `$${money(b.importe)}`).bold(false);

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

  // El payload (folio+pasajero+asiento+origen+destino+fecha+unidad+importe+HMAC) mide
  // ~145 caracteres e incluye `|`, fuera del alfabeto alfanumérico del QR — cae a modo
  // byte, así que con EC nivel M el símbolo real es versión 8 (49x49 módulos), NO
  // versión 1 (21x21) como asumió el mockup de diseño. Con 4 pts/módulo (el mínimo del
  // spec, "nunca menos de 4 pts") el símbolo mide 49×4/8 ≈ 24.5 mm — dentro del máximo
  // de 2.8×2.8 cm; a 6 pts/módulo mediría ≈36.75 mm, por encima del máximo.
  doc.qrNative(qrText, { moduleSize: cfg.qrModuleSize ?? 4, errorCorrection: 'M' });
  doc.divider();

  doc.align('center');
  doc.wrap(cfg.leyendaPie);
  doc.feed(1);
  doc.wrap(cfg.telefonosAtencion);
  doc.wrap(cfg.proveedor);

  // Reimpresión (N-4): la leyenda va al final, en negrita, para que sea evidente
  // que este papel no es el original.
  if (b.reimpreso && cfg.leyendaReimpresion) {
    doc.feed(1).bold(true);
    doc.wrap(cfg.leyendaReimpresion);
    doc.bold(false);
  }
  doc.align('left');

  // El corte no puede ser inmediato: la cuchilla física está unos milímetros
  // después del cabezal, no en el mismo punto. `feed(1)` (antes `feed(3)`,
  // ≈12mm) deja ≈4mm de holgura — a validar contra la Enduro física; si corta
  // sobre el texto, hay que subir este valor, no bajarlo más.
  doc.feed(1).cut();
  return doc.build();
}
