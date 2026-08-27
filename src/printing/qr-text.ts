/**
 * Contenido del QR del boleto: texto plano, nunca una URL.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.4
 *
 * El requerimiento pide texto plano y no URL, y tiene razón: un QR con URL no sirve de
 * nada en una terminal sin internet. Pero un QR de texto plano lo falsifica cualquiera
 * con un generador gratuito, así que el campo `V:` lleva un HMAC truncado sobre el resto
 * del texto. Sigue siendo texto plano y sigue sin ser una URL, pero la terminal destino
 * puede validar el boleto OFFLINE al escanearlo.
 *
 * SUPUESTO pendiente de validación con el cliente: si rechaza el campo `V:`, se omite
 * sin ningún otro cambio (`includeHmac: false`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface QrTicketData {
  /** Folio de 6 caracteres alfanuméricos. */
  folio: string;
  pasajero: string;
  asiento: number;
  origen: string;
  destino: string;
  /** Fecha y hora de viaje, `YYYY-MM-DD HH:mm`. */
  fechaHora: string;
  unidad: string;
  /** Importe con dos decimales. */
  importe: string;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * El texto del QR debe ser ASCII puro.
 *
 * Un QR en modo byte con UTF-8 se lee distinto según el lector, y el objetivo es que
 * cualquier lector comercial devuelva exactamente los mismos caracteres sobre los que
 * se calculó el HMAC. "MUÑOZ" viaja como "MUNOZ": se pierde la tilde, no la validación.
 */
export function foldToAscii(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .toUpperCase()
    .trim();
}

/** Campos separados por `|`, en orden fijo. El orden es parte del contrato del HMAC. */
export function buildQrBody(d: QrTicketData): string {
  return [
    'DONAJI',
    `F:${foldToAscii(d.folio)}`,
    `P:${foldToAscii(d.pasajero)}`,
    `A:${d.asiento}`,
    `O:${foldToAscii(d.origen)}`,
    `D:${foldToAscii(d.destino)}`,
    `FH:${d.fechaHora}`,
    `U:${foldToAscii(d.unidad)}`,
    `IMP:${d.importe}`,
  ].join('|');
}

/** HMAC-SHA256 truncado a 8 caracteres base32. */
export function signQr(body: string, key: string): string {
  const mac = createHmac('sha256', key).update(body, 'ascii').digest();
  let out = '';
  for (let i = 0; i < 8; i++) out += BASE32[mac[i]! & 0x1f];
  return out;
}

export interface BuildQrOptions {
  /** Clave HMAC por agencia, replicada a los nodos. */
  key?: string;
  includeHmac?: boolean;
}

export function buildQrText(d: QrTicketData, opts: BuildQrOptions = {}): string {
  const body = buildQrBody(d);
  const includeHmac = opts.includeHmac ?? true;
  if (!includeHmac) return body;
  if (!opts.key) throw new Error('buildQrText: falta la clave HMAC (o usa includeHmac:false)');
  return `${body}|V:${signQr(body, opts.key)}`;
}

export interface QrVerdict {
  valid: boolean;
  /** Campos parseados; presentes aunque el HMAC no valide, para poder mostrarlos. */
  fields: Record<string, string>;
  reason?: string;
}

/**
 * Valida un QR escaneado, sin red.
 *
 * Devuelve siempre los campos parseados: una terminal que escanea un boleto con firma
 * inválida necesita mostrarle al operador QUÉ boleto es antes de rechazarlo.
 */
export function verifyQrText(text: string, key: string): QrVerdict {
  const idx = text.lastIndexOf('|V:');
  const fields: Record<string, string> = {};

  const parse = (s: string): void => {
    for (const part of s.split('|')) {
      const at = part.indexOf(':');
      if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
    }
  };

  if (idx === -1) {
    parse(text);
    return { valid: false, fields, reason: 'sin campo de firma' };
  }

  const body = text.slice(0, idx);
  const given = text.slice(idx + 3);
  parse(body);

  const expected = signQr(body, key);
  const a = Buffer.from(expected, 'ascii');
  const b = Buffer.from(given, 'ascii');
  const valid = a.length === b.length && timingSafeEqual(a, b);

  return valid ? { valid, fields } : { valid, fields, reason: 'firma no coincide' };
}
