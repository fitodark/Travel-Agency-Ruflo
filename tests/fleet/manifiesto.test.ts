/**
 * Viajes efectuados: listado del día y manifiestos (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
 *                  docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D11)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  datosManifiesto, generarManifiestos, salidasDelDia,
} from '../../src/fleet/manifiesto.js';
import { crearUsuario, seedCorte, seedSalida, sembrarOcupacion } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

interface Pasajero {
  folio: string;
  asiento: number;
  nombre: string;
  sube_en: string;
  sube_en_orden: number;
  baja_en: string;
  baja_en_orden: number;
  estatus_pago: 'pagado' | 'pendiente';
  conflicto: boolean;
  [k: string]: unknown;
}

const pasajerosDe = (m: Record<string, unknown>): Pasajero[] => m['pasajeros'] as Pasajero[];

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
  it('lista los viajes que salen de mi terminal y los que pasan por ella con ascenso (0081)', async () => {
    const { fx } = await prep();   // 4 paradas: sucursales[0] origen … [3] destino
    const laMia = await salidasDelDia(db, {
      fecha: fx.fechaOperacion, sucursalId: fx.sucursales[0]!,
    });
    const mia = laMia.find((s) => s.salidaId === fx.salidaId);
    expect(mia).toBeDefined();
    expect(mia!.origen).not.toBe(mia!.destino);
    expect(mia!.estado).toBe('programada');
    expect(mia!.esOrigen).toBe(true);
    expect(mia!.horaPaso.getTime()).toBe(mia!.horaSalida.getTime());

    // Una terminal INTERMEDIA lo ve "de paso", con SU hora de paso (0081).
    const intermedia = await salidasDelDia(db, {
      fecha: fx.fechaOperacion, sucursalId: fx.sucursales[1]!,
    });
    const dePaso = intermedia.find((s) => s.salidaId === fx.salidaId);
    expect(dePaso).toBeDefined();
    expect(dePaso!.esOrigen).toBe(false);
    expect(dePaso!.horaPaso.getTime()).toBeGreaterThan(dePaso!.horaSalida.getTime());

    // La terminal de DESTINO no (ahí solo se baja).
    const destino = await salidasDelDia(db, {
      fecha: fx.fechaOperacion, sucursalId: fx.sucursales[3]!,
    });
    expect(destino.find((s) => s.salidaId === fx.salidaId)).toBeUndefined();

    // Una sucursal que ni siquiera está en la ruta, obviamente tampoco.
    const otra = await seedSalida(db, { paradas: 2, diasAdelante: 12 });
    const ajena = await salidasDelDia(db, {
      fecha: fx.fechaOperacion, sucursalId: otra.sucursales[0]!,
    });
    expect(ajena.find((s) => s.salidaId === fx.salidaId)).toBeUndefined();
  });

  it('el manifiesto es una lista única por pasajero (sube / baja / estatus), sin importe', async () => {
    const { fx, usuarioId } = await prep();
    await vende(fx, usuarioId, 3, 0, 3);
    await vende(fx, usuarioId, 2, 0, 3);
    await vende(fx, usuarioId, 8, 1, 3);

    const m = await datosManifiesto(db, fx.salidaId, 'terminal');
    const pax = pasajerosDe(m);

    // Ordenado por punto de ascenso y luego asiento: 2@0, 3@0, 8@1.
    expect(pax.map((p) => p.asiento)).toEqual([2, 3, 8]);
    expect(pax.map((p) => p.sube_en_orden)).toEqual([0, 0, 1]);
    expect(pax.every((p) => p.baja_en_orden === 3)).toBe(true);

    const p0 = pax[0]!;
    const paradas = m['paradas'] as Array<{ orden: number; punto: string }>;
    const nombreDe = (orden: number) => paradas.find((x) => x.orden === orden)!.punto;
    expect(p0.sube_en).toBe(nombreDe(0));
    expect(p0.baja_en).toBe(nombreDe(3));
    expect(p0.sube_en).not.toBe(p0.baja_en);
    expect(p0.estatus_pago).toBe('pendiente'); // el fixture no paga
    expect(p0).not.toHaveProperty('importe');
    expect(p0).not.toHaveProperty('saldo_pendiente');

    // Ya no hay agrupación por ascenso ni ocupación por tramo en el jsonb.
    expect(m).not.toHaveProperty('ascensos');
    expect(m).not.toHaveProperty('ocupacion_por_tramo');
  });

  it('las dos copias (conductor / terminal) llevan el mismo cuerpo de pasajeros', async () => {
    const { fx, usuarioId } = await prep();
    await vende(fx, usuarioId, 2, 0, 3);
    await vende(fx, usuarioId, 8, 1, 3);

    const t = await datosManifiesto(db, fx.salidaId, 'terminal');
    const c = await datosManifiesto(db, fx.salidaId, 'conductor');
    expect(pasajerosDe(c)).toEqual(pasajerosDe(t));
    expect(c['copia']).toBe('conductor');
    expect(t['copia']).toBe('terminal');
    for (const m of [t, c]) {
      expect(pasajerosDe(m).every((p) => !('importe' in p))).toBe(true);
      expect(m).not.toHaveProperty('ocupacion_por_tramo');
    }
  });

  it('marca el estatus de pago de cada pasajero', async () => {
    const { fx, usuarioId } = await prep();
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, corteId,
      asiento: 2, desde: 0, hasta: 3, estado: 'firme', pagar: true,
    });
    await vende(fx, usuarioId, 3, 0, 3); // sin pagar

    const m = await datosManifiesto(db, fx.salidaId, 'terminal');
    const porAsiento = new Map(pasajerosDe(m).map((x) => [x.asiento, x]));
    expect(porAsiento.get(2)!.estatus_pago).toBe('pagado');
    expect(porAsiento.get(3)!.estatus_pago).toBe('pendiente');
  });

  it('D10 · una transferencia sin verificar sale como "pendiente" y no bloquea el manifiesto', async () => {
    const { fx, usuarioId } = await prep();
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    // Pago por transferencia sin verificar: no cuenta al saldo (D10).
    const oc = await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, corteId,
      asiento: 2, desde: 0, hasta: 3, estado: 'firme',
    });
    await db.query(
      `INSERT INTO core.pago (id, venta_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                              metodo, monto, verificado, pagado_en)
       VALUES (core.uuid_v7(), $1, $2, $3, $4, 'transferencia', 450, false, now())`,
      [oc.ventaId, fx.sucursales[0]!, corteId, usuarioId],
    );

    const m = await datosManifiesto(db, fx.salidaId, 'terminal');
    expect(pasajerosDe(m).find((p) => p.asiento === 2)!.estatus_pago).toBe('pendiente');

    // El manifiesto se genera igual (no bloquea).
    const r = await generarManifiestos(db, { salidaId: fx.salidaId, usuarioId });
    expect(r.terminal.pasajeros).toBe(1);
  });

  it('los boletos en conflicto van marcados', async () => {
    const { fx, usuarioId } = await prep();
    const ok = await vende(fx, usuarioId, 2, 0, 3);
    const conf = await vende(fx, usuarioId, 3, 0, 3);
    await db.query(
      `UPDATE core.boleto SET estado = 'conflicto_sobreventa' WHERE id = $1`, [conf.boletoId],
    );

    const m = await datosManifiesto(db, fx.salidaId, 'terminal');
    const porAsiento = new Map(pasajerosDe(m).map((x) => [x.asiento, x]));
    expect(porAsiento.get(2)!.conflicto).toBe(false);
    expect(porAsiento.get(3)!.conflicto).toBe(true);
    expect(ok.boletoId).toBeDefined();
  });

  it('`generarManifiestos` encola los dos jobs con el conteo de pasajeros', async () => {
    const { fx, usuarioId } = await prep();
    await vende(fx, usuarioId, 2, 0, 3);
    await vende(fx, usuarioId, 8, 1, 3);

    // 0081: el del origen solo lleva a quien sube ahí (el asiento 2).
    const r = await generarManifiestos(db, { salidaId: fx.salidaId, usuarioId });
    expect(r.conductor.pasajeros).toBe(1);
    expect(r.terminal.pasajeros).toBe(1);

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

  it('cada terminal genera SU manifiesto, en su impresora, sin tocar el de las demás (0081)', async () => {
    const { fx, usuarioId } = await prep();
    await vende(fx, usuarioId, 2, 0, 3);
    await vende(fx, usuarioId, 8, 1, 3);
    await vende(fx, usuarioId, 9, 1, 2);

    const origen = await generarManifiestos(db, { salidaId: fx.salidaId, usuarioId });
    const inter = await generarManifiestos(db, {
      salidaId: fx.salidaId, usuarioId, sucursalId: fx.sucursales[1]!,
    });
    expect(inter.terminal.pasajeros).toBe(2);

    const { rows } = await db.query<{ id: string; sucursal_id: string; activo: boolean }>(
      `SELECT id, sucursal_id, activo FROM core.print_job
        WHERE template_key IN ('manifiesto_conductor', 'manifiesto_terminal')
          AND datos->>'salida_id' = $1`, [fx.salidaId],
    );
    expect(rows.filter((x) => x.activo)).toHaveLength(4);   // el del origen sigue vivo
    expect(rows.find((x) => x.id === inter.terminal.printJobId)!.sucursal_id).toBe(fx.sucursales[1]);
    expect(rows.find((x) => x.id === origen.terminal.printJobId)!.activo).toBe(true);

    const m = await datosManifiesto(db, fx.salidaId, 'terminal', undefined, fx.sucursales[1]!);
    expect(m['terminal_orden']).toBe(1);
    expect(pasajerosDe(m).map((p) => p.asiento)).toEqual([8, 9]);
  });

  it('el manifiesto del origen lleva el lugar de paso y lo que cobra el conductor (0081)', async () => {
    const { fx, usuarioId } = await prep();
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const { registrarVenta } = await import('../../src/ventas/venta.js');
    await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 4, nombre: 'Luis Gil', importe: 450 }],
      pago: { metodo: 'conductor', monto: 450, corteCajaId: corteId },
      lugarAbordaje: 'Gasolinera de Chila',
    });

    const m = await datosManifiesto(db, fx.salidaId, 'terminal', undefined, fx.sucursales[0]!);
    const p = pasajerosDe(m).find((x) => x.asiento === 4)!;
    expect(p['lugar_abordaje']).toBe('Gasolinera de Chila');
    expect(Number(p['cobrar'])).toBe(450);

    // En la intermedia no aparece.
    const mi = await datosManifiesto(db, fx.salidaId, 'terminal', undefined, fx.sucursales[1]!);
    expect(pasajerosDe(mi).find((x) => x.asiento === 4)).toBeUndefined();
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
