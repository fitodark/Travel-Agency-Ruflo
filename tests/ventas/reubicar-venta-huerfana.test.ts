/**
 * F6-D2 — reubicación de una venta huérfana COMPLETA (familia multi-boleto, N-14).
 *
 *   - familia pagada  → venta nueva con todos los boletos al precio pagado, pagos
 *     traspasados una vez; boletos viejos reasignado + activo=false; venta vieja
 *     cancelada;
 *   - familia sin pagar → venta nueva a la tarifa vigente de la ruta nueva;
 *   - las asignaciones deben cubrir exactamente los boletos vivos de la venta.
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { boletosReubicables, reubicarVentaHuerfana } from '../../src/fleet/abordaje.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('reubicación de venta huérfana completa (PostgreSQL real)', () => {
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
    const nueva = await seedSalida(db, { paradas: 3, diasAdelante: 15, tarifaImporte: 480 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, vieja.sucursales[0]!, usuarioId);
    return { vieja, nueva, usuarioId, corteId };
  };

  it('familia pagada: venta nueva con todos los boletos al precio pagado, pagos traspasados', async () => {
    const { vieja, nueva, usuarioId, corteId } = await prep();
    const v = await registrarVenta(db, {
      salidaId: vieja.salidaId, sucursalVentaId: vieja.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      pasajeros: [
        { asientoNum: 4, nombre: 'Mamá', importe: 450 },
        { asientoNum: 5, nombre: 'Hija', importe: 450 },
      ],
      pago: { metodo: 'efectivo', monto: 900, corteCajaId: corteId },
    });

    const reubicables = await boletosReubicables(db, v.ventaId);
    expect(reubicables).toHaveLength(2);

    const r = await reubicarVentaHuerfana(db, {
      ventaViejaId: v.ventaId, salidaNuevaId: nueva.salidaId,
      asignaciones: reubicables.map((b, i) => ({
        boletoViejoId: b.boletoId, origenOrden: 0, destinoOrden: 2, asientoNum: 6 + i,
      })),
      usuarioId, sucursalId: vieja.sucursales[0]!,
    });

    expect(r.precioMantenido).toBe(true);
    expect(r.importeTotal).toBe(900);     // 2×450, NO 2×480
    expect(r.saldoPendiente).toBe(0);
    expect(r.boletos).toHaveLength(2);
    expect(r.printJobs).toBe(2);   // un ticket por boleto

    // Los pagos se traspasaron a la venta nueva.
    const { rows: p } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.pago WHERE venta_id = $1 AND activo`, [r.ventaNuevaId],
    );
    expect(Number(p[0]!.n)).toBe(1);

    // Los boletos viejos: reasignado + activo=false; venta vieja cancelada.
    const { rows: b } = await db.query<{ estado: string; activo: boolean }>(
      `SELECT estado, activo FROM core.boleto WHERE venta_id = $1`, [v.ventaId],
    );
    expect(b).toHaveLength(2);
    for (const row of b) expect(row).toMatchObject({ estado: 'reasignado', activo: false });

    const { rows: vv } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.venta WHERE id = $1`, [v.ventaId],
    );
    expect(vv[0]!.estado).toBe('cancelada');

    // Sus asientos en la salida vieja quedaron liberados.
    const { rows: o } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.asiento_ocupacion
        WHERE boleto_id IN (SELECT id FROM core.boleto WHERE venta_id = $1) AND estado = 'liberado'`,
      [v.ventaId],
    );
    expect(Number(o[0]!.n)).toBe(2);
  });

  it('familia sin pagar: se cobra la tarifa vigente de la ruta nueva', async () => {
    const { vieja, nueva, usuarioId } = await prep();
    const v = await registrarVenta(db, {
      salidaId: vieja.salidaId, sucursalVentaId: vieja.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      esReservacion: true,
      pasajeros: [
        { asientoNum: 4, nombre: 'Papá', importe: 450 },
        { asientoNum: 5, nombre: 'Hijo', importe: 450 },
      ],
    });
    const reubicables = await boletosReubicables(db, v.ventaId);

    const r = await reubicarVentaHuerfana(db, {
      ventaViejaId: v.ventaId, salidaNuevaId: nueva.salidaId,
      asignaciones: reubicables.map((b, i) => ({
        boletoViejoId: b.boletoId, origenOrden: 0, destinoOrden: 2, asientoNum: 6 + i,
      })),
      usuarioId, sucursalId: vieja.sucursales[0]!,
    });

    expect(r.precioMantenido).toBe(false);
    expect(r.importeTotal).toBe(960);     // 2×480
    expect(r.saldoPendiente).toBe(960);
    expect(r.printJobs).toBe(0);
  });

  it('rechaza si las asignaciones no cubren todos los boletos vivos de la venta', async () => {
    const { vieja, nueva, usuarioId, corteId } = await prep();
    const v = await registrarVenta(db, {
      salidaId: vieja.salidaId, sucursalVentaId: vieja.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      pasajeros: [
        { asientoNum: 4, nombre: 'A', importe: 450 },
        { asientoNum: 5, nombre: 'B', importe: 450 },
      ],
      pago: { metodo: 'efectivo', monto: 900, corteCajaId: corteId },
    });
    const reubicables = await boletosReubicables(db, v.ventaId);

    await expect(reubicarVentaHuerfana(db, {
      ventaViejaId: v.ventaId, salidaNuevaId: nueva.salidaId,
      asignaciones: [{
        boletoViejoId: reubicables[0]!.boletoId, origenOrden: 0, destinoOrden: 2, asientoNum: 6,
      }],
      usuarioId, sucursalId: vieja.sucursales[0]!,
    })).rejects.toThrow(/cubrir exactamente los 2 boletos/i);
  });

  it('rechaza si un asiento ya está ocupado en la salida nueva', async () => {
    const { vieja, nueva, usuarioId, corteId } = await prep();
    await registrarVenta(db, {
      salidaId: nueva.salidaId, sucursalVentaId: nueva.sucursales[0]!, usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 2,
      pasajeros: [{ asientoNum: 7, nombre: 'Ya sentado', importe: 480 }],
      pago: { metodo: 'efectivo', monto: 480, corteCajaId: await seedCorte(db, nueva.sucursales[0]!, usuarioId) },
    });
    const v = await registrarVenta(db, {
      salidaId: vieja.salidaId, sucursalVentaId: vieja.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      pasajeros: [
        { asientoNum: 4, nombre: 'A', importe: 450 },
        { asientoNum: 5, nombre: 'B', importe: 450 },
      ],
      pago: { metodo: 'efectivo', monto: 900, corteCajaId: corteId },
    });
    const reubicables = await boletosReubicables(db, v.ventaId);

    await expect(reubicarVentaHuerfana(db, {
      ventaViejaId: v.ventaId, salidaNuevaId: nueva.salidaId,
      asignaciones: [
        { boletoViejoId: reubicables[0]!.boletoId, origenOrden: 0, destinoOrden: 2, asientoNum: 6 },
        { boletoViejoId: reubicables[1]!.boletoId, origenOrden: 0, destinoOrden: 2, asientoNum: 7 },
      ],
      usuarioId, sucursalId: vieja.sucursales[0]!,
    })).rejects.toThrow(/asiento 7 ya está ocupado/i);
  });
});
