import { describe, expect, it } from 'vitest';
import {
  renderManifiesto,
  type ConfigManifiesto,
  type DatosManifiesto,
} from '../../src/printing/templates/manifiesto.js';
import { stripCommands } from '../../src/printing/transport/capture.js';

const BASE: Omit<DatosManifiesto, 'copia' | 'ascensos' | 'ocupacion_por_tramo'> = {
  salida_id: '00000000-0000-7000-8000-000000000001',
  fecha_operacion: '2026-09-12',
  estado_salida: 'programada',
  conductor: 'Juan Pérez García',
  unidad: 'ECO-142',
  tipo_unidad: 'AUTOBUS',
  generado_en: '2026-09-12T06:40:00+00:00',
  paradas: [
    { orden: 0, sucursal: 'Huajuapan', hora_paso: '2026-09-12T07:00:00+00:00' },
    { orden: 1, sucursal: 'Nochixtlán', hora_paso: '2026-09-12T08:30:00+00:00' },
    { orden: 2, sucursal: 'Oaxaca', hora_paso: '2026-09-12T10:00:00+00:00' },
  ],
};

const ascensosTerminal = (): DatosManifiesto['ascensos'] => [
  {
    parada_orden: 0,
    sucursal: 'Huajuapan',
    pasajeros: [
      { folio: '7K3M9A', asiento: 2, nombre: 'María de los Ángeles Muñoz', destino_orden: 2, destino: 'Oaxaca', conflicto: false, importe: 450, saldo_pendiente: 0 },
      { folio: 'B2X1QP', asiento: 3, nombre: 'Juan Pérez', destino_orden: 2, destino: 'Oaxaca', conflicto: true, importe: 450, saldo_pendiente: 200 },
    ],
  },
  {
    parada_orden: 1,
    sucursal: 'Nochixtlán',
    pasajeros: [
      { folio: 'M9K2L1', asiento: 8, nombre: 'Ana Ruiz', destino_orden: 2, destino: 'Oaxaca', conflicto: false, importe: 180, saldo_pendiente: 0 },
    ],
  },
];

const CONDUCTOR: DatosManifiesto = {
  ...BASE,
  copia: 'conductor',
  ascensos: [
    {
      parada_orden: 0,
      sucursal: 'Huajuapan',
      pasajeros: [
        { folio: '7K3M9A', asiento: 2, nombre: 'María de los Ángeles Muñoz', destino_orden: 2, destino: 'Oaxaca', conflicto: false },
        { folio: 'B2X1QP', asiento: 3, nombre: 'Juan Pérez', destino_orden: 1, destino: 'Nochixtlán', conflicto: false },
      ],
    },
    { parada_orden: 1, sucursal: 'Nochixtlán', pasajeros: [] },
  ],
};

const TERMINAL: DatosManifiesto = {
  ...BASE,
  copia: 'terminal',
  ascensos: ascensosTerminal(),
  ocupacion_por_tramo: [
    { tramo: '[0,1)', vendidos: 12 },
    { tramo: '[1,2)', vendidos: 9 },
  ],
};

const paper = (m: DatosManifiesto, c: ConfigManifiesto = {}): string =>
  stripCommands(renderManifiesto(m, c));

describe('manifiesto', () => {
  it('lleva título, copia, ruta y momento de generación', () => {
    const p = paper(TERMINAL);
    expect(p).toContain('MANIFIESTO DE ABORDAJE');
    expect(p).toContain('COPIA TERMINAL');
    expect(p).toContain('Huajuapan -> Oaxaca');
    expect(p).toContain('2026-09-12 06:40');
    expect(p).toContain('07:00');
  });

  it('agrupa los pasajeros por parada de ascenso con casilla para palomear', () => {
    const p = paper(CONDUCTOR);
    expect(p).toContain('ASCENSO 0 - Huajuapan');
    expect(p).toContain('ASCENSO 1 -');
    expect(p).toContain('[ ] 02');
    expect(p).toContain('[ ] 03');
  });

  it('la copia del conductor no lleva importes ni saldo ni ocupación por tramo', () => {
    const p = paper(CONDUCTOR);
    expect(p).not.toContain('$');
    expect(p).not.toContain('SALDO');
    expect(p).not.toContain('OCUPACION POR TRAMO');
  });

  it('la copia de terminal lleva importe, saldo pendiente y ocupación por tramo', () => {
    const p = paper(TERMINAL);
    expect(p).toContain('$450.00');
    expect(p).toContain('SALDO $200.00');
    expect(p).toContain('OCUPACION POR TRAMO');
    expect(p).toContain('[0,1)  12');
  });

  it('no imprime saldo cuando el pasajero está liquidado', () => {
    const p = paper(TERMINAL);
    const lineas = p.split('\n').filter((l) => l.includes('SALDO'));
    expect(lineas).toHaveLength(1); // solo el asiento 3
  });

  it('marca los boletos en conflicto de sobreventa', () => {
    const p = paper(TERMINAL);
    expect(p).toContain('!! CONFLICTO DE SOBREVENTA');
    expect(p).toContain('BOLETOS EN CONFLICTO: 1');
  });

  it('lista una parada sin pasajeros en vez de omitirla', () => {
    expect(paper(CONDUCTOR)).toContain('(sin pasajeros en esta parada)');
  });

  it('cuenta el total de pasajeros de todas las paradas', () => {
    expect(paper(TERMINAL)).toContain('TOTAL PASAJEROS: 3');
    expect(paper(CONDUCTOR)).toContain('TOTAL PASAJEROS: 2');
  });

  it('la línea de firma cambia según la copia', () => {
    expect(paper(CONDUCTOR)).toContain('Firma del conductor:');
    expect(paper(TERMINAL)).toContain('Responsable de terminal:');
  });

  it('marca "sin asignar" cuando la salida no tiene conductor', () => {
    const p = paper({ ...CONDUCTOR, conductor: null });
    expect(p).toContain('sin asignar');
  });

  it('resalta un estado de salida distinto de programada', () => {
    const p = paper({ ...TERMINAL, estado_salida: 'en_ruta' });
    expect(p).toContain('EN_RUTA');
  });

  it('respeta el ancho configurado sin reescribir la plantilla', () => {
    for (const cols of [32, 48, 64]) {
      const angosto = paper(TERMINAL, { cols });
      for (const line of angosto.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('termina en corte de papel', () => {
    const bytes = renderManifiesto(TERMINAL);
    expect(bytes.subarray(-4)).toEqual(Buffer.from([0x1d, 0x56, 66, 3]));
  });
});
