import { describe, expect, it } from 'vitest';
import { buildQrBody, buildQrText, foldToAscii, verifyQrText } from '../../src/printing/qr-text.js';

const KEY = 'llave-de-prueba';
const DATA = {
  folio: '7K3M9A',
  pasajero: 'María de los Ángeles Muñoz Peña',
  asiento: 12,
  origen: 'Huajuapan',
  destino: 'Oaxaca',
  fechaHora: '2026-03-14 07:00',
  unidad: 'ECO-142',
  importe: '450.00',
};

describe('texto del QR', () => {
  it('es ASCII puro aunque el nombre lleve acentos', () => {
    const text = buildQrText(DATA, { key: KEY });
    expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
    expect(text).toContain('P:MARIA DE LOS ANGELES MUNOZ PENA');
  });

  it('nunca contiene una URL — el requerimiento lo prohibe', () => {
    const text = buildQrText(DATA, { key: KEY });
    expect(text.toLowerCase()).not.toMatch(/https?:\/\//);
  });

  it('empieza con el discriminante de la agencia y lleva el folio', () => {
    expect(buildQrBody(DATA).startsWith('DONAJI|F:7K3M9A|')).toBe(true);
  });

  it('valida offline su propia firma', () => {
    const verdict = verifyQrText(buildQrText(DATA, { key: KEY }), KEY);
    expect(verdict.valid).toBe(true);
    expect(verdict.fields['A']).toBe('12');
  });

  it('rechaza un QR alterado', () => {
    // El escenario real: alguien reimprime el QR cambiandose de asiento.
    const text = buildQrText(DATA, { key: KEY }).replace('A:12', 'A:1');
    const verdict = verifyQrText(text, KEY);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('firma no coincide');
  });

  it('rechaza una firma hecha con otra clave', () => {
    expect(verifyQrText(buildQrText(DATA, { key: 'otra' }), KEY).valid).toBe(false);
  });

  it('devuelve los campos aunque la firma falle, para poder mostrar el boleto', () => {
    const verdict = verifyQrText(buildQrText(DATA, { key: 'otra' }), KEY);
    expect(verdict.fields['F']).toBe('7K3M9A');
  });

  it('permite omitir el HMAC si el cliente lo rechaza', () => {
    const text = buildQrText(DATA, { includeHmac: false });
    expect(text).not.toContain('|V:');
  });

  it('folding conserva el resto del texto', () => {
    expect(foldToAscii('Nicolás Ibáñez')).toBe('NICOLAS IBANEZ');
  });
});
