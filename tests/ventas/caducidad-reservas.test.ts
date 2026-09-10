/**
 * Fase 6b — caducidad de reservas sin pagar (D9).
 *
 *   - una reserva sin ningún pago caduca 1 h antes de la salida del origen;
 *   - liberación PEREZOSA: la materializa `asientos_libres` (lectura),
 *     `adquirir_lease` y `registrar_venta` (escritura), no un job nocturno;
 *   - solo las reservas SIN pago se auto-liberan (el abono parcial → 6c).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { buscarSalidas } from '../../src/ventas/busqueda.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('caducidad de reservas sin pagar (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 1 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const { rows } = await db.query<{ h: Date }>(
      `SELECT hora_paso_programada AS h FROM core.salida_parada
        WHERE salida_id = $1 AND orden = 0`, [fx.salidaId],
    );
    const horaSalida = rows[0]!.h;
    // 30 min antes de la salida: pasado el corte de caducidad (T-1h) pero antes
    // del cierre de venta (T-15min).
    const t30 = new Date(horaSalida.getTime() - 30 * 60_000);
    return { fx, usuarioId, corteId, horaSalida, t30 };
  };

  const reservar = (fx: Awaited<ReturnType<typeof seedSalida>>, usuarioId: string, asiento: number) =>
    registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true,
      pasajeros: [{ asientoNum: asiento, nombre: 'Reservado', importe: 450 }],
    });

  it('una reserva sin pagar libera su asiento a T-1h; la venta y el boleto quedan cancelados', async () => {
    const { fx, usuarioId, t30 } = await prep();
    const r = await reservar(fx, usuarioId, 5);

    // Antes de T-1h el asiento sigue ocupado.
    const antes = await buscarSalidas(db, {
      fecha: fx.fechaOperacion, sucursalOrigenId: fx.puntos[0]!, sucursalDestinoId: fx.puntos[3]!,
      nPersonas: 1, sucursalVendedoraId: fx.sucursales[0]!,
    });
    expect(antes.find((s) => s.salidaId === fx.salidaId)!.asientosOfrecibles).not.toContain(5);

    // A T-30min (pasado T-1h) `asientos_libres` ya no lo cuenta (lectura).
    const despues = await buscarSalidas(db, {
      fecha: fx.fechaOperacion, sucursalOrigenId: fx.puntos[0]!, sucursalDestinoId: fx.puntos[3]!,
      nPersonas: 1, sucursalVendedoraId: fx.sucursales[0]!, ahora: t30,
    });
    expect(despues.find((s) => s.salidaId === fx.salidaId)!.asientosOfrecibles).toContain(5);

    // Otra venta del asiento 5 a T-30min tiene éxito (la caduca se materializó).
    const r2 = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 999 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Nuevo', importe: 450 }],
      ahora: t30,
    });
    expect(r2.boletos[0]!.asientoNum).toBe(5);

    // La reserva vieja: boleto y venta cancelados, ocupación liberada.
    const { rows: b } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.boleto WHERE id = $1`, [r.boletos[0]!.boletoId],
    );
    expect(b[0]!.estado).toBe('cancelado');
    const { rows: v } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.venta WHERE id = $1`, [r.ventaId],
    );
    expect(v[0]!.estado).toBe('cancelada');
    const { rows: o } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.asiento_ocupacion WHERE boleto_id = $1`, [r.boletos[0]!.boletoId],
    );
    expect(o[0]!.estado).toBe('liberado');
  });

  it('una reserva con abono parcial NO se auto-libera', async () => {
    const { fx, usuarioId, corteId, t30 } = await prep();
    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true,
      pasajeros: [{ asientoNum: 7, nombre: 'Con abono', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 100, esAbono: true, corteCajaId: corteId },
    });

    const despues = await buscarSalidas(db, {
      fecha: fx.fechaOperacion, sucursalOrigenId: fx.puntos[0]!, sucursalDestinoId: fx.puntos[3]!,
      nPersonas: 1, sucursalVendedoraId: fx.sucursales[0]!, ahora: t30,
    });
    expect(despues.find((s) => s.salidaId === fx.salidaId)!.asientosOfrecibles).not.toContain(7);

    const { rows: b } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.boleto WHERE id = $1`, [r.boletos[0]!.boletoId],
    );
    expect(b[0]!.estado).toBe('emitido');
  });

  it('una venta liquidada (no reserva) nunca caduca', async () => {
    const { fx, usuarioId, corteId, t30 } = await prep();
    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 9, nombre: 'Pagado', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
    });

    const despues = await buscarSalidas(db, {
      fecha: fx.fechaOperacion, sucursalOrigenId: fx.puntos[0]!, sucursalDestinoId: fx.puntos[3]!,
      nPersonas: 1, sucursalVendedoraId: fx.sucursales[0]!, ahora: t30,
    });
    expect(despues.find((s) => s.salidaId === fx.salidaId)!.asientosOfrecibles).not.toContain(9);
    const { rows } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.boleto WHERE id = $1`, [r.boletos[0]!.boletoId],
    );
    expect(rows[0]!.estado).toBe('emitido');
  });
});
