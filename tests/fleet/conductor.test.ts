/**
 * Asignación del conductor real de una salida (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5.3
 *                  Regla de QA (Ses. 75, migración 0074): la unidad, no el
 *                  conductor, determina el mapa — asignar/cambiar el conductor
 *                  nunca vuelve a tocar el mapa, los cupos ni los boletos.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { cambiarConductor } from '../../src/fleet/conductor.js';
import { cupoDeSalida } from '../../src/fleet/cupo.js';
import { materializarHorario } from '../../src/fleet/materializar.js';
import { crearConductorTipo, crearUsuario, seedRuta, venderEn, type RutaFixture } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('asignación de conductor (PostgreSQL real)', () => {
  let db: Client;
  let fx: RutaFixture;
  let salidaId: string;
  let vendedor: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    fx = await seedRuta(db, { paradas: 2 });
    await materializarHorario(db, fx.horarioId, { dias: 0 });
    const sal = await db.query<{ id: string }>(
      `SELECT id FROM core.salida WHERE horario_id = $1 LIMIT 1`, [fx.horarioId],
    );
    salidaId = sal.rows[0]!.id;
    vendedor = await crearUsuario(db, 'vendedor');
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const mapaSnapshot = async (): Promise<{ asientos: number; conductor: string | null }> => {
    const { rows } = await db.query<{ n: number; c: string | null }>(
      `SELECT jsonb_array_length(mapa_snapshot->'asientos') AS n, conductor_nombre_snapshot AS c
         FROM core.salida WHERE id = $1`, [salidaId],
    );
    return { asientos: rows[0]!.n, conductor: rows[0]!.c };
  };

  it('asigna el conductor sin tocar el mapa ni los cupos, aunque haya boletos vendidos', async () => {
    await venderEn(db, { salidaId, sucursalId: fx.sucursales[0]!, usuarioId: vendedor, asiento: 5 });
    const cupoAntes = await cupoDeSalida(db, salidaId);

    const relevo = await crearConductorTipo(db);
    const r = await cambiarConductor(db, {
      salidaId, conductorNuevoId: relevo.conductorId, usuarioId: vendedor,
    });
    expect(r.cambioId).toEqual(expect.any(String));

    expect((await mapaSnapshot()).asientos, 'el mapa NO cambia: es de la unidad, no del conductor').toBe(18);
    expect(await cupoDeSalida(db, salidaId), 'el cupo NO cambia').toEqual(cupoAntes);

    const { rows: cond } = await db.query<{ nombre: string }>(
      `SELECT nombre FROM core.conductor WHERE id = $1`, [relevo.conductorId],
    );
    expect((await mapaSnapshot()).conductor).toBe(cond[0]!.nombre);
  });

  it('un conductor de un tipo de unidad totalmente distinto también es válido: el mapa sigue siendo el de la unidad', async () => {
    await venderEn(db, { salidaId, sucursalId: fx.sucursales[0]!, usuarioId: vendedor, asiento: 15 });
    const mini = await crearConductorTipo(db);   // 6 plazas — antes de 0074 esto hubiera sido "incompatible"

    await cambiarConductor(db, { salidaId, conductorNuevoId: mini.conductorId, usuarioId: vendedor });

    expect((await mapaSnapshot()).asientos, 'sigue siendo el mapa de la unidad (18)').toBe(18);
    const { rows } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.boleto WHERE salida_id = $1 AND asiento_num = 15`, [salidaId],
    );
    expect(rows[0]!.estado, 'el boleto ya vendido sigue emitido, nadie lo marca huérfano').toBe('emitido');
  });

  it('una salida en ruta no admite asignar conductor', async () => {
    await db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [salidaId]);
    const relevo = await crearConductorTipo(db);
    await expect(cambiarConductor(db, {
      salidaId, conductorNuevoId: relevo.conductorId, usuarioId: vendedor,
    })).rejects.toThrow(/en_ruta/i);
  });

  it('una salida cancelada no admite asignar conductor', async () => {
    await db.query(`UPDATE core.salida SET estado = 'cancelada' WHERE id = $1`, [salidaId]);
    const relevo = await crearConductorTipo(db);
    await expect(cambiarConductor(db, {
      salidaId, conductorNuevoId: relevo.conductorId, usuarioId: vendedor,
    })).rejects.toThrow(/cancelada/i);
  });

  it('registra siempre una fila en core.cambio_conductor', async () => {
    const relevo = await crearConductorTipo(db);
    const r = await cambiarConductor(db, {
      salidaId, conductorNuevoId: relevo.conductorId, usuarioId: vendedor, motivo: 'relevo de turno',
    });
    const { rows } = await db.query<{ conductor_anterior_id: string; conductor_nuevo_id: string; motivo: string }>(
      `SELECT conductor_anterior_id, conductor_nuevo_id, motivo FROM core.cambio_conductor WHERE id = $1`,
      [r.cambioId],
    );
    expect(rows[0]!.conductor_anterior_id).toBe(fx.conductorId);
    expect(rows[0]!.conductor_nuevo_id).toBe(relevo.conductorId);
    expect(rows[0]!.motivo).toBe('relevo de turno');
  });
});
