/**
 * Fase 1 de "paradas autorizadas" — bandera de ascenso en búsqueda y venta
 * (migración 0049, contra PostgreSQL real).
 *
 * docs/architecture/05-paradas-autorizadas-tarifas.md §4 (Fase 1) · D2 / P-1
 *
 * ALCANCE. Solo lo que 0049 introduce:
 *   - `core.buscar_salidas` recibe `core.punto_ruta.id` como origen/destino y
 *     exige que el origen permita ascenso en la ruta (`ruta_parada.permite_ascenso`).
 *   - `core.registrar_venta` / `core.adquirir_lease` hacen RAISE si el orden de
 *     origen es una parada que no permite ascenso.
 *
 * NADA de Fase 2+ (tramos_ocupacion, tarifa estricta, validar el descenso del
 * destino, `repartir_cupo_offline` con paradas no-terminal). Por eso el fixture
 * `paradaAscensoEnOrden` se prueba a nivel `seedRuta` — materializarla entera
 * revienta `cupo_offline.sucursal_id` NOT NULL, que se arregla en Fase 4.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { buscarSalidas } from '../../src/ventas/busqueda.js';
import { adquirirLease } from '../../src/ventas/lease.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { seedRuta } from '../fleet/fixture.js';
import { antesDelCierre, crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('Fase 1 · bandera de ascenso (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  /** Cambia las banderas de una parada de la ruta. */
  const banderas = async (
    rutaId: string, orden: number, ascenso: boolean, descenso: boolean,
  ): Promise<void> => {
    await db.query(
      `UPDATE core.ruta_parada SET permite_ascenso = $3, permite_descenso = $4
        WHERE ruta_id = $1 AND orden = $2`,
      [rutaId, orden, ascenso, descenso],
    );
  };

  const rutaDe = async (horarioId: string): Promise<string> => {
    const { rows } = await db.query<{ ruta_id: string }>(
      `SELECT ruta_id FROM core.horario WHERE id = $1`, [horarioId],
    );
    return rows[0]!.ruta_id;
  };

  // -------------------------------------------------------------------------
  // Fixture: parada de solo ascenso (retorno) — a nivel ruta
  // -------------------------------------------------------------------------
  it('`paradaAscensoEnOrden` crea un punto tipo=parada, banderas true/false, CON fila en horario_parada', async () => {
    const fx = await seedRuta(db, { paradas: 4, paradaAscensoEnOrden: 1 });

    const { rows: rp } = await db.query<{
      tipo: string; permite_ascenso: boolean; permite_descenso: boolean;
      sucursal_id: string | null;
    }>(
      `SELECT pr.tipo, rp.permite_ascenso, rp.permite_descenso, pr.sucursal_id
         FROM core.ruta_parada rp
         JOIN core.punto_ruta pr ON pr.id = rp.punto_id
        WHERE rp.ruta_id = $1 AND rp.orden = 1`,
      [fx.rutaId],
    );
    expect(rp[0]).toMatchObject({
      tipo: 'parada', permite_ascenso: true, permite_descenso: false, sucursal_id: null,
    });

    // A diferencia de la de solo descenso, la de ascenso SÍ lleva hora de paso (D6).
    const { rows: hp } = await db.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM core.horario_parada hp
         JOIN core.ruta_parada rp ON rp.id = hp.ruta_parada_id
        WHERE hp.horario_id = $1 AND rp.orden = 1`,
      [fx.horarioId],
    );
    expect(Number(hp[0]!.n)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // buscar_salidas: el origen debe permitir ascenso
  // -------------------------------------------------------------------------
  it('una parada intermedia con ascenso origina; sin ascenso desaparece de la búsqueda', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const rutaId = await rutaDe(fx.horarioId);

    const buscar = (puntoOrigen: string) => buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: puntoOrigen,
      sucursalDestinoId: fx.puntos[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[1]!,
      conConexion: true,
    });

    // Orden 1 es una terminal intermedia; por defecto permite ascenso.
    expect(await buscar(fx.puntos[1]!)).toHaveLength(1);

    // Se le quita el ascenso (queda como parada de solo descenso en esta ruta).
    await banderas(rutaId, 1, false, true);
    expect(await buscar(fx.puntos[1]!), 'sin ascenso, no origina').toHaveLength(0);
  });

  it('el origen de la ruta sin ascenso desaparece de la búsqueda', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const rutaId = await rutaDe(fx.horarioId);

    const buscar = () => buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.puntos[0]!,
      sucursalDestinoId: fx.puntos[3]!,
      nPersonas: 1,
      sucursalVendedoraId: fx.sucursales[0]!,
      conConexion: true,
    });

    expect(await buscar()).toHaveLength(1);
    await banderas(rutaId, 0, false, true);
    expect(await buscar()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // registrar_venta / adquirir_lease
  // -------------------------------------------------------------------------
  it('registrar_venta rechaza un origen que no permite ascenso', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const rutaId = await rutaDe(fx.horarioId);
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);

    await banderas(rutaId, 0, false, true);

    await expect(registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Ana', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      ahora,
    })).rejects.toThrow(/no permite ascenso/i);
  });

  it('adquirir_lease rechaza un tramo que arranca en un orden sin ascenso', async () => {
    const fx = await seedSalida(db, { paradas: 4 });
    const rutaId = await rutaDe(fx.horarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);

    await banderas(rutaId, 0, false, true);

    await expect(adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 8, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, ahora,
    })).rejects.toThrow(/no permite ascenso/i);
  });

  it('el guard no toca un origen terminal normal: la venta sigue funcionando', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);

    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Ana', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      ahora,
    });
    expect(r.estado).toBe('liquidada');
  });
});
