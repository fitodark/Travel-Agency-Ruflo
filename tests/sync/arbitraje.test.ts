/**
 * Arbitraje de sobreventa aplicado a la base (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §6
 *
 * Las propiedades PURAS de `arbitrar` / `prioridadDe` / `compararOcupaciones`
 * están en `tests/sync/motor-pendiente.test.ts`. Aquí se prueba la aplicación:
 * el ganador queda firme, los perdedores en conflicto sin borrarse, y se abre
 * una excepción crítica.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { resolverConflictoAsiento } from '../../src/sync/arbitraje.js';
import { crearBoleto, crearUsuario, seedCorte, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('arbitraje de sobreventa (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  interface OcuparArgs {
    salidaId: string; sucursalId: string; usuarioId: string; corteId: string;
    asiento: number; desde: number; hasta: number;
    estado: 'firme' | 'conflicto';
    emitidoEn: string;
    pagar?: boolean;
    impreso?: boolean;
  }

  const ocupar = async (a: OcuparArgs): Promise<{ boletoId: string; ocupacionId: string }> => {
    const boletoId = await crearBoleto(db, {
      salidaId: a.salidaId, sucursalId: a.sucursalId, usuarioId: a.usuarioId,
      asiento: a.asiento, desde: a.desde, hasta: a.hasta,
    });
    if (a.pagar) {
      await db.query(
        `INSERT INTO core.pago (id, venta_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                                metodo, monto, verificado, pagado_en)
         SELECT core.uuid_v7(), b.venta_id, $2, $3, $4, 'efectivo', b.importe, true, now()
           FROM core.boleto b WHERE b.id = $1`,
        [boletoId, a.sucursalId, a.corteId, a.usuarioId],
      );
    }
    if (a.impreso) {
      await db.query(`UPDATE core.boleto SET impreso_en = now() WHERE id = $1`, [boletoId]);
    }
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, boleto_id,
                                           estado, sucursal_id, emitido_en, prioridad)
       VALUES (core.uuid_v7(), $1, $2, $3::int4range, $4, $5, $6, $7::timestamptz, 0)
       RETURNING id`,
      [a.salidaId, a.asiento, `[${a.desde},${a.hasta})`, boletoId, a.estado, a.sucursalId, a.emitidoEn],
    );
    return { boletoId, ocupacionId: rows[0]!.id };
  };

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    return { fx, usuarioId, corteId };
  };

  it('la ocupación de mayor prioridad gana aunque haya llegado marcada como conflicto', async () => {
    const { fx, usuarioId, corteId } = await prep();
    // La firme es una reservación sin pago (nivel 4), emitida antes.
    const perdedora = await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, corteId,
      asiento: 7, desde: 0, hasta: 3, estado: 'firme',
      emitidoEn: '2026-09-01T10:00:00Z',
    });
    // La que llegó en conflicto está pagada (nivel 2): debe ganar.
    const ganadora = await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[1]!, usuarioId, corteId,
      asiento: 7, desde: 0, hasta: 3, estado: 'conflicto',
      emitidoEn: '2026-09-01T10:05:00Z', pagar: true,
    });

    const r = await resolverConflictoAsiento(db, fx.salidaId, 7);
    expect(r).not.toBeNull();
    expect(r!.ganador).toBe(ganadora.ocupacionId);
    expect(r!.perdedores).toEqual([perdedora.ocupacionId]);

    const { rows: oc } = await db.query<{ id: string; estado: string }>(
      `SELECT id, estado FROM core.asiento_ocupacion WHERE salida_id = $1 AND asiento_num = 7`,
      [fx.salidaId],
    );
    const porId = new Map(oc.map((o) => [o.id, o.estado]));
    expect(porId.get(ganadora.ocupacionId)).toBe('firme');
    expect(porId.get(perdedora.ocupacionId)).toBe('conflicto');
  });

  it('el perdedor NO se borra: su fila y su boleto siguen, marcados', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const perdedora = await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, corteId,
      asiento: 7, desde: 0, hasta: 3, estado: 'firme', emitidoEn: '2026-09-01T10:00:00Z',
    });
    await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[1]!, usuarioId, corteId,
      asiento: 7, desde: 0, hasta: 3, estado: 'conflicto',
      emitidoEn: '2026-09-01T10:05:00Z', pagar: true, impreso: true,
    });

    await resolverConflictoAsiento(db, fx.salidaId, 7);

    const { rows: b } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.boleto WHERE id = $1`, [perdedora.boletoId],
    );
    expect(b[0]!.estado).toBe('conflicto_sobreventa');
    const { rows: o } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.asiento_ocupacion WHERE id = $1`, [perdedora.ocupacionId],
    );
    expect(o[0]!.estado).toBe('conflicto');
  });

  it('abre una excepción `sobreventa` crítica y la deduplica en la segunda pasada', async () => {
    const { fx, usuarioId, corteId } = await prep();
    await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, corteId,
      asiento: 7, desde: 0, hasta: 3, estado: 'firme', emitidoEn: '2026-09-01T10:00:00Z',
    });
    await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[1]!, usuarioId, corteId,
      asiento: 7, desde: 0, hasta: 3, estado: 'conflicto',
      emitidoEn: '2026-09-01T10:05:00Z', pagar: true,
    });

    const r1 = await resolverConflictoAsiento(db, fx.salidaId, 7);
    const r2 = await resolverConflictoAsiento(db, fx.salidaId, 7);
    expect(r1!.excepcionId).toBe(r2!.excepcionId);

    const { rows } = await db.query<{ n: string; severidad: string }>(
      `SELECT count(*) AS n, min(severidad) AS severidad FROM sync.excepcion
        WHERE tipo = 'sobreventa' AND estado = 'abierta'
          AND detalle->>'salida_id' = $1 AND detalle->>'asiento_num' = '7'`,
      [fx.salidaId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
    expect(rows[0]!.severidad).toBe('critica');
  });

  it('dos boletos del mismo asiento en tramos DISJUNTOS no son sobreventa: devuelve null', async () => {
    const { fx, usuarioId, corteId } = await prep();
    await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, corteId,
      asiento: 7, desde: 0, hasta: 1, estado: 'firme', emitidoEn: '2026-09-01T10:00:00Z',
    });
    await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[1]!, usuarioId, corteId,
      asiento: 7, desde: 1, hasta: 3, estado: 'firme', emitidoEn: '2026-09-01T10:05:00Z',
    });

    expect(await resolverConflictoAsiento(db, fx.salidaId, 7)).toBeNull();
  });

  it('un asiento con una sola ocupación no tiene nada que arbitrar', async () => {
    const { fx, usuarioId, corteId } = await prep();
    await ocupar({
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, corteId,
      asiento: 7, desde: 0, hasta: 3, estado: 'firme', emitidoEn: '2026-09-01T10:00:00Z',
    });
    expect(await resolverConflictoAsiento(db, fx.salidaId, 7)).toBeNull();
  });
});
