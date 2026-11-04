/**
 * Fase B (0082) — venta en una salida EN RUTA desde terminales posteriores.
 * docs/architecture/06-lugar-paso-paqueteria.md §1.1 (L7, L8).
 *
 *   - en ruta, una terminal intermedia (orden > 0) sigue vendiendo;
 *   - en ruta, el origen (orden 0) ya no;
 *   - el asiento que libera un no-show se vende en la siguiente terminal.
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { buscarSalidas } from '../../src/ventas/busqueda.js';
import { cancelarBoleto } from '../../src/fleet/abordaje.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('venta en ruta desde terminales intermedias (PostgreSQL real)', () => {
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
    const corteOrigen = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const corteInter = await seedCorte(db, fx.sucursales[1]!, usuarioId);
    return { fx, usuarioId, corteOrigen, corteInter };
  };

  const enRuta = (salidaId: string) =>
    db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [salidaId]);

  it('en ruta, la terminal intermedia vende y el origen no', async () => {
    const { fx, usuarioId, corteOrigen, corteInter } = await prep();
    await enRuta(fx.salidaId);

    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[1]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 1, destinoOrden: 3,
      pasajeros: [{ asientoNum: 6, nombre: 'Ana Ruiz', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteInter },
    });
    expect(r.estado).toBe('liquidada');

    await db.query('SAVEPOINT intento');
    await expect(registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 7, nombre: 'Beto Sosa', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteOrigen },
    })).rejects.toThrow(/en_ruta/);
    await db.query('ROLLBACK TO SAVEPOINT intento');
  });

  it('la búsqueda ofrece la salida en ruta desde la intermedia, no desde el origen', async () => {
    const { fx } = await prep();
    await enRuta(fx.salidaId);
    const puntos = async (orden: number) => (await db.query<{ punto_id: string }>(
      `SELECT punto_id FROM core.salida_parada WHERE salida_id = $1 AND orden = $2`,
      [fx.salidaId, orden],
    )).rows[0]!.punto_id;

    const desdeInter = await buscarSalidas(db, {
      fecha: fx.fechaOperacion, sucursalOrigenId: await puntos(1), sucursalDestinoId: await puntos(3),
      nPersonas: 1, sucursalVendedoraId: fx.sucursales[1]!,
    });
    expect(desdeInter.find((s) => s.salidaId === fx.salidaId)?.seleccionable).toBe(true);

    const desdeOrigen = await buscarSalidas(db, {
      fecha: fx.fechaOperacion, sucursalOrigenId: await puntos(0), sucursalDestinoId: await puntos(3),
      nPersonas: 1, sucursalVendedoraId: fx.sucursales[0]!,
    });
    expect(desdeOrigen.find((s) => s.salidaId === fx.salidaId)).toBeUndefined();
  });

  it('el asiento de un no-show de lugar de paso se vende en la siguiente terminal', async () => {
    const { fx, usuarioId, corteOrigen, corteInter } = await prep();
    const reserva = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Gil Rey', importe: 450 }],
      pago: { metodo: 'conductor', monto: 450, corteCajaId: corteOrigen },
      lugarAbordaje: 'Gasolinera de Chila',
    });
    await enRuta(fx.salidaId);
    await cancelarBoleto(db, {
      boletoId: reserva.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
      motivo: 'no se presentó',
    });

    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[1]!, usuarioId,
      contactoTelefono: '953 333 4444', origenOrden: 1, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Iris Sol', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteInter },
    });
    expect(r.boletos[0]!.asientoNum).toBe(5);
  });
});
