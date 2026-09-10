/**
 * Fase 6c-1 — cancelación de boleto / reserva con reembolso (D9).
 *
 *   - hasta 1 h antes de la salida del origen;
 *   - libera el asiento (`estado='liberado'`), cancela boleto + venta;
 *   - pago confirmado (efectivo / transferencia verificada) ⇒ egreso `devolucion`
 *     en el corte abierto de la sucursal que cancela;
 *   - pago `corresponsal` ⇒ error (N-13, pendiente).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { cancelarBoleto } from '../../src/fleet/abordaje.js';
import { saldoCorte } from '../../src/caja/corte.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('cancelación de boleto (PostgreSQL real)', () => {
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
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    return { fx, usuarioId, corteId };
  };

  const pax = (asiento: number, nombre = 'Pax') => ({ asientoNum: asiento, nombre, importe: 450 });

  it('cancela una reserva sin pagar: libera el asiento, sin reembolso', async () => {
    const { fx, usuarioId } = await prep();
    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true, pasajeros: [pax(4)],
    });

    const c = await cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
      motivo: 'el pasajero ya no viaja',
    });
    expect(c.ventaCancelada).toBe(true);
    expect(c.reembolsoId).toBeNull();

    const { rows: b } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.boleto WHERE id = $1`, [r.boletos[0]!.boletoId],
    );
    expect(b[0]!.estado).toBe('cancelado');
    const { rows: o } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.asiento_ocupacion WHERE boleto_id = $1`, [r.boletos[0]!.boletoId],
    );
    expect(o[0]!.estado).toBe('liberado');
  });

  it('cancela una venta pagada en efectivo: registra el reembolso (egreso) en el corte', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [pax(4)],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
    });
    const saldoAntes = await saldoCorte(db, corteId);

    const c = await cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
    });
    expect(c.reembolsoMonto).toBe(450);

    const { rows: mc } = await db.query<{ tipo: string; origen_tipo: string; monto: string }>(
      `SELECT tipo, origen_tipo, monto FROM core.movimiento_caja WHERE id = $1`, [c.reembolsoId],
    );
    expect(mc[0]).toMatchObject({ tipo: 'egreso', origen_tipo: 'devolucion' });
    expect(Number(mc[0]!.monto)).toBe(450);

    // El corte: entró el pago y salió el reembolso → neto 0.
    const saldoDespues = await saldoCorte(db, corteId);
    expect(saldoDespues!.egresos).toBe(saldoAntes!.egresos + 450);
    expect(saldoDespues!.saldoCalculado).toBe(saldoAntes!.saldoCalculado - 450);
  });

  it('un pago corresponsal no se puede reembolsar por sistema (N-13)', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const { rows: ag } = await db.query<{ agencia_id: string }>(
      `SELECT agencia_id FROM core.sucursal WHERE id = $1`, [fx.sucursales[0]!],
    );
    const { rows: sc } = await db.query<{ id: string }>(
      `INSERT INTO core.sucursal (agencia_id, nombre, direccion_completa, telefono_principal,
                                  codigo, zona_horaria, sin_sistema)
       SELECT $1, 'Tamazulapan', 'Carretera', '953 0', c, 'America/Mexico_City', true
         FROM unnest(string_to_array('ABCDEFGHJKMNPQRSTVWXYZ23456789', NULL)) c
        WHERE c NOT IN (SELECT codigo FROM core.sucursal) LIMIT 1
       RETURNING id`, [ag[0]!.agencia_id],
    );
    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true, pasajeros: [pax(4)],
      pago: { metodo: 'corresponsal', monto: 450, corteCajaId: corteId, sucursalCobroId: sc[0]!.id },
    });

    await expect(cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
    })).rejects.toThrow(/corresponsal/i);
  });

  it('no se puede cancelar a menos de 1 h de la salida', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 1 });
    const usuarioId = await crearUsuario(db);
    await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const { rows } = await db.query<{ h: Date }>(
      `SELECT hora_paso_programada AS h FROM core.salida_parada WHERE salida_id = $1 AND orden = 0`,
      [fx.salidaId],
    );
    const t30 = new Date(rows[0]!.h.getTime() - 30 * 60_000);

    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true, pasajeros: [pax(4)],
    });
    await expect(cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!, ahora: t30,
    })).rejects.toThrow(/1 h de la salida/i);
  });

  it('en una venta de dos boletos, cancelar uno no cancela la venta', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [pax(4, 'Ana'), pax(5, 'Beto')],
      pago: { metodo: 'efectivo', monto: 900, corteCajaId: corteId },
    });

    const c = await cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
    });
    expect(c.ventaCancelada).toBe(false);

    const { rows: v } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.venta WHERE id = $1`, [r.ventaId],
    );
    expect(v[0]!.estado).not.toBe('cancelada');
    const { rows: vivos } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.boleto WHERE venta_id = $1 AND estado <> 'cancelado'`, [r.ventaId],
    );
    expect(Number(vivos[0]!.n)).toBe(1);
  });

  it('rechaza cancelar un boleto ya cancelado', async () => {
    const { fx, usuarioId } = await prep();
    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true, pasajeros: [pax(4)],
    });
    await cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
    });
    await expect(cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
    })).rejects.toThrow(/ya está cancelado/i);
  });
});
