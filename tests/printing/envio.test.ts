/**
 * Fase D (0085) — plantillas de paquetería: recibo con QR firmado y un ticket
 * por bulto. Sin base: render puro contra el texto que sale al papel.
 */

import { describe, expect, it } from 'vitest';
import {
  renderEtiquetaEnvio, renderReciboEnvio, type DatosEnvio,
} from '../../src/printing/templates/envio.js';
import { buildQrBulto, buildQrEnvio, verifyQrText } from '../../src/printing/qr-text.js';
import { stripCommands } from '../../src/printing/transport/capture.js';

const BASE: DatosEnvio = {
  folio: '1A2B3C',
  remitenteNombre: 'Rosa Pérez', remitenteTelefono: '953 111 2222',
  destinatarioNombre: 'Carlos Pérez López', destinatarioTelefono: '55 3333 4444',
  descripcion: '5 cajas de ropa', bultos: 5, importe: 800,
  modalidad: 'por_cobrar', estadoPago: 'pendiente', porCobrar: 800, metodo: null,
  origen: { nombre: 'Huajuapan de León', direccion: 'Av. Central 1', telefono: '953 000 0000' },
  destino: { nombre: 'CDMX TAPO', direccion: 'Calz. Zaragoza 200', telefono: '55 0000 0000' },
  fechaHoraSalida: '2026-11-04 07:00', unidad: 'ECO-142', vendedor: 'Vendedor 1',
  registradoEn: '2026-11-03 18:20',
};

const CLAVE = 'clave-de-prueba-suficientemente-larga-32b';
const papel = (b: Buffer): string => stripCommands(b);

describe('recibo de envío', () => {
  it('lleva folio, quien envía y quien recibe, ruta, bultos y el monto por cobrar', () => {
    const p = papel(renderReciboEnvio(BASE, { hmacKey: CLAVE }));
    for (const t of ['RECIBO DE ENVIO', 'Folio', '1A2B3C', 'ENVIA', 'ROSA P', 'RECIBE',
                     'CARLOS P', 'CDMX TAPO', 'Bultos', '5 cajas de ropa',
                     'POR COBRAR EN DESTINO', 'credencial']) {
      expect(p).toContain(t);
    }
  });

  it('pagado en efectivo no habla de cobrar; transferencia por confirmar sí lo avisa', () => {
    const pagado = papel(renderReciboEnvio(
      { ...BASE, modalidad: 'pagado', estadoPago: 'pagado', porCobrar: 0, metodo: 'efectivo' },
      { hmacKey: CLAVE },
    ));
    expect(pagado).not.toContain('POR COBRAR');
    expect(pagado).toContain('Efectivo');

    const transf = papel(renderReciboEnvio(
      { ...BASE, modalidad: 'pagado', estadoPago: 'por_confirmar', porCobrar: 0, metodo: 'transferencia' },
      { hmacKey: CLAVE },
    ));
    expect(transf).toContain('POR CONFIRMAR');
  });

  it('respeta el ancho de la impresora', () => {
    for (const cols of [32, 48]) {
      for (const l of papel(renderReciboEnvio(BASE, { cols, hmacKey: CLAVE })).split('\n')) {
        expect(l.length).toBeLessThanOrEqual(cols);
      }
    }
  });
});

describe('ticket por bulto', () => {
  it('muestra n/N, el destino, quién recoge y POR COBRAR', () => {
    const p = papel(renderEtiquetaEnvio({ ...BASE, bulto: 2 }, { hmacKey: CLAVE }));
    expect(p).toContain('2/5');
    expect(p).toContain('FOLIO 1A2B3C');
    expect(p).toContain('DESTINO: CDMX TAPO');
    expect(p).toContain('CARLOS P');
    expect(p).toContain('POR COBRAR');
  });

  it('pagado: el ticket no dice POR COBRAR', () => {
    const p = papel(renderEtiquetaEnvio(
      { ...BASE, bulto: 1, modalidad: 'pagado', estadoPago: 'pagado', porCobrar: 0 }, { hmacKey: CLAVE },
    ));
    expect(p).not.toContain('POR COBRAR');
  });
});

describe('QR de paquetería', () => {
  it('el del recibo va firmado, lleva el monto por cobrar y no se confunde con un boleto', () => {
    const qr = buildQrEnvio({
      folio: '1A2B3C', remitente: 'Rosa Pérez', destinatario: 'Carlos Pérez López',
      destinatarioTelefono: '55 3333 4444', origen: 'Huajuapan', destino: 'CDMX TAPO',
      fechaHora: '2026-11-04 07:00', bultos: 5, importe: '800.00', modalidad: 'por_cobrar',
      porCobrar: '800.00',
    }, { key: CLAVE });
    expect(qr.startsWith('DONAJI-ENV|')).toBe(true);
    const v = verifyQrText(qr, CLAVE);
    expect(v.valid).toBe(true);
    expect(v.fields).toMatchObject({ F: '1A2B3C', B: '5', M: 'POR COBRAR', PC: '800.00', DE: 'CARLOS PEREZ LOPEZ' });
    expect(verifyQrText(qr.replace('PC:800.00', 'PC:1.00'), CLAVE).valid).toBe(false);
  });

  it('el de cada bulto lleva su numeración n/N', () => {
    const qr = buildQrBulto({ folio: '1A2B3C', bulto: 3, bultos: 5, destino: 'CDMX', destinatario: 'Carlos' },
      { key: CLAVE });
    expect(qr.startsWith('DONAJI-BUL|')).toBe(true);
    expect(verifyQrText(qr, CLAVE)).toMatchObject({ valid: true, fields: { N: '3/5' } });
  });
});
