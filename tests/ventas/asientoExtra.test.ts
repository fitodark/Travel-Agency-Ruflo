/**
 * Hasta 2 asientos extra por salida, sin tocar el mapa (contra PostgreSQL
 * real). QA Ses. 76.
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §4
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { venderAsientoExtra } from '../../src/ventas/asientoExtra.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('asiento extra (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  interface Ctx {
    salidaId: string; sucursales: string[]; usuarioId: string; corteId: string;
  }

  const preparar = async (): Promise<Ctx> => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20, tarifaImporte: 450 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    return { salidaId: fx.salidaId, sucursales: fx.sucursales, usuarioId, corteId };
  };

  /** Un instante cómodamente POSTERIOR al cierre de venta normal de la parada. */
  const despuesDelCierre = async (salidaId: string): Promise<Date> => {
    const { rows } = await db.query<{ cierre: Date }>(
      `SELECT cierre_venta_en AS cierre FROM core.salida_parada WHERE salida_id = $1 AND orden = 0`,
      [salidaId],
    );
    return new Date(rows[0]!.cierre.getTime() + 30 * 60 * 1000);
  };

  const mapaAsientos = async (salidaId: string): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT jsonb_array_length(mapa_snapshot->'asientos') AS n FROM core.salida WHERE id = $1`,
      [salidaId],
    );
    return rows[0]!.n;
  };

  it('vende el 19 y el 20 en efectivo/transferencia, con la tarifa general del tramo', async () => {
    const c = await preparar();
    const ahora = await despuesDelCierre(c.salidaId);

    const r1 = await venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre: 'Pasajero Extra Uno', metodo: 'efectivo', efectivoRecibido: 500,
      corteCajaId: c.corteId, ahora,
    });
    expect(r1.asientoNum).toBe(19);
    expect(r1.importe).toBe(450);
    expect(r1.estado).toBe('liquidada');
    expect(r1.printJobs).toBe(1);
    expect(r1.folio).toEqual(expect.any(String));

    const r2 = await venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre: 'Pasajero Extra Dos', metodo: 'transferencia', referencia: 'REF1',
      corteCajaId: c.corteId, ahora,
    });
    expect(r2.asientoNum).toBe(20);
    expect(r2.estado).toBe('finalizada_transferencia');
  });

  it('rechaza un tercer asiento extra', async () => {
    const c = await preparar();
    const ahora = await despuesDelCierre(c.salidaId);
    const vender = (nombre: string) => venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre, metodo: 'efectivo', efectivoRecibido: 450, corteCajaId: c.corteId, ahora,
    });
    await vender('Uno');
    await vender('Dos');
    await expect(vender('Tres')).rejects.toThrow(/ya vendió sus 2 asientos extra/i);
  });

  it('funciona DESPUÉS del cierre de venta normal (a diferencia de una venta común)', async () => {
    const c = await preparar();
    const ahora = await despuesDelCierre(c.salidaId);

    const r = await venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre: 'Tarde', metodo: 'efectivo', efectivoRecibido: 450, corteCajaId: c.corteId, ahora,
    });
    expect(r.asientoNum).toBe(19);
  });

  it('no toca el mapa de asientos de la salida', async () => {
    const c = await preparar();
    const ahora = await despuesDelCierre(c.salidaId);
    const antes = await mapaAsientos(c.salidaId);

    await venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre: 'Uno', metodo: 'efectivo', efectivoRecibido: 450, corteCajaId: c.corteId, ahora,
    });

    expect(await mapaAsientos(c.salidaId)).toBe(antes);
  });

  it('rechaza si la salida no está programada', async () => {
    const c = await preparar();
    const ahora = await despuesDelCierre(c.salidaId);
    await db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [c.salidaId]);

    await expect(venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre: 'Uno', metodo: 'efectivo', efectivoRecibido: 450, corteCajaId: c.corteId, ahora,
    })).rejects.toThrow(/en_ruta/i);
  });

  it('rechaza un método distinto a efectivo/transferencia', async () => {
    const c = await preparar();
    const ahora = await despuesDelCierre(c.salidaId);

    await expect(venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre: 'Uno', metodo: 'corresponsal' as 'efectivo', corteCajaId: c.corteId, ahora,
    })).rejects.toThrow(/efectivo o transferencia/i);
  });

  it('rechaza efectivo insuficiente', async () => {
    const c = await preparar();
    const ahora = await despuesDelCierre(c.salidaId);

    await expect(venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre: 'Uno', metodo: 'efectivo', efectivoRecibido: 100, corteCajaId: c.corteId, ahora,
    })).rejects.toThrow(/no cubre la tarifa/i);
  });

  it('rechaza sin nombre de pasajero', async () => {
    const c = await preparar();
    const ahora = await despuesDelCierre(c.salidaId);

    await expect(venderAsientoExtra(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 000 0000', origenOrden: 0, destinoOrden: 3,
      nombre: '', metodo: 'efectivo', efectivoRecibido: 450, corteCajaId: c.corteId, ahora,
    })).rejects.toThrow(/nombre del pasajero/i);
  });
});
