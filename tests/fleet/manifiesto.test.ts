/**
 * Viajes efectuados: listado del día y manifiestos (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F7, slice 1)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  datosManifiesto, generarManifiestos, salidasDelDia,
} from '../../src/fleet/manifiesto.js';
import { crearUsuario, seedSalida, sembrarOcupacion } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

interface Asenso {
  parada_orden: number;
  sucursal: string;
  pasajeros: Array<Record<string, unknown>>;
}

run('viajes efectuados · manifiestos (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 12 });
    const usuarioId = await crearUsuario(db);
    return { fx, usuarioId };
  };

  const vende = (
    fx: Awaited<ReturnType<typeof seedSalida>>, usuarioId: string,
    asiento: number, desde: number, hasta: number,
  ) => sembrarOcupacion(db, {
    salidaId: fx.salidaId, sucursalId: fx.sucursales[desde]!, usuarioId,
    asiento, desde, hasta, estado: 'firme',
  });

  // -------------------------------------------------------------------------
  it('lista las salidas del día, filtrando por sucursal', async () => {
    const { fx } = await prep();
    const lista = await salidasDelDia(db, {
      fecha: fx.fechaOperacion, sucursalId: fx.sucursales[0]!,
    });
    const mia = lista.find((s) => s.salidaId === fx.salidaId);
    expect(mia).toBeDefined();
    expect(mia!.origen).not.toBe(mia!.destino);
    expect(mia!.estado).toBe('programada');

    // Una sucursal que no está en la ruta no ve esta salida.
    const otra = await seedSalida(db, { paradas: 2, diasAdelante: 12 });
    const ajena = await salidasDelDia(db, {
      fecha: fx.fechaOperacion, sucursalId: otra.sucursales[0]!,
    });
    expect(ajena.find((s) => s.salidaId === fx.salidaId)).toBeUndefined();
  });

  it('el manifiesto de terminal agrupa por parada de ascenso, con importe y saldo', async () => {
    const { fx, usuarioId } = await prep();
    await vende(fx, usuarioId, 2, 0, 3);
    await vende(fx, usuarioId, 3, 0, 3);
    await vende(fx, usuarioId, 8, 1, 3);

    const m = await datosManifiesto(db, fx.salidaId, 'terminal');
    const ascensos = m['ascensos'] as Asenso[];
    // Paradas 0, 1 y 2 son de ascenso; la 3 es el destino y no aparece.
    expect(ascensos.map((a) => a.parada_orden)).toEqual([0, 1, 2]);
    expect(ascensos[0]!.pasajeros).toHaveLength(2);
    expect(ascensos[1]!.pasajeros).toHaveLength(1);
    expect(ascensos[2]!.pasajeros, 'una parada sin nadie se lista vacía').toHaveLength(0);

    const p = ascensos[0]!.pasajeros[0]!;
    expect(p).toMatchObject({ asiento: 2, nombre: 'Pasajero', importe: 450, saldo_pendiente: 450 });
    expect(typeof p['folio']).toBe('string');
    expect(m['ocupacion_por_tramo']).toBeDefined();
  });

  it('la copia del conductor no lleva importes ni saldo ni ocupación por tramo', async () => {
    const { fx, usuarioId } = await prep();
    await vende(fx, usuarioId, 2, 0, 3);

    const m = await datosManifiesto(db, fx.salidaId, 'conductor');
    const p = (m['ascensos'] as Asenso[])[0]!.pasajeros[0]!;
    expect(p['importe']).toBeUndefined();
    expect(p['saldo_pendiente']).toBeUndefined();
    expect(m['ocupacion_por_tramo']).toBeUndefined();
    expect(m['copia']).toBe('conductor');
  });

  it('los boletos en conflicto van marcados en el manifiesto de terminal', async () => {
    const { fx, usuarioId } = await prep();
    const ok = await vende(fx, usuarioId, 2, 0, 3);
    const conf = await vende(fx, usuarioId, 3, 0, 3);
    await db.query(
      `UPDATE core.boleto SET estado = 'conflicto_sobreventa' WHERE id = $1`, [conf.boletoId],
    );

    const m = await datosManifiesto(db, fx.salidaId, 'terminal');
    const pax = (m['ascensos'] as Asenso[])[0]!.pasajeros;
    const porAsiento = new Map(pax.map((x) => [x['asiento'], x]));
    expect(porAsiento.get(2)!['conflicto']).toBe(false);
    expect(porAsiento.get(3)!['conflicto']).toBe(true);
    expect(ok.boletoId).toBeDefined();
  });

  it('`generarManifiestos` encola los dos jobs con el conteo de pasajeros', async () => {
    const { fx, usuarioId } = await prep();
    await vende(fx, usuarioId, 2, 0, 3);
    await vende(fx, usuarioId, 8, 1, 3);

    const r = await generarManifiestos(db, { salidaId: fx.salidaId, usuarioId });
    expect(r.conductor.pasajeros).toBe(2);
    expect(r.terminal.pasajeros).toBe(2);

    const { rows } = await db.query<{ template_key: string; sucursal: string }>(
      `SELECT pj.template_key, pj.sucursal_id AS sucursal
         FROM core.print_job pj
        WHERE pj.id IN ($1, $2)`,
      [r.conductor.printJobId, r.terminal.printJobId],
    );
    expect(rows.map((x) => x.template_key).sort())
      .toEqual(['manifiesto_conductor', 'manifiesto_terminal']);
    expect(new Set(rows.map((x) => x.sucursal))).toEqual(new Set([fx.sucursales[0]]));
  });

  it('regenerar da de baja los manifiestos pendientes anteriores', async () => {
    const { fx, usuarioId } = await prep();
    await vende(fx, usuarioId, 2, 0, 3);
    const primero = await generarManifiestos(db, { salidaId: fx.salidaId, usuarioId });

    await vende(fx, usuarioId, 3, 0, 3);
    const segundo = await generarManifiestos(db, { salidaId: fx.salidaId, usuarioId });
    expect(segundo.terminal.pasajeros).toBe(2);

    const { rows } = await db.query<{ id: string; activo: boolean; estado: string }>(
      `SELECT id, activo, estado FROM core.print_job
        WHERE template_key IN ('manifiesto_conductor', 'manifiesto_terminal')
          AND datos->>'salida_id' = $1`, [fx.salidaId],
    );
    const activos = rows.filter((x) => x.activo);
    expect(activos).toHaveLength(2);
    expect(activos.map((x) => x.id).sort())
      .toEqual([segundo.conductor.printJobId, segundo.terminal.printJobId].sort());
    expect(rows.filter((x) => !x.activo).map((x) => x.id).sort())
      .toEqual([primero.conductor.printJobId, primero.terminal.printJobId].sort());
  });

  it('`generado_en` refleja el reloj inyectado', async () => {
    const { fx } = await prep();
    const t = new Date('2026-09-12T06:40:00Z');
    const m = await datosManifiesto(db, fx.salidaId, 'terminal', t);
    expect(new Date(m['generado_en'] as string).getTime()).toBe(t.getTime());
  });

  it('rechaza una salida inexistente', async () => {
    await expect(
      datosManifiesto(db, '00000000-0000-7000-8000-000000000000', 'terminal'),
    ).rejects.toThrow(/no existe/i);
  });

  it('rechaza una copia de manifiesto inválida', async () => {
    const { fx } = await prep();
    await expect(
      datosManifiesto(db, fx.salidaId, 'otra' as 'terminal'),
    ).rejects.toThrow(/copia de manifiesto inválida/i);
  });
});
