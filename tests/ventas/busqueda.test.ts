/**
 * Búsqueda de salidas con disponibilidad por tramo (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §2, §3.4
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F4, pasos 1-2)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { buscarSalidas } from '../../src/ventas/busqueda.js';
import { crearLease, crearUsuario, ocuparAsiento, seedSalida, seedTarifa } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('búsqueda de salidas (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  // -------------------------------------------------------------------------
  // Con conexión: cualquier asiento libre cuenta
  // -------------------------------------------------------------------------
  it('con conexión ofrece las 18 plazas de una salida sin vender nada', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const r = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 2,
      sucursalVendedoraId: fx.sucursales[0]!,
      conConexion: true,
    });

    expect(r).toHaveLength(1);
    expect(r[0]!.salidaId).toBe(fx.salidaId);
    expect(r[0]!.origenOrden).toBe(0);
    expect(r[0]!.destinoOrden).toBe(3);
    expect(r[0]!.asientosOfrecibles).toHaveLength(18);
    expect(r[0]!.disponibles).toBe(18);
    expect(r[0]!.seleccionable).toBe(true);
  });

  it('un asiento vendido en un tramo que solapa deja de ofrecerse', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const u = await crearUsuario(db);
    await ocuparAsiento(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId: u,
      asiento: 5, desde: 0, hasta: 3,
    });

    const [s] = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[0]!,
    });

    expect(s!.asientosOfrecibles).not.toContain(5);
    expect(s!.disponibles).toBe(17);
  });

  it('un asiento ocupado en un tramo DISJUNTO sigue disponible en el otro', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const u = await crearUsuario(db);
    // Vendido de P0 a P1; buscamos de P1 a P3: no se solapan.
    await ocuparAsiento(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId: u,
      asiento: 9, desde: 0, hasta: 1,
    });

    const [s] = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[1]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[1]!,
      conConexion: true,
    });

    expect(s!.asientosOfrecibles).toContain(9);
  });

  it('un lease vivo bloquea el asiento aunque no haya venta', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    await crearLease(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[1]!, asiento: 3, desde: 0, hasta: 3,
    });

    const [s] = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[0]!,
      conConexion: true,
    });

    expect(s!.asientosOfrecibles).not.toContain(3);
    expect(s!.disponibles).toBe(17);
  });

  // -------------------------------------------------------------------------
  // Sin conexión: la regla de oro — solo el cupo propio
  // -------------------------------------------------------------------------
  it('sin conexión el origen solo ofrece su cupo (B0,B1,B2,B5 = 12 plazas)', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const [s] = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 2,
      sucursalVendedoraId: fx.sucursales[0]!,
      conConexion: false,
    });

    expect(s!.disponibles).toBe(12);
    expect([...s!.asientosOfrecibles].sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18]);
  });

  it('sin conexión una intermedia solo ofrece su fila (3 plazas), disjunta del origen', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const [s] = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[1]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 2,
      sucursalVendedoraId: fx.sucursales[1]!,
      conConexion: false,
    });

    expect([...s!.asientosOfrecibles].sort((a, b) => a - b)).toEqual([8, 9, 10]);
  });

  it('sin conexión, una sucursal que no tiene cupo en ese tramo no ofrece nada', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    // La intermedia S3 (orden 2) no puede vender el tramo 0→3.
    const [s] = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[2]!,
      conConexion: false,
    });

    expect(s!.asientosOfrecibles).toEqual([]);
    expect(s!.seleccionable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // `seleccionable`: salida programada + venta abierta + caben N
  // -------------------------------------------------------------------------
  it('un horario lleno se muestra pero no es seleccionable', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const u = await crearUsuario(db);
    // Ocupar 17 de las 18 en el tramo 0→3; queda solo una.
    for (const a of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
      await ocuparAsiento(db, {
        salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId: u,
        asiento: a, desde: 0, hasta: 3,
      });
    }

    const [s] = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 2,
      sucursalVendedoraId: fx.sucursales[0]!,
      conConexion: true,
    });

    expect(s, 'la salida sigue apareciendo').toBeDefined();
    expect(s!.disponibles).toBe(1);
    expect(s!.seleccionable, 'pero no caben 2').toBe(false);
  });

  it('una salida en ruta no aparece en la búsqueda', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    await db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [fx.salidaId]);

    const r = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[0]!,
    });

    expect(r).toEqual([]);
  });

  it('pasado el cierre de venta la salida aparece pero no es seleccionable', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const { rows } = await db.query<{ cierre: Date }>(
      `SELECT cierre_venta_en AS cierre FROM core.salida_parada
        WHERE salida_id = $1 AND orden = 0`, [fx.salidaId],
    );
    const despues = new Date(rows[0]!.cierre.getTime() + 60_000);

    const [s] = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[0]!,
      conConexion: true,
      ahora: despues,
    });

    expect(s, 'sigue apareciendo').toBeDefined();
    expect(s!.seleccionable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Tarifa
  // -------------------------------------------------------------------------
  it('devuelve la tarifa vigente del tramo, y null si no está capturada', async () => {
    const fx = await seedSalida(db, { paradas: 4 });

    const sinTarifa = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[0]!,
    });
    expect(sinTarifa[0]!.importe).toBeNull();

    await seedTarifa(db, fx.horarioId, 0, 3, 480);
    const conTarifa = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[0]!,
      sucursalDestinoId: fx.sucursales[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[0]!,
    });
    expect(conTarifa[0]!.importe).toBe(480);
  });

  it('no devuelve nada si el destino va antes que el origen en la ruta', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const r = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.sucursales[3]!,
      sucursalDestinoId: fx.sucursales[0]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[3]!,
    });
    expect(r).toEqual([]);
  });
});
