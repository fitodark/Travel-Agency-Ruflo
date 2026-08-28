/**
 * Movimientos de caja: ingreso por pago, egresos, anulación y rol (PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F6)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { abrirCorte, cerrarCorte, saldoCorte } from '../../src/caja/corte.js';
import { anularMovimiento, movimientosDeCorte, registrarEgreso } from '../../src/caja/movimiento.js';
import {
  registrarPago, registrarVenta, verificarTransferencia,
} from '../../src/ventas/venta.js';
import {
  antesDelCierre, crearUsuario, seedSalida,
} from '../ventas/fixture.js';
import { esperaError } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('movimientos de caja (PostgreSQL real)', () => {
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

  const pasajero = { asientoNum: 2, nombre: 'Ana', importe: 450 };

  // -------------------------------------------------------------------------
  it('una venta pagada en efectivo suma un ingreso `pago_boleto` al corte', async () => {
    const c = await prep();
    await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [pasajero],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
    });

    const s = await saldoCorte(db, c.corteId);
    expect(s!.ingresos).toBe(450);
    expect(s!.saldoCalculado).toBe(950);

    const movs = await movimientosDeCorte(db, c.corteId, 'gerente');
    expect(movs).toHaveLength(1);
    expect(movs[0]).toMatchObject({ tipo: 'ingreso', origenTipo: 'pago_boleto', monto: 450 });
  });

  it('una transferencia no suma al corte hasta que se verifica', async () => {
    const c = await prep();
    const r = await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [pasajero],
      pago: { metodo: 'transferencia', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
    });
    expect((await saldoCorte(db, c.corteId))!.ingresos, 'sin verificar, cero').toBe(0);

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.pago WHERE venta_id = $1`, [r.ventaId],
    );
    await verificarTransferencia(db, rows[0]!.id, c.usuarioId, c.ahora);

    expect((await saldoCorte(db, c.corteId))!.ingresos, 'verificada, sí suma').toBe(450);
    const movs = await movimientosDeCorte(db, c.corteId, 'gerente');
    expect(movs.filter((m) => m.origenTipo === 'pago_boleto')).toHaveLength(1);
  });

  it('una reservación cobrada en destino suma al corte de la sucursal que cobra (C5)', async () => {
    const c = await prep();
    const r = await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [pasajero], esReservacion: true, ahora: c.ahora,
    });

    const cobrador = await crearUsuario(db);
    const corteDestino = await abrirCorte(db, {
      sucursalId: c.fx.sucursales[3]!, usuarioId: cobrador, saldoInicial: 200,
    });
    await registrarPago(db, {
      ventaId: r.ventaId, sucursalCobroId: c.fx.sucursales[3]!, usuarioId: cobrador,
      metodo: 'efectivo', monto: 450, corteCajaId: corteDestino, ahora: c.ahora,
    });

    expect((await saldoCorte(db, corteDestino))!.ingresos, 'suma en destino').toBe(450);
    expect((await saldoCorte(db, c.corteId))!.ingresos, 'no en el origen').toBe(0);
  });

  // -------------------------------------------------------------------------
  it('un egreso por insumo con descripción resta del corte', async () => {
    const c = await prep();
    await registrarEgreso(db, {
      corteId: c.corteId, usuarioId: c.usuarioId, monto: 120, descripcion: 'jabón y papel',
    });
    const s = await saldoCorte(db, c.corteId);
    expect(s!.egresos).toBe(120);
    expect(s!.saldoCalculado).toBe(380);
  });

  it('un egreso sin descripción lanza', async () => {
    const c = await prep();
    await expect(registrarEgreso(db, {
      corteId: c.corteId, usuarioId: c.usuarioId, monto: 50, descripcion: '   ',
    })).rejects.toThrow(/descripción/i);
  });

  it('anular un egreso devuelve el monto al corte; anular otra vez no hace nada', async () => {
    const c = await prep();
    const id = await registrarEgreso(db, {
      corteId: c.corteId, usuarioId: c.usuarioId, monto: 120, descripcion: 'foco',
    });
    expect((await saldoCorte(db, c.corteId))!.saldoCalculado).toBe(380);

    expect(await anularMovimiento(db, { movimientoId: id, usuarioId: c.usuarioId, motivo: 'error de captura' })).toBe(true);
    expect((await saldoCorte(db, c.corteId))!.saldoCalculado, 'el monto regresa').toBe(500);
    expect(await anularMovimiento(db, { movimientoId: id, usuarioId: c.usuarioId, motivo: 'x' }), 'idempotente').toBe(false);
  });

  it('el gerente no ve el egreso inactivo; el administrador sí', async () => {
    const c = await prep();
    const id = await registrarEgreso(db, {
      corteId: c.corteId, usuarioId: c.usuarioId, monto: 90, descripcion: 'café',
    });
    await anularMovimiento(db, { movimientoId: id, usuarioId: c.usuarioId, motivo: 'devuelto' });

    const gerente = await movimientosDeCorte(db, c.corteId, 'gerente');
    expect(gerente.find((m) => m.id === id), 'gerente: oculto').toBeUndefined();

    const admin = await movimientosDeCorte(db, c.corteId, 'administrador');
    const visto = admin.find((m) => m.id === id);
    expect(visto, 'admin: visible').toBeDefined();
    expect(visto!.activo).toBe(false);
  });

  it('no se registra ni se anula sobre un corte cerrado', async () => {
    const c = await prep();
    const id = await registrarEgreso(db, {
      corteId: c.corteId, usuarioId: c.usuarioId, monto: 30, descripcion: 'clips',
    });
    await cerrarCorte(db, { corteId: c.corteId, usuarioCierreId: c.usuarioId, saldoDeclarado: 470 });

    const e1 = await esperaError(db, () => registrarEgreso(db, {
      corteId: c.corteId, usuarioId: c.usuarioId, monto: 10, descripcion: 'más clips',
    }));
    expect(e1.message).toMatch(/cerrado/i);

    const e2 = await esperaError(db, () => anularMovimiento(db, {
      movimientoId: id, usuarioId: c.usuarioId, motivo: 'tarde',
    }));
    expect(e2.message).toMatch(/cerrado/i);
  });

  it('dar de baja un pago arrastra su ingreso fuera del corte', async () => {
    const c = await prep();
    const r = await registrarVenta(db, {
      salidaId: c.fx.salidaId, sucursalVentaId: c.fx.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [pasajero],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
    });
    expect((await saldoCorte(db, c.corteId))!.ingresos).toBe(450);

    await db.query(`UPDATE core.pago SET activo = false WHERE venta_id = $1`, [r.ventaId]);

    expect((await saldoCorte(db, c.corteId))!.ingresos, 'el ingreso sigue al pago').toBe(0);
    const admin = await movimientosDeCorte(db, c.corteId, 'administrador');
    expect(admin.find((m) => m.origenTipo === 'pago_boleto')!.activo).toBe(false);
  });
});
