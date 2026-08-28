/**
 * Captura de abordaje y estado del viaje (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §5
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F7, slice 2)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  checklistAbordaje, corregirAbordaje, finalizarSalida, marcarEnRuta, registrarAbordaje,
} from '../../src/fleet/abordaje.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import {
  antesDelCierre, crearUsuario, seedCorte, seedSalida, sembrarOcupacion,
} from '../ventas/fixture.js';
import { crearConductorTipo } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('captura de abordaje y estado del viaje (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 12 });
    const usuarioId = await crearUsuario(db);
    const b1 = await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId,
      asiento: 2, desde: 0, hasta: 3, estado: 'firme',
    });
    const b2 = await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId,
      asiento: 3, desde: 0, hasta: 3, estado: 'firme',
    });
    return { fx, usuarioId, b1, b2 };
  };

  const estadoDe = (lista: Awaited<ReturnType<typeof checklistAbordaje>>, boletoId: string) =>
    lista.find((x) => x.boletoId === boletoId)?.estadoAbordaje;

  // -------------------------------------------------------------------------
  it('sin capturar nada, todos los boletos están `pendiente`', async () => {
    const { fx, b1, b2 } = await prep();
    const c = await checklistAbordaje(db, fx.salidaId);
    expect(c).toHaveLength(2);
    expect([estadoDe(c, b1.boletoId), estadoDe(c, b2.boletoId)]).toEqual(['pendiente', 'pendiente']);
  });

  it('capturar abordó / no se presentó se refleja en el checklist', async () => {
    const { fx, usuarioId, b1, b2 } = await prep();
    await registrarAbordaje(db, {
      boletoId: b1.boletoId, abordo: true, usuarioId, sucursalId: fx.sucursales[0]!,
    });
    await registrarAbordaje(db, {
      boletoId: b2.boletoId, abordo: false, usuarioId, sucursalId: fx.sucursales[0]!,
    });

    const c = await checklistAbordaje(db, fx.salidaId);
    expect(estadoDe(c, b1.boletoId)).toBe('abordo');
    expect(estadoDe(c, b2.boletoId)).toBe('no_presento');
  });

  it('la corrección manda: el último hecho no anulado gana', async () => {
    const { fx, usuarioId, b1 } = await prep();
    const ev = await registrarAbordaje(db, {
      boletoId: b1.boletoId, abordo: true, usuarioId, sucursalId: fx.sucursales[0]!,
    });
    await corregirAbordaje(db, {
      eventoId: ev, abordo: false, usuarioId, sucursalId: fx.sucursales[0]!,
    });

    const c = await checklistAbordaje(db, fx.salidaId);
    expect(estadoDe(c, b1.boletoId)).toBe('no_presento');
  });

  it('el evento de abordaje sube a la cola de replicación (clase C)', async () => {
    const { fx, usuarioId, b1 } = await prep();
    await registrarAbordaje(db, {
      boletoId: b1.boletoId, abordo: true, usuarioId, sucursalId: fx.sucursales[0]!,
    });
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.outbox WHERE tabla = 'core.evento_abordaje'`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('rechaza capturar sobre un boleto inexistente', async () => {
    const { fx, usuarioId } = await prep();
    await expect(registrarAbordaje(db, {
      boletoId: '00000000-0000-7000-8000-000000000000', abordo: true,
      usuarioId, sucursalId: fx.sucursales[0]!,
    })).rejects.toThrow(/no existe/i);
  });

  it('rechaza capturar sobre un boleto cancelado', async () => {
    const { fx, usuarioId, b1 } = await prep();
    await db.query(`UPDATE core.boleto SET estado = 'cancelado' WHERE id = $1`, [b1.boletoId]);
    await expect(registrarAbordaje(db, {
      boletoId: b1.boletoId, abordo: true, usuarioId, sucursalId: fx.sucursales[0]!,
    })).rejects.toThrow(/cancelado/i);
  });

  // -------------------------------------------------------------------------
  it('marcar en ruta fija el estado, la hora del sistema y —si se pasa— el conductor', async () => {
    const { fx, usuarioId } = await prep();
    const { conductorId } = await crearConductorTipo(db);
    const t = new Date('2026-09-12T07:05:00Z');

    const r = await marcarEnRuta(db, {
      salidaId: fx.salidaId, usuarioId, conductorId, ahora: t,
    });
    expect(r.estado).toBe('en_ruta');
    expect(r.salidaRealEn!.getTime()).toBe(t.getTime());

    const { rows } = await db.query<{ estado: string; real: Date; cond: string }>(
      `SELECT estado, salida_real_en AS real, conductor_id AS cond
         FROM core.salida WHERE id = $1`, [fx.salidaId],
    );
    expect(rows[0]!.estado).toBe('en_ruta');
    expect(rows[0]!.cond).toBe(conductorId);

    const { rows: ev } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.evento_salida
        WHERE salida_id = $1 AND tipo = 'en_ruta'`, [fx.salidaId],
    );
    expect(Number(ev[0]!.n)).toBe(1);
  });

  it('una salida en ruta ya no se puede vender', async () => {
    const { fx, usuarioId } = await prep();
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);
    await marcarEnRuta(db, { salidaId: fx.salidaId, usuarioId, ahora });

    await expect(registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Tarde', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      ahora,
    })).rejects.toThrow(/no se puede vender ni reservar/i);
  });

  it('no se marca en ruta una salida que ya lo está', async () => {
    const { fx, usuarioId } = await prep();
    await marcarEnRuta(db, { salidaId: fx.salidaId, usuarioId });
    await expect(
      marcarEnRuta(db, { salidaId: fx.salidaId, usuarioId }),
    ).rejects.toThrow(/no se puede marcar en ruta/i);
  });

  it('no se finaliza una salida que no está en ruta', async () => {
    const { fx, usuarioId } = await prep();
    await expect(
      finalizarSalida(db, { salidaId: fx.salidaId, usuarioId }),
    ).rejects.toThrow(/en ruta/i);
  });

  it('una salida en ruta se finaliza', async () => {
    const { fx, usuarioId } = await prep();
    await marcarEnRuta(db, { salidaId: fx.salidaId, usuarioId });
    const r = await finalizarSalida(db, { salidaId: fx.salidaId, usuarioId });
    expect(r.estado).toBe('finalizada');
  });
});
