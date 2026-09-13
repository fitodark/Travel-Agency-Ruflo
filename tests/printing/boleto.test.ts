import { describe, expect, it } from 'vitest';
import { renderBoleto, type ConfigTicket, type DatosBoleto } from '../../src/printing/templates/boleto.js';
import { stripCommands } from '../../src/printing/transport/capture.js';
import { verifyQrText } from '../../src/printing/qr-text.js';

const BOLETO: DatosBoleto = {
  folio: '7K3M9A',
  pasajero: 'María de los Ángeles Muñoz Peña',
  asiento: 12,
  categoria: 'general',
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
    expect(p).toContain('Folio');
    expect(p).toContain('7K3M9A');
    expect(p).toContain('ASIENTO');
    expect(p).toContain('12');
    expect(p).toContain('Terminal Oaxaca');
    expect(p).toContain('2026-03-14 07:00');
  });

  it('el pasajero va en mayúsculas junto al asiento, a 2 dígitos', () => {
    const p = paper({ ...BOLETO, pasajero: 'Juan Perez', asiento: 4 });
    expect(p).toContain('JUAN PEREZ');
    expect(p).toContain('04');
    expect(p).not.toContain('ASIENTO 4\n');
  });

  it('ya no imprime "Atiende" (fuera del mockup de QA)', () => {
    expect(paper(BOLETO)).not.toContain('Atiende');
  });

  it('imprime la tarifa cobrada (D7 revisada, Ses. 68)', () => {
    expect(paper({ ...BOLETO, categoria: 'general' })).toContain('General');
    expect(paper({ ...BOLETO, categoria: 'inapam' })).toContain('INAPAM');
    expect(paper({ ...BOLETO, categoria: 'menor' })).toContain('Menor');
  });

  it('el título es la marca «DONAJI», no el nombre de la sucursal de origen', () => {
    const p = paper(BOLETO);
    expect(p.split('\n')[0]).toBe('DONAJI');
  });

  it('dirección y teléfono van en una sola cadena que envuelve junta (sin renglón fijo aparte)', () => {
    const p = paper(BOLETO);
    const lineas = p.split('\n');
    // Con la dirección corta del fixture, caben juntos en el mismo renglón.
    expect(lineas[1]).toBe('Av. Hidalgo 214, Centro, Tel. 953 532 0000');
    expect(lineas[1]).not.toBe('Av. Hidalgo 214, Centro');
  });

  it('si la dirección es larga, el teléfono fluye a un renglón extra (no se trunca ni se limita a 2)', () => {
    const direccionLarga =
      'Carretera Federal 190 Km 3.5, Fraccionamiento Las Américas, Col Centro, '
      + 'Huajuapan de León, Oaxaca, México';
    const p = paper({
      ...BOLETO,
      origen: { ...BOLETO.origen, direccion: direccionLarga },
    });
    const lineas = p.split('\n');
    const idxDivider = lineas.indexOf('-'.repeat(48));
    // Encabezado (DONAJI) + N renglones de dirección/teléfono antes del primer divisor.
    const renglonesHeader = idxDivider - 1;
    expect(renglonesHeader).toBeGreaterThan(2);
    const lineaConTelefono = lineas.find((l) => l.includes('Tel. 953 532 0000'));
    expect(lineaConTelefono).toBeDefined();
  });

  it('no usa el carácter «·» (degrada a «?» en CP437/850/858)', () => {
    expect(paper(BOLETO)).not.toContain('·');
  });

  it('el importe no lleva puntos suspensivos de relleno', () => {
    const p = paper(BOLETO);
    const linea = p.split('\n').find((l) => l.includes('IMPORTE'));
    expect(linea).not.toMatch(/\.\.\./);
  });

  it('el QR no deja renglones vacíos antes ni después', () => {
    const lineas = paper(BOLETO).split('\n');
    const divisores = lineas
      .map((l, i) => (/^-+$/.test(l) ? i : -1))
      .filter((i) => i >= 0);
    const ultimo = divisores[divisores.length - 1]!;
    expect(lineas[ultimo - 1]).not.toBe('');
    expect(lineas[ultimo + 1]).not.toBe('');
  });

  it('el QR usa 4 puntos por módulo por defecto (49x49 real ⇒ ≈24.5mm, bajo el máximo de 2.8cm)', () => {
    const bytes = renderBoleto(BOLETO, CFG);
    const marker = Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43]);
    const at = bytes.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    expect(bytes[at + marker.length]).toBe(4);
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
