/**
 * Fase 6a — tercer método de pago `corresponsal` (D8 / D13).
 *
 *   - lo cobra una sucursal `sin_sistema` (Tamazulapan);
 *   - el pago se agrupa en el corte del vendedor de origen pero NO entra al
 *     efectivo (el trigger `pago→ingreso` lo omite);
 *   - el corte lo muestra aparte — `core.pagos_corresponsal` (D8).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { cobradoEnCorresponsal, saldoCorte } from '../../src/caja/corte.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('pago corresponsal (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  /** Una sucursal `sin_sistema` de la misma agencia. */
  const sucursalSinSistema = async (agenciaId: string): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO core.sucursal (agencia_id, nombre, direccion_completa, telefono_principal,
                                  codigo, zona_horaria, sin_sistema)
       SELECT $1, 'Tamazulapan (sin sistema)', 'Sobre carretera', '953 000 0000',
              c, 'America/Mexico_City', true
         FROM unnest(string_to_array('ABCDEFGHJKMNPQRSTVWXYZ23456789', NULL)) c
        WHERE c NOT IN (SELECT codigo FROM core.sucursal)
        LIMIT 1
       RETURNING id`,
      [agenciaId],
    );
    return rows[0]!.id;
  };

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const { rows } = await db.query<{ agencia_id: string }>(
      `SELECT agencia_id FROM core.sucursal WHERE id = $1`, [fx.sucursales[0]!],
    );
    const cobroId = await sucursalSinSistema(rows[0]!.agencia_id);
    return { fx, usuarioId, corteId, cobroId };
  };

  const pasajeros = [
    { asientoNum: 2, nombre: 'Ana Ruiz', importe: 450 },
    { asientoNum: 3, nombre: 'Beto Sosa', importe: 450 },
  ];

  it('corresponsal: venta liquidada e imprimible, pero sin movimiento de caja', async () => {
    const { fx, usuarioId, corteId, cobroId } = await prep();

    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true,
      pasajeros,
      pago: { metodo: 'corresponsal', monto: 900, corteCajaId: corteId, sucursalCobroId: cobroId },
    });
    expect(r.estado).toBe('liquidada');
    expect(r.pagado).toBe(900);
    expect(r.saldoPendiente).toBe(0);
    expect(r.printJobs).toBe(2);

    // El pago quedó verificado y apuntando a la sucursal de cobro.
    const { rows: p } = await db.query<{ metodo: string; verificado: boolean; sucursal_cobro_id: string }>(
      `SELECT metodo, verificado, sucursal_cobro_id FROM core.pago WHERE venta_id = $1`, [r.ventaId],
    );
    expect(p[0]).toMatchObject({ metodo: 'corresponsal', verificado: true, sucursal_cobro_id: cobroId });

    // NO generó movimiento de caja: el efectivo del corte no cambia.
    const { rows: mc } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.movimiento_caja mc
        JOIN core.pago pg ON pg.id = mc.origen_id
       WHERE pg.venta_id = $1 AND mc.activo`, [r.ventaId],
    );
    expect(Number(mc[0]!.n)).toBe(0);
    const saldo = await saldoCorte(db, corteId);
    expect(saldo!.ingresos).toBe(0);
  });

  it('el corte muestra los cobros corresponsal aparte (D8)', async () => {
    const { fx, usuarioId, corteId, cobroId } = await prep();
    await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true, pasajeros: [pasajeros[0]!],
      pago: { metodo: 'corresponsal', monto: 450, corteCajaId: corteId, sucursalCobroId: cobroId },
    });

    const rep = await cobradoEnCorresponsal(db, corteId);
    expect(rep.conteo).toBe(1);
    expect(rep.suma).toBe(450);
    expect(rep.detalle[0]).toMatchObject({ sucursalCobro: 'Tamazulapan (sin sistema)', monto: 450 });
    expect(rep.detalle[0]!.folio).toBeTruthy();
  });

  it('corresponsal rechaza una sucursal de cobro que no es sin_sistema', async () => {
    const { fx, usuarioId, corteId } = await prep();
    await expect(registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true, pasajeros: [pasajeros[0]!],
      pago: { metodo: 'corresponsal', monto: 450, corteCajaId: corteId, sucursalCobroId: fx.sucursales[1]! },
    })).rejects.toThrow(/sin sistema/i);
  });

  it('corresponsal rechaza un abono parcial (cubre el total o nada)', async () => {
    const { fx, usuarioId, corteId, cobroId } = await prep();
    await expect(registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      esReservacion: true, pasajeros,
      pago: { metodo: 'corresponsal', monto: 450, corteCajaId: corteId, sucursalCobroId: cobroId },
    })).rejects.toThrow(/total de la venta/i);
  });
});
