/**
 * Reasignación automática del perdedor de un arbitraje (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §7
 *
 * Las propiedades PURAS de `elegirAsientoReasignado` están en
 * `tests/sync/motor-pendiente.test.ts`. Aquí, la aplicación a la base.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { resolverConflictoAsiento } from '../../src/sync/arbitraje.js';
import { proponerReasignacion, reasignarPerdedores } from '../../src/sync/reasignacion.js';
import { crearUsuario, seedCorte, seedSalida, sembrarOcupacion } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('reasignación por conflicto (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  /**
   * Deja el boleto `perdedor` en `conflicto_sobreventa` sobre `asiento`:
   * una reservación sin pago (nivel 4) que pierde contra una venta pagada.
   */
  const conflictoEn = async (asiento: number, ocupar: number[] = []) => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);

    for (const a of ocupar) {
      await sembrarOcupacion(db, {
        salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId,
        asiento: a, desde: 0, hasta: 3, estado: 'firme', emitidoEn: '2026-09-01T09:00:00Z',
      });
    }

    const perdedor = await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId,
      asiento, desde: 0, hasta: 3, estado: 'firme', emitidoEn: '2026-09-01T10:00:00Z',
    });
    await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[1]!, usuarioId, corteId,
      asiento, desde: 0, hasta: 3, estado: 'conflicto',
      emitidoEn: '2026-09-01T10:05:00Z', pagar: true,
    });

    const res = await resolverConflictoAsiento(db, fx.salidaId, asiento);
    expect(res!.perdedoresBoletoId).toEqual([perdedor.boletoId]);
    return { fx, usuarioId, perdedorBoletoId: perdedor.boletoId, folio: perdedor };
  };

  it('reasigna al perdedor a otro asiento del MISMO bloque y conserva el folio', async () => {
    const { perdedorBoletoId } = await conflictoEn(2);   // bloque B1 = {2,3,4}
    const { rows: antes } = await db.query<{ folio: string }>(
      `SELECT folio FROM core.boleto WHERE id = $1`, [perdedorBoletoId],
    );

    const r = await proponerReasignacion(db, perdedorBoletoId);
    expect(r).not.toBeNull();
    expect(r!.asientoAnterior).toBe(2);
    expect(r!.asientoNuevo).toBe(3);
    expect(r!.motivo).toBe('mismo_bloque');
    expect(r!.folio, 'el folio NO cambia').toBe(antes[0]!.folio);

    const { rows: b } = await db.query<{ asiento: number; estado: string; folio: string }>(
      `SELECT asiento_num AS asiento, estado, folio FROM core.boleto WHERE id = $1`,
      [perdedorBoletoId],
    );
    expect(b[0]!.asiento).toBe(3);
    expect(b[0]!.estado).toBe('reasignado');
    expect(b[0]!.folio).toBe(antes[0]!.folio);

    // La ocupación vieja quedó liberada, la nueva es firme.
    const { rows: oc } = await db.query<{ asiento: number; estado: string }>(
      `SELECT asiento_num AS asiento, estado FROM core.asiento_ocupacion
        WHERE boleto_id = $1 ORDER BY asiento_num`, [perdedorBoletoId],
    );
    expect(oc).toEqual([
      { asiento: 2, estado: 'liberado' },
      { asiento: 3, estado: 'firme' },
    ]);
  });

  it('deja nota_auditoria(reasignacion_por_conflicto) y encola una reimpresión marcada', async () => {
    const { perdedorBoletoId } = await conflictoEn(2);
    await proponerReasignacion(db, perdedorBoletoId);

    const { rows: nota } = await db.query<{ tipo: string; detalle: Record<string, unknown> }>(
      `SELECT tipo, detalle FROM core.nota_auditoria
        WHERE entidad = 'core.boleto' AND entidad_id = $1`, [perdedorBoletoId],
    );
    expect(nota).toHaveLength(1);
    expect(nota[0]!.tipo).toBe('reasignacion_por_conflicto');
    expect(nota[0]!.detalle).toMatchObject({ asiento_anterior: 2, asiento_nuevo: 3, motivo: 'mismo_bloque' });

    const { rows: pj } = await db.query<{ es_reimpresion: boolean; motivo: string; estado: string }>(
      `SELECT es_reimpresion, motivo_reimpresion AS motivo, estado
         FROM core.print_job WHERE boleto_id = $1 AND es_reimpresion`, [perdedorBoletoId],
    );
    expect(pj).toHaveLength(1);
    expect(pj[0]!.motivo).toMatch(/CAMBIO DE ASIENTO/);
    expect(pj[0]!.estado).toBe('pendiente');
  });

  it('con la unidad llena devuelve null y abre una excepción de severidad alta', async () => {
    // Ocupa todas las demás plazas del tramo; el perdedor queda sin dónde ir.
    const otras = Array.from({ length: 18 }, (_, i) => i + 1).filter((n) => n !== 5);
    const { perdedorBoletoId } = await conflictoEn(5, otras);

    const r = await proponerReasignacion(db, perdedorBoletoId);
    expect(r).toBeNull();

    const { rows } = await db.query<{ n: string; severidad: string; motivo: string }>(
      `SELECT count(*) AS n, min(severidad) AS severidad, min(detalle->>'motivo') AS motivo
         FROM sync.excepcion
        WHERE tipo = 'sobreventa' AND estado = 'abierta' AND detalle->>'boleto_id' = $1`,
      [perdedorBoletoId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
    expect(rows[0]!.severidad).toBe('alta');
    expect(rows[0]!.motivo).toBe('unidad_llena');

    // El boleto perdedor NO se borró ni cambió de asiento.
    const { rows: b } = await db.query<{ asiento: number; estado: string }>(
      `SELECT asiento_num AS asiento, estado FROM core.boleto WHERE id = $1`, [perdedorBoletoId],
    );
    expect(b[0]!).toEqual({ asiento: 5, estado: 'conflicto_sobreventa' });
  });

  it('`reasignarPerdedores` encadena §6 → §7 sobre la salida del `resolverConflictoAsiento`', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);

    await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId,
      asiento: 6, desde: 0, hasta: 3, estado: 'firme', emitidoEn: '2026-09-01T10:00:00Z',
    });
    await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[1]!, usuarioId, corteId,
      asiento: 6, desde: 0, hasta: 3, estado: 'conflicto',
      emitidoEn: '2026-09-01T10:05:00Z', pagar: true,
    });

    const res = await resolverConflictoAsiento(db, fx.salidaId, 6);
    const chain = await reasignarPerdedores(db, res!.perdedoresBoletoId);

    expect(chain.sinCupo).toEqual([]);
    expect(chain.reasignados).toHaveLength(1);
    expect(chain.reasignados[0]!.motivo).toBe('mismo_bloque');
    expect(chain.reasignados[0]!.asientoNuevo).toBe(5);   // B2 = {5,6,7}, libre menor
  });
});
