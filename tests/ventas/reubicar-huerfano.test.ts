/**
 * Fase 6c-2 — reubicación de un boleto huérfano (N-14).
 *
 *   - huérfano YA PAGADO   → boleto nuevo al precio pagado, pago traspasado;
 *   - huérfano SIN pagar   → boleto nuevo a la tarifa vigente de la ruta nueva;
 *   - el boleto viejo queda `reasignado`, su asiento liberado, su venta cancelada.
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { reubicarHuerfano } from '../../src/fleet/abordaje.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('reubicación de huérfano (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const prep = async () => {
    const vieja = await seedSalida(db, { paradas: 3, diasAdelante: 15 });
    // La ruta nueva tiene una tarifa distinta (480) para el mismo tramo.
    const nueva = await seedSalida(db, { paradas: 3, diasAdelante: 15, tarifaImporte: 480 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, vieja.sucursales[0]!, usuarioId);
    return { vieja, nueva, usuarioId, corteId };
  };

  it('huérfano pagado: mantiene el precio y traspasa el pago (N-14)', async () => {
    const { vieja, nueva, usuarioId, corteId } = await prep();
    const v = await registrarVenta(db, {
      salidaId: vieja.salidaId, sucursalVentaId: vieja.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      pasajeros: [{ asientoNum: 4, nombre: 'Don Luis', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
    });
    const pagoId = (await db.query<{ id: string }>(
      `SELECT id FROM core.pago WHERE venta_id = $1`, [v.ventaId],
    )).rows[0]!.id;

    const r = await reubicarHuerfano(db, {
      boletoViejoId: v.boletos[0]!.boletoId, salidaNuevaId: nueva.salidaId,
      origenOrden: 0, destinoOrden: 2, asientoNum: 4,
      usuarioId, sucursalId: vieja.sucursales[0]!,
    });
    expect(r.precioMantenido).toBe(true);
    expect(r.importe).toBe(450);          // NO 480 — se mantiene el precio pagado
    expect(r.saldoPendiente).toBe(0);
    expect(r.printJobs).toBe(1);

    // El pago se traspasó a la venta nueva.
    const { rows: p } = await db.query<{ venta_id: string }>(
      `SELECT venta_id FROM core.pago WHERE id = $1`, [pagoId],
    );
    expect(p[0]!.venta_id).toBe(r.ventaNuevaId);

    // El lado viejo: boleto reasignado, asiento liberado, venta cancelada.
    const { rows: b } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.boleto WHERE id = $1`, [v.boletos[0]!.boletoId],
    );
    expect(b[0]!.estado).toBe('reasignado');
    const { rows: o } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.asiento_ocupacion WHERE boleto_id = $1`, [v.boletos[0]!.boletoId],
    );
    expect(o[0]!.estado).toBe('liberado');
    const { rows: vv } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.venta WHERE id = $1`, [v.ventaId],
    );
    expect(vv[0]!.estado).toBe('cancelada');
  });

  it('huérfano sin pagar: se cobra la tarifa vigente de la ruta nueva (N-14)', async () => {
    const { vieja, nueva, usuarioId } = await prep();
    const v = await registrarVenta(db, {
      salidaId: vieja.salidaId, sucursalVentaId: vieja.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      esReservacion: true,
      pasajeros: [{ asientoNum: 4, nombre: 'Doña Rosa', importe: 450 }],
    });

    const r = await reubicarHuerfano(db, {
      boletoViejoId: v.boletos[0]!.boletoId, salidaNuevaId: nueva.salidaId,
      origenOrden: 0, destinoOrden: 2, asientoNum: 4,
      usuarioId, sucursalId: vieja.sucursales[0]!,
    });
    expect(r.precioMantenido).toBe(false);
    expect(r.importe).toBe(480);           // tarifa vigente de la ruta nueva
    expect(r.saldoPendiente).toBe(480);
    expect(r.printJobs).toBe(0);

    const { rows: b } = await db.query<{ estado: string; importe: string }>(
      `SELECT estado, importe FROM core.boleto WHERE id = $1`, [r.boletoNuevoId],
    );
    expect(b[0]).toMatchObject({ estado: 'emitido' });
    expect(Number(b[0]!.importe)).toBe(480);
  });

  it('rechaza reubicar un boleto que no está emitido', async () => {
    const { vieja, nueva, usuarioId } = await prep();
    const v = await registrarVenta(db, {
      salidaId: vieja.salidaId, sucursalVentaId: vieja.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      esReservacion: true, pasajeros: [{ asientoNum: 4, nombre: 'X', importe: 450 }],
    });
    await db.query(`UPDATE core.boleto SET estado = 'cancelado' WHERE id = $1`, [v.boletos[0]!.boletoId]);

    await expect(reubicarHuerfano(db, {
      boletoViejoId: v.boletos[0]!.boletoId, salidaNuevaId: nueva.salidaId,
      origenOrden: 0, destinoOrden: 2, asientoNum: 4,
      usuarioId, sucursalId: vieja.sucursales[0]!,
    })).rejects.toThrow(/solo se reubica un boleto emitido/i);
  });

  it('rechaza si el asiento ya está ocupado en la salida nueva', async () => {
    const { vieja, nueva, usuarioId, corteId } = await prep();
    // Alguien ya compró el asiento 4 en la salida nueva.
    await registrarVenta(db, {
      salidaId: nueva.salidaId, sucursalVentaId: nueva.sucursales[0]!, usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 2,
      pasajeros: [{ asientoNum: 4, nombre: 'Ya sentado', importe: 480 }],
      pago: { metodo: 'efectivo', monto: 480, corteCajaId: await seedCorte(db, nueva.sucursales[0]!, usuarioId) },
    });
    const v = await registrarVenta(db, {
      salidaId: vieja.salidaId, sucursalVentaId: vieja.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      pasajeros: [{ asientoNum: 4, nombre: 'Don Luis', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
    });

    await expect(reubicarHuerfano(db, {
      boletoViejoId: v.boletos[0]!.boletoId, salidaNuevaId: nueva.salidaId,
      origenOrden: 0, destinoOrden: 2, asientoNum: 4,
      usuarioId, sucursalId: vieja.sucursales[0]!,
    })).rejects.toThrow(/asiento .* ya está ocupado/i);
  });
});
