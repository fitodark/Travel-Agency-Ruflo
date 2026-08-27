import { describe, expect, it } from 'vitest';
import { renderBoleto, type ConfigTicket, type DatosBoleto } from '../../src/printing/templates/boleto.js';
import { stripCommands } from '../../src/printing/transport/capture.js';
import { verifyQrText } from '../../src/printing/qr-text.js';

const BOLETO: DatosBoleto = {
  folio: '7K3M9A',
  pasajero: 'María de los Ángeles Muñoz Peña',
  asiento: 12,
  origen: { nombre: 'Terminal Huajuapan', direccion: 'Av. Hidalgo 214, Centro', telefono: '953 532 0000' },
  destino: 'Terminal Oaxaca',
  fechaHoraViaje: '2026-03-14 07:00',
  unidad: 'ECO-142',
  importe: 450,
  vendedor: 'Nicolás Ibáñez',
  emitidoEn: '2026-03-13 18:42',
};

const CFG: ConfigTicket = {
  leyendaPie: 'Buen viaje, estamos para servirle.',
  telefonosAtencion: 'Atención: 953 532 0000',
  proveedor: 'Fi.TechServices',
  hmacKey: 'llave',
};

const paper = (b: DatosBoleto, c: ConfigTicket = CFG): string => stripCommands(renderBoleto(b, c));

describe('boleto', () => {
  it('lleva folio, asiento, origen, destino y fecha', () => {
    const p = paper(BOLETO);
    expect(p).toContain('FOLIO 7K3M9A');
    expect(p).toContain('ASIENTO 12');
    expect(p).toContain('Terminal Oaxaca');
    expect(p).toContain('2026-03-14 07:00');
  });

  it('termina en corte de papel', () => {
    const bytes = renderBoleto(BOLETO, CFG);
    expect(bytes.subarray(-4)).toEqual(Buffer.from([0x1d, 0x56, 66, 3]));
  });

  it('emite QR nativo verificable', () => {
    const bytes = renderBoleto(BOLETO, CFG);
    expect(bytes.includes(Buffer.from([0x1d, 0x28, 0x6b]))).toBe(true);

    // Extrae el payload almacenado por fn 180 y valida su firma.
    const marker = Buffer.from([0x1d, 0x28, 0x6b]);
    let at = -1;
    for (let i = 0; i < bytes.length - 8; i++) {
      if (bytes.subarray(i, i + 3).equals(marker) && bytes[i + 5] === 0x31 && bytes[i + 6] === 0x50) {
        at = i;
        break;
      }
    }
    expect(at).toBeGreaterThan(-1);
    const len = ((bytes[at + 4]! << 8) | bytes[at + 3]!) - 3;
    const payload = bytes.subarray(at + 8, at + 8 + len).toString('latin1');
    expect(verifyQrText(payload, 'llave').valid).toBe(true);
  });

  it('grita el saldo pendiente de una reservacion no liquidada', () => {
    const p = paper({ ...BOLETO, porReservacion: true, saldoPendiente: 150 });
    expect(p).toContain('SALDO PENDIENTE');
    expect(p).toContain('LIQUIDAR ANTES DE ABORDAR');
    expect(p).toContain('$150.00');
  });

  it('no menciona saldo cuando el boleto esta liquidado', () => {
    expect(paper(BOLETO)).not.toContain('SALDO PENDIENTE');
  });

  it('marca el origen por reservacion para efectos de reporte', () => {
    expect(paper({ ...BOLETO, porReservacion: true })).toContain('(por reservacion)');
  });

  it('respeta el ancho configurado sin reescribir la plantilla', () => {
    const angosto = paper(BOLETO, { ...CFG, cols: 32 });
    for (const line of angosto.split('\n')) expect(line.length).toBeLessThanOrEqual(32);
  });

  it('formatea el importe en pesos con dos decimales', () => {
    expect(paper({ ...BOLETO, importe: 1234.5 })).toContain('$1,234.50');
  });
});
