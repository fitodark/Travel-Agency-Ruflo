import { describe, expect, it } from 'vitest';
import {
  renderManifiesto,
  type ConfigManifiesto,
  type DatosManifiesto,
} from '../../src/printing/templates/manifiesto.js';
import { stripCommands } from '../../src/printing/transport/capture.js';

const BASE: Omit<DatosManifiesto, 'copia' | 'pasajeros'> = {
  salida_id: '00000000-0000-7000-8000-000000000001',
  fecha_operacion: '2026-09-12',
  estado_salida: 'programada',
  conductor: 'Juan Pérez García',
  unidad: 'ECO-142',
  tipo_unidad: 'AUTOBUS',
  generado_en: '2026-09-12T06:40:00+00:00',
  paradas: [
    { orden: 0, punto: 'Huajuapan', tipo: 'terminal', hora_paso: '2026-09-12T07:00:00+00:00' },
    { orden: 1, punto: 'Nochixtlan', tipo: 'terminal', hora_paso: '2026-09-12T08:30:00+00:00' },
    { orden: 2, punto: 'Tamazulapan', tipo: 'parada', hora_paso: null },
    { orden: 3, punto: 'Oaxaca', tipo: 'terminal', hora_paso: '2026-09-12T10:00:00+00:00' },
  ],
};

const pasajeros = (): DatosManifiesto['pasajeros'] => [
  {
    folio: '7K3M9A', asiento: 2, nombre: 'María de los Ángeles Muñoz',
    sube_en: 'Huajuapan', sube_en_orden: 0, baja_en: 'Oaxaca', baja_en_orden: 3,
    estatus_pago: 'pagado', conflicto: false,
  },
  {
    folio: 'B2X1QP', asiento: 3, nombre: 'Juan Pérez',
    sube_en: 'Huajuapan', sube_en_orden: 0, baja_en: 'Tamazulapan', baja_en_orden: 2,
    estatus_pago: 'pendiente', conflicto: true,
  },
  {
    folio: 'M9K2L1', asiento: 8, nombre: 'Ana Ruiz',
    sube_en: 'Nochixtlan', sube_en_orden: 1, baja_en: 'Oaxaca', baja_en_orden: 3,
    estatus_pago: 'pagado', conflicto: false,
  },
];

const TERMINAL: DatosManifiesto = { ...BASE, copia: 'terminal', pasajeros: pasajeros() };
const CONDUCTOR: DatosManifiesto = { ...BASE, copia: 'conductor', pasajeros: pasajeros() };

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

  it('es una lista única por pasajero con casilla, asiento, sube y baja', () => {
    const p = paper(TERMINAL);
    expect(p).toContain('[ ] 02');
    expect(p).toContain('[ ] 03');
    expect(p).toContain('[ ] 08');
    expect(p).toContain('sube: Huajuapan');
    expect(p).toContain('sube: Nochixtlan');
    expect(p).toContain('Oaxaca');
    expect(p).toContain('Tamazulapan');
  });

  it('ordena los renglones por punto de ascenso y luego asiento', () => {
    // El render preserva el orden del arreglo; la SQL ya lo entrega ordenado.
    const p = paper(TERMINAL);
    const i2 = p.indexOf('[ ] 02');
    const i3 = p.indexOf('[ ] 03');
    const i8 = p.indexOf('[ ] 08');
    expect(i2).toBeLessThan(i3);
    expect(i3).toBeLessThan(i8);
  });

  it('nunca imprime importe ni saldo ni ocupación por tramo, en ninguna copia', () => {
    for (const m of [TERMINAL, CONDUCTOR]) {
      const p = paper(m);
      expect(p).not.toContain('$');
      expect(p).not.toContain('SALDO');
      expect(p).not.toContain('OCUPACION POR TRAMO');
    }
  });

  it('las dos copias llevan el mismo cuerpo de pasajeros', () => {
    const cuerpo = (m: DatosManifiesto): string => {
      const p = paper(m).split('\n');
      const desde = p.findIndex((l) => l.startsWith('[ ]'));
      const hasta = p.findIndex((l) => l.includes('TOTAL PASAJEROS'));
      return p.slice(desde, hasta).join('\n');
    };
    expect(cuerpo(TERMINAL)).toEqual(cuerpo(CONDUCTOR));
  });

  it('marca los pasajeros con pago pendiente y los cuenta', () => {
    const p = paper(TERMINAL);
    expect(p).toContain('** PAGO PENDIENTE **');
    expect(p).toContain('PENDIENTES DE PAGO: 1');
  });

  it('no marca pendiente cuando todos están pagados', () => {
    const todosPagados: DatosManifiesto = {
      ...TERMINAL,
      pasajeros: pasajeros().map((x) => ({ ...x, estatus_pago: 'pagado' as const })),
    };
    const p = paper(todosPagados);
    expect(p).not.toContain('PAGO PENDIENTE');
    expect(p).not.toContain('PENDIENTES DE PAGO');
  });

  it('marca los boletos en conflicto de sobreventa', () => {
    const p = paper(TERMINAL);
    expect(p).toContain('!! CONFLICTO DE SOBREVENTA');
    expect(p).toContain('BOLETOS EN CONFLICTO: 1');
  });

  it('lista "sin pasajeros" en vez de un cuerpo vacío', () => {
    expect(paper({ ...TERMINAL, pasajeros: [] })).toContain('(sin pasajeros en esta salida)');
  });

  it('cuenta el total de pasajeros', () => {
    expect(paper(TERMINAL)).toContain('TOTAL PASAJEROS: 3');
    expect(paper({ ...TERMINAL, pasajeros: [] })).toContain('TOTAL PASAJEROS: 0');
  });

  it('la línea de firma cambia según la copia', () => {
    expect(paper(CONDUCTOR)).toContain('Firma del conductor:');
    expect(paper(TERMINAL)).toContain('Responsable de terminal:');
  });

  it('marca "sin asignar" cuando la salida no tiene conductor', () => {
    expect(paper({ ...CONDUCTOR, conductor: null })).toContain('sin asignar');
  });

  it('resalta un estado de salida distinto de programada', () => {
    expect(paper({ ...TERMINAL, estado_salida: 'en_ruta' })).toContain('EN_RUTA');
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
