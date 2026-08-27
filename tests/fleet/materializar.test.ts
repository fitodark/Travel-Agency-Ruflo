/**
 * Materialización de salidas (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §6.1
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F3, criterio 1)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { materializarHorario, materializarVigentes } from '../../src/fleet/materializar.js';
import { seedRuta } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('materialización de salidas (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const contarSalidas = async (horarioId: string): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.salida WHERE horario_id = $1`, [horarioId],
    );
    return Number(rows[0]!.n);
  };

  // -------------------------------------------------------------------------
  // F2 · criterio 1 — un horario con dos paradas intermedias genera salidas
  //      con paradas, horas de paso y mapa_snapshot
  // -------------------------------------------------------------------------
  it('genera una salida por día operativo del horizonte, con mapa congelado y paradas', async () => {
    const fx = await seedRuta(db, { paradas: 4 });   // origen + 2 intermedias + destino
    const r = await materializarHorario(db, fx.horarioId, { dias: 20 });

    expect(r.creadas).toBe(21);          // generate_series inclusivo: hoy .. hoy+20
    expect(r.yaExistentes).toBe(0);
    expect(r.sinParadas).toBe(0);
    expect(await contarSalidas(fx.horarioId)).toBe(21);

    // Cada salida trae el mapa de la Sprinter congelado y el nombre del conductor.
    const { rows: s } = await db.query<{
      mapa_asientos: number; conductor: string; tipo_ok: boolean;
    }>(
      `SELECT jsonb_array_length(mapa_snapshot->'asientos') AS mapa_asientos,
              conductor_nombre_snapshot AS conductor,
              tipo_unidad_id = $2 AS tipo_ok
         FROM core.salida WHERE horario_id = $1 ORDER BY fecha_operacion LIMIT 1`,
      [fx.horarioId, fx.tipoUnidadId],
    );
    expect(s[0]!.mapa_asientos).toBe(18);
    expect(s[0]!.conductor).toBe(fx.conductorNombre);
    expect(s[0]!.tipo_ok).toBe(true);

    // Cada salida tiene 4 paradas, con hora de paso y cierre de venta 15 min antes.
    const { rows: p } = await db.query<{ n: string; cierre_ok: boolean }>(
      `SELECT count(*) AS n,
              bool_and(cierre_venta_en = hora_paso_programada - interval '15 minutes') AS cierre_ok
         FROM core.salida_parada sp
         JOIN core.salida s ON s.id = sp.salida_id
        WHERE s.horario_id = $1`,
      [fx.horarioId],
    );
    expect(Number(p[0]!.n)).toBe(21 * 4);
    expect(p[0]!.cierre_ok).toBe(true);
  });

  it('es idempotente: la segunda pasada no crea nada', async () => {
    const fx = await seedRuta(db);
    expect((await materializarHorario(db, fx.horarioId, { dias: 10 })).creadas).toBe(11);

    const r2 = await materializarHorario(db, fx.horarioId, { dias: 10 });
    expect(r2.creadas).toBe(0);
    expect(r2.yaExistentes).toBe(11);
    expect(await contarSalidas(fx.horarioId)).toBe(11);
  });

  it('respeta `dias_semana`: un horario de fin de semana no genera salidas entre semana', async () => {
    const fx = await seedRuta(db, { diasSemana: [6, 7] });   // sáb y dom
    await materializarHorario(db, fx.horarioId, { dias: 27 }); // 4 semanas

    const { rows } = await db.query<{ dow: number; n: string }>(
      `SELECT extract(isodow FROM fecha_operacion)::int AS dow, count(*) AS n
         FROM core.salida WHERE horario_id = $1 GROUP BY 1 ORDER BY 1`,
      [fx.horarioId],
    );
    expect(rows.map((r) => r.dow)).toEqual([6, 7]);
  });

  it('respeta `vigente_desde` y `vigente_hasta` del horario', async () => {
    const en5 = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const en12 = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
    const fx = await seedRuta(db, { vigenteDesde: en5, vigenteHasta: en12 });

    await materializarHorario(db, fx.horarioId, { dias: 60 });
    const { rows } = await db.query<{ min: string; max: string; n: string }>(
      `SELECT min(fecha_operacion)::text AS min, max(fecha_operacion)::text AS max, count(*) AS n
         FROM core.salida WHERE horario_id = $1`,
      [fx.horarioId],
    );
    expect(rows[0]!.min).toBe(en5);
    expect(rows[0]!.max).toBe(en12);
    expect(Number(rows[0]!.n)).toBe(8);
  });

  it('la hora de paso queda en la zona horaria de la sucursal', async () => {
    const fx = await seedRuta(db, { horaSalida: '07:00', horasPaso: ['07:00', '08:00', '09:00'] });
    await materializarHorario(db, fx.horarioId, { dias: 0 });

    const { rows } = await db.query<{ hora_local: string; orden: number }>(
      `SELECT to_char(hora_paso_programada AT TIME ZONE 'America/Mexico_City', 'HH24:MI') AS hora_local,
              orden
         FROM core.salida_parada sp JOIN core.salida s ON s.id = sp.salida_id
        WHERE s.horario_id = $1 ORDER BY orden`,
      [fx.horarioId],
    );
    expect(rows.map((r) => r.hora_local)).toEqual(['07:00', '08:00', '09:00']);
  });

  it('sin horizonte explícito usa el parámetro (90 días)', async () => {
    const fx = await seedRuta(db);
    const r = await materializarHorario(db, fx.horarioId);
    // 91 días inclusivos, todos los días de la semana.
    expect(r.creadas).toBe(91);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Rechazos
  // -------------------------------------------------------------------------
  it('rechaza un horario sin conductor (D-7: sin él no hay tipo de unidad ni mapa)', async () => {
    const fx = await seedRuta(db, { sinConductor: true });
    await expect(materializarHorario(db, fx.horarioId)).rejects.toThrow(/conductor/i);
  });

  it('rechaza un horario dado de baja', async () => {
    const fx = await seedRuta(db);
    await db.query(`UPDATE core.horario SET activo = false WHERE id = $1`, [fx.horarioId]);
    await expect(materializarHorario(db, fx.horarioId)).rejects.toThrow(/vigente/i);
  });

  it('rechaza un horario inexistente', async () => {
    await expect(
      materializarHorario(db, '00000000-0000-7000-8000-000000000000'),
    ).rejects.toThrow(/no existe/i);
  });

  // -------------------------------------------------------------------------
  // `materializarVigentes`
  // -------------------------------------------------------------------------
  it('`materializarVigentes` procesa todos los horarios con conductor y salta los que no', async () => {
    const conConductor = await seedRuta(db);
    const sinConductor = await seedRuta(db, { sinConductor: true });

    const r = await materializarVigentes(db, { dias: 5 });
    const rutas = r.detalle.map((d) => d.horarioId);
    expect(rutas).toContain(conConductor.horarioId);
    expect(rutas).not.toContain(sinConductor.horarioId);
    expect(r.creadas).toBeGreaterThanOrEqual(6);
  });
});
