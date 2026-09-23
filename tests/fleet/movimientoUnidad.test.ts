/**
 * Traspaso EN CADENA de unidad entre salidas de la misma ruta, mismo día
 * (0074, regla de QA Ses. 75, segunda vuelta): una salida sin pasajeros dona
 * su unidad a la siguiente; si esa ya tenía su propia unidad, esa unidad
 * desplazada pasa al siguiente eslabón, y así hasta un hueco o el fin del día.
 * La salida donante se cancela. Nunca cruza a otro día.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { moverUnidad } from '../../src/fleet/movimientoUnidad.js';
import { materializarHorario } from '../../src/fleet/materializar.js';
import { crearUsuario, seedRuta, venderEn, type RutaFixture } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('traspaso en cadena de unidad entre salidas (PostgreSQL real)', () => {
  let db: Client;
  let fx: RutaFixture;
  let salidaOrigenId: string;
  let usuarioId: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    fx = await seedRuta(db, { paradas: 2, horaSalida: '09:00' });
    await materializarHorario(db, fx.horarioId, { dias: 0 });
    const sal = await db.query<{ id: string }>(
      `SELECT id FROM core.salida WHERE horario_id = $1 LIMIT 1`, [fx.horarioId],
    );
    salidaOrigenId = sal.rows[0]!.id;
    usuarioId = await crearUsuario(db, 'vendedor');
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  /** Otro horario de la MISMA ruta, mismo día (por defecto), con o sin unidad propia. */
  const otroHorario = async (
    opts: { horaSalida: string; conUnidad?: boolean; fechaDistinta?: boolean },
  ): Promise<{ horarioId: string; salidaId: string; unidadId: string | null }> => {
    const { rows: h } = await db.query<{ id: string }>(
      `INSERT INTO core.horario (ruta_id, hora_salida, dias_semana)
       VALUES ($1, $2::time, ARRAY[1,2,3,4,5,6,7]::smallint[]) RETURNING id`,
      [fx.rutaId, opts.horaSalida],
    );
    const horarioId = h[0]!.id;

    let unidadId: string | null = null;
    if (opts.conUnidad) {
      const { rows: u } = await db.query<{ id: string }>(
        `INSERT INTO core.unidad (tipo_unidad_id, numero_economico) VALUES ($1, $2) RETURNING id`,
        [fx.tipoUnidadId, `U-extra-${Date.now()}-${Math.random()}`],
      );
      unidadId = u[0]!.id;
    }

    const { rows: sal } = await db.query<{ id: string; fecha_operacion: string }>(
      `SELECT id, fecha_operacion FROM core.salida WHERE horario_id = $1`, [fx.horarioId],
    );
    const { rows: nueva } = await db.query<{ id: string; fecha_operacion: string }>(
      `INSERT INTO core.salida (horario_id, fecha_operacion, tipo_unidad_id, mapa_snapshot, unidad_id, estado)
       SELECT $1,
              CASE WHEN $4 THEN s.fecha_operacion + 1 ELSE s.fecha_operacion END,
              s.tipo_unidad_id, s.mapa_snapshot, $2, 'programada'
         FROM core.salida s WHERE s.id = $3
       RETURNING id, fecha_operacion::text`,
      [horarioId, unidadId, sal[0]!.id, opts.fechaDistinta ?? false],
    );
    const salidaId = nueva[0]!.id;

    // La cadena de mover_unidad ordena por `salida_parada.orden = 0`: sin esa
    // fila el candidato queda invisible para la consulta.
    await db.query(
      `INSERT INTO core.salida_parada (salida_id, punto_id, orden, hora_paso_programada, cierre_venta_en)
       VALUES ($1, $2, 0, ($3::date + $4::time), ($3::date + $4::time) - interval '15 minutes')`,
      [salidaId, fx.puntos[0]!, nueva[0]!.fecha_operacion, opts.horaSalida],
    );

    return { horarioId, salidaId, unidadId };
  };

  it('cadena de dos eslabones: la segunda salida dona lo que tenía a la tercera, que estaba vacía', async () => {
    const slot10 = await otroHorario({ horaSalida: '10:00', conUnidad: true });
    const slot11 = await otroHorario({ horaSalida: '11:00' });   // sin unidad: absorbe el último eslabón

    const r = await moverUnidad(db, { salidaOrigenId, usuarioId });
    expect(r.salidasAfectadas).toBe(2);
    expect(r.unidadDesplazadaId).toBeNull();

    const { rows } = await db.query<{ id: string; estado: string; unidad_id: string | null }>(
      `SELECT id, estado, unidad_id FROM core.salida WHERE id = ANY($1::uuid[])`,
      [[salidaOrigenId, slot10.salidaId, slot11.salidaId]],
    );
    const porId = new Map(rows.map((x) => [x.id, x]));
    expect(porId.get(salidaOrigenId)!.estado).toBe('cancelada');
    expect(porId.get(salidaOrigenId)!.unidad_id).toBeNull();
    expect(porId.get(slot10.salidaId)!.unidad_id).toBe(fx.unidadId);
    expect(porId.get(slot11.salidaId)!.unidad_id).toBe(slot10.unidadId);

    const { rows: mov } = await db.query<{ salida_destino_id: string; unidad_id: string }>(
      `SELECT salida_destino_id, unidad_id FROM core.movimiento_unidad
        WHERE salida_origen_id = $1 ORDER BY movido_en`,
      [salidaOrigenId],
    );
    expect(mov).toEqual([
      { salida_destino_id: slot10.salidaId, unidad_id: fx.unidadId },
      { salida_destino_id: slot11.salidaId, unidad_id: slot10.unidadId },
    ]);
  });

  it('si la cadena llega al fin del día sin un hueco, la última unidad queda desplazada (sin horario)', async () => {
    const slot10 = await otroHorario({ horaSalida: '10:00', conUnidad: true });

    const r = await moverUnidad(db, { salidaOrigenId, usuarioId });
    expect(r.salidasAfectadas).toBe(1);
    expect(r.unidadDesplazadaId).toBe(slot10.unidadId);

    const { rows } = await db.query<{ unidad_id: string }>(
      `SELECT unidad_id FROM core.salida WHERE id = $1`, [slot10.salidaId],
    );
    expect(rows[0]!.unidad_id).toBe(fx.unidadId);
  });

  it('una salida intermedia con boletos vendidos NO bloquea la cadena: el mapa es del conductor, no de la unidad', async () => {
    const slot10 = await otroHorario({ horaSalida: '10:00', conUnidad: true });
    await venderEn(db, { salidaId: slot10.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, asiento: 5 });

    const r = await moverUnidad(db, { salidaOrigenId, usuarioId });
    expect(r.salidasAfectadas).toBe(1);

    const { rows } = await db.query<{ unidad_id: string; estado: string }>(
      `SELECT unidad_id, estado FROM core.salida WHERE id = $1`, [slot10.salidaId],
    );
    expect(rows[0]!.unidad_id).toBe(fx.unidadId);
    expect(rows[0]!.estado, 'sigue programada, el boleto no se ve afectado').toBe('programada');

    const { rows: bol } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.boleto WHERE salida_id = $1`, [slot10.salidaId],
    );
    expect(bol[0]!.estado).toBe('emitido');
  });

  it('no cruza al día siguiente: una salida de la misma ruta un día después no se toca', async () => {
    const manana = await otroHorario({ horaSalida: '10:00', conUnidad: true, fechaDistinta: true });

    const r = await moverUnidad(db, { salidaOrigenId, usuarioId });
    expect(r.salidasAfectadas).toBe(0);
    expect(r.unidadDesplazadaId).toBe(fx.unidadId);

    const { rows } = await db.query<{ unidad_id: string }>(
      `SELECT unidad_id FROM core.salida WHERE id = $1`, [manana.salidaId],
    );
    expect(rows[0]!.unidad_id).toBe(manana.unidadId);
  });

  it('el conductor de ninguna salida de la cadena se toca', async () => {
    const slot10 = await otroHorario({ horaSalida: '10:00', conUnidad: true });
    await db.query(`UPDATE core.salida SET conductor_id = $1 WHERE id = $2`, [fx.conductorId, slot10.salidaId]);

    await moverUnidad(db, { salidaOrigenId, usuarioId });

    const { rows } = await db.query<{ conductor_id: string | null }>(
      `SELECT conductor_id FROM core.salida WHERE id = $1`, [slot10.salidaId],
    );
    expect(rows[0]!.conductor_id).toBe(fx.conductorId);
  });

  it('rechaza si la salida origen todavía tiene boletos activos', async () => {
    await venderEn(db, { salidaId: salidaOrigenId, sucursalId: fx.sucursales[0]!, usuarioId, asiento: 5 });
    await otroHorario({ horaSalida: '10:00' });

    await expect(moverUnidad(db, { salidaOrigenId, usuarioId })).rejects.toThrow(/boleto/i);
  });

  it('rechaza si la salida origen ya está cancelada', async () => {
    await otroHorario({ horaSalida: '10:00' });
    await db.query(`UPDATE core.salida SET estado = 'cancelada' WHERE id = $1`, [salidaOrigenId]);

    await expect(moverUnidad(db, { salidaOrigenId, usuarioId })).rejects.toThrow(/cancelada/i);
  });

  it('rechaza si la salida origen no tiene unidad asignada', async () => {
    await db.query(`UPDATE core.salida SET unidad_id = NULL WHERE id = $1`, [salidaOrigenId]);

    await expect(moverUnidad(db, { salidaOrigenId, usuarioId })).rejects.toThrow(/no tiene unidad/i);
  });
});
