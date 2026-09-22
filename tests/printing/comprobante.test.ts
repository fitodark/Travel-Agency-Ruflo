import { describe, expect, it } from 'vitest';
import {
  renderComprobanteReserva, type ConfigComprobante, type DatosComprobante,
} from '../../src/printing/templates/comprobante.js';
import { stripCommands } from '../../src/printing/transport/capture.js';

const COMPROBANTE: DatosComprobante = {
  folios: ['7K3M9A', '7K3M9B'],
  clienteNombre: 'Juana Perez',
  clienteTelefono: '953 111 2222',
  pasajeros: [
    { nombre: 'Ana Ruiz', asiento: 2, importe: 450 },
    { nombre: 'Beto Sosa', asiento: 3, importe: 450 },
  ],
  origen: { nombre: 'Terminal Huajuapan', direccion: 'Av. Hidalgo 214, Centro', telefono: '953 532 0000' },
  destino: 'Terminal Oaxaca',
  fechaHoraViaje: '2026-03-14 07:00',
  importeTotal: 900,
  pagado: 300,
  saldoPendiente: 600,
  sucursalCobro: 'Huajuapan',
  vendedor: 'Nicolas Ibanez',
  generadoEn: '2026-03-13 18:42',
};

const CFG: ConfigComprobante = {
  leyendaPie: 'Buen viaje, estamos para servirle.',
  telefonosAtencion: 'Atención: 953 532 0000',
  proveedor: 'Fi.TechServices',
};

const paper = (c: DatosComprobante, cfg: ConfigComprobante = CFG): string =>
  stripCommands(renderComprobanteReserva(c, cfg));

describe('comprobante de anticipo (Ses. 71)', () => {
  it('lleva todos los folios de la venta, no solo uno', () => {
    const p = paper(COMPROBANTE);
    expect(p).toContain('7K3M9A');
    expect(p).toContain('7K3M9B');
  });

  it('un solo folio se muestra en el renglón del título, no en una lista', () => {
    const p = paper({ ...COMPROBANTE, folios: ['7K3M9A'] });
    expect(p).toContain('FOLIO');
    expect(p).not.toContain('FOLIOS');
  });

  it('etiqueta el anticipo con el cliente que reservó (no necesariamente el pasajero)', () => {
    const p = paper(COMPROBANTE);
    expect(p).toContain('Juana Perez');
    expect(p).toContain('953 111 2222');
  });

  it('sin cliente registrado no revienta: dice explícitamente que no hay uno', () => {
    const p = paper({ ...COMPROBANTE, clienteNombre: null });
    expect(p).toContain('(sin registrar)');
  });

  it('lista cada pasajero con su asiento', () => {
    const p = paper(COMPROBANTE);
    expect(p).toContain('ANA RUIZ');
    expect(p).toContain('BETO SOSA');
    expect(p).toContain('02');
    expect(p).toContain('03');
  });

  it('muestra ruta, total, abonado y el saldo que falta cubrir', () => {
    const p = paper(COMPROBANTE);
    expect(p).toContain('Terminal Oaxaca');
    expect(p).toContain('2026-03-14 07:00');
    expect(p).toContain('$900.00');
    expect(p).toContain('$300.00');
    expect(p).toContain('$600.00');
    expect(p).toContain('SALDO');
  });

  it('indica dónde liquidar: la sucursal de origen', () => {
    expect(paper(COMPROBANTE)).toMatch(/origen/i);
  });

  it('nunca imprime boletos de abordar (esto es solo el comprobante del anticipo)', () => {
    // "IMPORTE" en mayúsculas y en negrita es la etiqueta propia de `renderBoleto`
    // (boleto.ts) — su ausencia aquí marca que este es un documento distinto.
    expect(paper(COMPROBANTE)).not.toContain('IMPORTE');
  });

  it('respeta el ancho configurado', () => {
    const angosto = paper(COMPROBANTE, { ...CFG, cols: 32 });
    for (const line of angosto.split('\n')) expect(line.length).toBeLessThanOrEqual(32);
  });

  it('termina en corte de papel', () => {
    const bytes = renderComprobanteReserva(COMPROBANTE, CFG);
    expect(bytes.subarray(-4)).toEqual(Buffer.from([0x1d, 0x56, 66, 3]));
  });
});
