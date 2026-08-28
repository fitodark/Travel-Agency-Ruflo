/**
 * Reportes de operación del dashboard (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8, slice 1)
 *                  CONTRADICCIÓN C5
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { abrirCorte, cerrarCorte } from '../../src/caja/corte.js';
import { registrarEgreso } from '../../src/caja/movimiento.js';
import {
  reporteCortes, reporteIngresosCaja, reporteVentas, ventasVsCaja,
} from '../../src/dashboard/operacion.js';
import { registrarPago, registrarVenta } from '../../src/ventas/venta.js';
import { antesDelCierre, crearUsuario, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const RANGO = { desde: '2020-01-01', hasta: '2100-01-01' } as const;

run('dashboard · reportes de operación (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await abrirCorte(db, {
      sucursalId: fx.sucursales[0]!, usuarioId, saldoInicial: 500,
    });
    const ahora = await antesDelCierre(db, fx.salidaId, 0);
    return { fx, usuarioId, corteId, ahora };
  };

  const soloDe = <T extends { sucursalId: string }>(rows: T[], sucursalId: string) =>
    rows.filter((r) => r.sucursalId === sucursalId);

  // -------------------------------------------------------------------------
  it('reporte de ventas: operaciones, boletos, importe vendido y liquidado', async () => {
    const c = await prep();
    await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [
        { asientoNum: 2, nombre: 'Ana', importe: 450 },
        { asientoNum: 3, nombre: 'Beto', importe: 450 },
      ],
      pago: { metodo: 'efectivo', monto: 900, corteCajaId: c.corteId },
      ahora: c.ahora,
    });

    const filas = soloDe(await reporteVentas(db, RANGO), c.fx.sucursales[0]!);
    const total = filas.reduce((a, f) => ({
      operaciones: a.operaciones + f.operaciones,
      boletos: a.boletos + f.boletos,
      reservaciones: a.reservaciones + f.reservaciones,
      importeVendido: a.importeVendido + f.importeVendido,
      importeLiquidado: a.importeLiquidado + f.importeLiquidado,
    }), { operaciones: 0, boletos: 0, reservaciones: 0, importeVendido: 0, importeLiquidado: 0 });

    expect(total).toEqual({
      operaciones: 1, boletos: 2, reservaciones: 0,
      importeVendido: 900, importeLiquidado: 900,
    });
  });

  it('una reservación sin pago cuenta como reservación y no como liquidada', async () => {
    const c = await prep();
    await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 2, nombre: 'Ana', importe: 450 }],
      esReservacion: true, ahora: c.ahora,
    });

    const filas = soloDe(await reporteVentas(db, RANGO), c.fx.sucursales[0]!);
    expect(filas.reduce((a, f) => a + f.reservaciones, 0)).toBe(1);
    expect(filas.reduce((a, f) => a + f.importeLiquidado, 0)).toBe(0);
    expect(filas.reduce((a, f) => a + f.importeVendido, 0)).toBe(450);
  });

  it('C5: la reservación cobrada en destino es venta en el origen e ingreso en el destino', async () => {
    const c = await prep();
    const r = await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 2, nombre: 'Ana', importe: 450 }],
      esReservacion: true, ahora: c.ahora,
    });
    const cobrador = await crearUsuario(db);
    const corteDestino = await abrirCorte(db, {
      sucursalId: c.fx.sucursales[3]!, usuarioId: cobrador, saldoInicial: 100,
    });
    await registrarPago(db, {
      ventaId: r.ventaId, sucursalCobroId: c.fx.sucursales[3]!, usuarioId: cobrador,
      metodo: 'efectivo', monto: 450, corteCajaId: corteDestino, ahora: c.ahora,
    });

    const ventas = await reporteVentas(db, RANGO);
    expect(soloDe(ventas, c.fx.sucursales[0]!).reduce((a, f) => a + f.importeVendido, 0)).toBe(450);
    expect(soloDe(ventas, c.fx.sucursales[3]!).reduce((a, f) => a + f.importeVendido, 0)).toBe(0);

    const caja = await reporteIngresosCaja(db, RANGO);
    expect(soloDe(caja, c.fx.sucursales[3]!).reduce((a, f) => a + f.totalConfirmado, 0)).toBe(450);
    expect(soloDe(caja, c.fx.sucursales[0]!).reduce((a, f) => a + f.totalConfirmado, 0)).toBe(0);

    const vc = await ventasVsCaja(db, RANGO.desde, RANGO.hasta);
    const origen = vc.find((x) => x.sucursal === soloDe(ventas, c.fx.sucursales[0]!)[0]!.sucursal)!;
    expect(origen.diferencia).toBe(-450);
    expect(origen.nota).toMatch(/C5/);
  });

  it('una transferencia sin verificar va a pendiente, no a total confirmado', async () => {
    const c = await prep();
    await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 2, nombre: 'Ana', importe: 450 }],
      pago: { metodo: 'transferencia', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
    });

    const caja = soloDe(await reporteIngresosCaja(db, RANGO), c.fx.sucursales[0]!);
    expect(caja.reduce((a, f) => a + f.totalConfirmado, 0)).toBe(0);
    expect(caja.reduce((a, f) => a + f.transferenciaPendiente, 0)).toBe(450);
  });

  it('reporte de cortes: saldo inicial, egresos, declarado vs calculado', async () => {
    const c = await prep();
    await registrarEgreso(db, {
      corteId: c.corteId, usuarioId: c.usuarioId, monto: 80, descripcion: 'papel',
    });
    await cerrarCorte(db, {
      corteId: c.corteId, usuarioCierreId: c.usuarioId, saldoDeclarado: 430,
    });

    const cortes = (await reporteCortes(db, RANGO)).filter((x) => x.corteId === c.corteId);
    expect(cortes).toHaveLength(1);
    expect(cortes[0]).toMatchObject({
      estado: 'cerrado', saldoInicial: 500, egresos: 80,
      saldoCalculado: 420, saldoDeclarado: 430, diferencia: 10,
    });
  });

  it('el rango de fechas excluye lo que cae fuera', async () => {
    const c = await prep();
    await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 2, nombre: 'Ana', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
    });
    const viejo = await reporteVentas(db, { desde: '2019-01-01', hasta: '2019-12-31' });
    expect(soloDe(viejo, c.fx.sucursales[0]!)).toHaveLength(0);
  });
});
