/**
 * Export semanal de reportes (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8, slice 3), R11
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { abrirCorte } from '../../src/caja/corte.js';
import {
  escribirBundle, etiquetaSemana, generarBundleSemanal, rangoSemanaAnterior,
} from '../../src/dashboard/export.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { antesDelCierre, crearUsuario, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

describe('export semanal · rango y etiqueta (puro)', () => {
  it('`rangoSemanaAnterior` toma la última semana completa lunes–domingo', () => {
    // Miércoles 2026-09-02 → semana pasada = lun 24 ago .. dom 30 ago.
    expect(rangoSemanaAnterior(new Date('2026-09-02T10:00:00Z'))).toEqual({
      desde: '2026-08-24', hasta: '2026-08-30',
    });
    // Un lunes: la semana pasada sigue siendo la anterior completa.
    expect(rangoSemanaAnterior(new Date('2026-08-31T00:00:00Z'))).toEqual({
      desde: '2026-08-24', hasta: '2026-08-30',
    });
    // Un domingo cuenta como parte de la semana en curso, aún incompleta.
    expect(rangoSemanaAnterior(new Date('2026-08-30T23:00:00Z'))).toEqual({
      desde: '2026-08-17', hasta: '2026-08-23',
    });
  });

  it('`etiquetaSemana` da el número ISO de semana', () => {
    expect(etiquetaSemana('2026-08-24')).toBe('2026-W35');
    expect(etiquetaSemana('2026-01-01')).toBe('2026-W01');
  });
});

run('export semanal · bundle (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  it('arma el bundle con todos los reportes y una venta seedeada', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const u = await crearUsuario(db);
    const corteId = await abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500 });
    const ahora = await antesDelCierre(db, fx.salidaId, 0);
    await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId: u,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 2, nombre: 'Ana', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      ahora,
    });

    const t = new Date('2026-09-15T03:00:00Z');
    const bundle = await generarBundleSemanal(
      db, { desde: '2020-01-01', hasta: '2100-01-01' }, t,
    );

    expect(bundle.rango.generadoEn).toBe(t.toISOString());
    expect(bundle.rango.etiqueta).toMatch(/^\d{4}-W\d{2}$/);
    expect(bundle.ventas.length).toBeGreaterThanOrEqual(1);
    expect(bundle.cortes.length).toBeGreaterThanOrEqual(1);
    expect(bundle.ventasVsCaja.length).toBeGreaterThanOrEqual(1);
    expect(bundle.excepcionesResumen).toHaveProperty('critica');
    expect(Array.isArray(bundle.inactivos)).toBe(true);
  });

  it('`escribirBundle` vuelca los JSON a una carpeta por semana', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'donaji-export-'));
    try {
      const bundle = await generarBundleSemanal(
        db, { desde: '2020-01-01', hasta: '2100-01-01' }, new Date('2026-09-15T03:00:00Z'),
      );
      const rutas = await escribirBundle(bundle, dir);
      expect(rutas.length).toBe(10);
      expect(rutas.every((r) => r.includes(bundle.rango.etiqueta))).toBe(true);

      const rango = JSON.parse(
        await readFile(path.join(dir, bundle.rango.etiqueta, 'rango.json'), 'utf8'),
      );
      expect(rango.etiqueta).toBe(bundle.rango.etiqueta);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
