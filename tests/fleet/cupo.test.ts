/**
 * Reparto de cupo offline por bloques contiguos (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §3
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F3, criterio 2)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { cupoDeSalida, repartirCupo } from '../../src/fleet/cupo.js';
import { materializarHorario } from '../../src/fleet/materializar.js';
import { seedRuta } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('reparto de cupo offline (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  /** Materializa un solo día y devuelve el id de esa salida. */
  const unaSalida = async (horarioId: string): Promise<string> => {
    await materializarHorario(db, horarioId, { dias: 0 });
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.salida WHERE horario_id = $1 ORDER BY fecha_operacion LIMIT 1`,
      [horarioId],
    );
    return rows[0]!.id;
  };

  // -------------------------------------------------------------------------
  // F3 · criterio 2 — cupos suman 18, sin traslape, fila completa por intermedia
  // -------------------------------------------------------------------------
  it('reparte la ruta S1→S2→S3→S4 tal como el blueprint §3.3', async () => {
    const fx = await seedRuta(db, { paradas: 4 });
    const salidaId = await unaSalida(fx.horarioId);
    const cupo = await cupoDeSalida(db, salidaId);

    // El destino no vende: 3 cupos, no 4.
    expect(cupo).toHaveLength(3);
    const porSucursal = new Map(cupo.map((c) => [c.sucursalId, c]));

    const s1 = porSucursal.get(fx.sucursales[0]!)!;
    const s2 = porSucursal.get(fx.sucursales[1]!)!;
    const s3 = porSucursal.get(fx.sucursales[2]!)!;

    expect([...s1.asientos].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18]);
    expect(s1.bloques.sort()).toEqual(['B0', 'B1', 'B2', 'B5']);
    expect(s1.tramos).toBe('[0,3)');

    expect([...s2.asientos].sort((a, b) => a - b)).toEqual([8, 9, 10]);
    expect(s2.bloques).toEqual(['B3']);
    expect(s2.tramos).toBe('[1,3)');

    expect([...s3.asientos].sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(s3.bloques).toEqual(['B4']);
    expect(s3.tramos).toBe('[2,3)');
  });

  it('los cupos son disjuntos y cubren exactamente las 18 plazas', async () => {
    const fx = await seedRuta(db, { paradas: 4 });
    const cupo = await cupoDeSalida(db, await unaSalida(fx.horarioId));

    const todos = cupo.flatMap((c) => c.asientos);
    expect(new Set(todos).size, 'un asiento en dos cupos = sobreventa posible offline').toBe(todos.length);
    expect([...new Set(todos)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 18 }, (_, i) => i + 1),
    );
  });

  it('cada intermedia recibe UNA fila completa (3 asientos, un bloque)', async () => {
    const fx = await seedRuta(db, { paradas: 5 });   // origen + 3 intermedias + destino
    const cupo = await cupoDeSalida(db, await unaSalida(fx.horarioId));

    const intermedias = cupo.filter((c) => c.sucursalId !== fx.sucursales[0]);
    expect(intermedias).toHaveLength(3);
    for (const c of intermedias) {
      expect(c.asientos).toHaveLength(3);
      expect(c.bloques).toHaveLength(1);
    }
    // El origen se queda con lo demás, incluida la banca de 4 (B5).
    const origen = cupo.find((c) => c.sucursalId === fx.sucursales[0])!;
    expect(origen.bloques).toContain('B5');
    expect(origen.asientos).toEqual(expect.arrayContaining([14, 15, 16, 17]));
  });

  it('una ruta sin intermedias deja los 6 bloques (18 asientos) en el origen', async () => {
    const fx = await seedRuta(db, { paradas: 2 });
    const cupo = await cupoDeSalida(db, await unaSalida(fx.horarioId));

    expect(cupo).toHaveLength(1);
    expect(cupo[0]!.asientos).toHaveLength(18);
    expect(cupo[0]!.bloques.sort()).toEqual(['B0', 'B1', 'B2', 'B3', 'B4', 'B5']);
    expect(cupo[0]!.tramos).toBe('[0,1)');
  });

  it('el cupo del intermedio expira a T-4h de su paso; el del origen, a su cierre de venta', async () => {
    const fx = await seedRuta(db, { paradas: 3, horasPaso: ['07:00', '09:00', '11:00'] });
    const salidaId = await unaSalida(fx.horarioId);
    const cupo = await cupoDeSalida(db, salidaId);

    const { rows: sp } = await db.query<{ orden: number; hp: Date; cierre: Date }>(
      `SELECT orden, hora_paso_programada AS hp, cierre_venta_en AS cierre
         FROM core.salida_parada WHERE salida_id = $1 ORDER BY orden`, [salidaId],
    );
    const paso1 = sp.find((r) => r.orden === 1)!;
    const paso0 = sp.find((r) => r.orden === 0)!;

    const intermedia = cupo.find((c) => c.sucursalId === fx.sucursales[1])!;
    const origen = cupo.find((c) => c.sucursalId === fx.sucursales[0])!;

    expect(intermedia.vigenteHasta.getTime()).toBe(paso1.hp.getTime() - 4 * 3_600_000);
    expect(origen.vigenteHasta.getTime()).toBe(paso0.cierre.getTime());
  });

  it('es idempotente: repartir de nuevo da el mismo resultado', async () => {
    const fx = await seedRuta(db, { paradas: 4 });
    const salidaId = await unaSalida(fx.horarioId);
    const antes = await cupoDeSalida(db, salidaId);

    const n = await repartirCupo(db, salidaId);
    expect(n).toBe(3);
    const despues = await cupoDeSalida(db, salidaId);

    expect(despues.map((c) => ({ s: c.sucursalId, a: c.asientos, b: c.bloques })))
      .toEqual(antes.map((c) => ({ s: c.sucursalId, a: c.asientos, b: c.bloques })));
  });

  it('la materialización ya deja el cupo repartido, sin llamar nada más', async () => {
    const fx = await seedRuta(db, { paradas: 4 });
    await materializarHorario(db, fx.horarioId, { dias: 3 });

    const { rows } = await db.query<{ salidas: string; con_cupo: string }>(
      `SELECT count(DISTINCT s.id) AS salidas,
              count(DISTINCT co.salida_id) AS con_cupo
         FROM core.salida s
         LEFT JOIN core.cupo_offline co ON co.salida_id = s.id
        WHERE s.horario_id = $1`, [fx.horarioId],
    );
    expect(rows[0]!.salidas).toBe(rows[0]!.con_cupo);
  });

  it('rechaza cuando hay más paradas vendedoras que bloques (01b §3.5)', async () => {
    const fx = await seedRuta(db, { paradas: 8 });   // 6 intermedias para 6 bloques → origen sin nada
    // El reparto lo dispara la materialización; debe fallar ahí.
    await expect(materializarHorario(db, fx.horarioId, { dias: 0 })).rejects.toThrow(/insuficiente/i);
  });
});
