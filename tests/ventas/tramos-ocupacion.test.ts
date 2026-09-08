/**
 * Fase 2 de "paradas autorizadas" (migración 0050): el boleto guarda `tramos`
 * (viaje) y `tramos_ocupacion` (ocupación física). Un boleto a una parada de solo
 * descenso ocupa el asiento HASTA EL FIN DE LA RUTA — nadie asciende ahí para
 * recomprar el tramo.
 *
 * docs/architecture/05-paradas-autorizadas-tarifas.md §3 (Regla de tramos_ocupacion).
 *
 * NOTA: la materialización de `salida_parada` para paradas no-terminal es Fase 4.
 * Aquí se inserta a mano la fila de la parada de descenso para poder ejercer el
 * camino de venta completo.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { antesDelCierre, crearUsuario, seedCorte, seedSalida } from './fixture.js';

const run = process.env['LOCAL_DATABASE_URL'] ? describe : describe.skip;

run('tramos_ocupacion — ocupación del asiento (PostgreSQL real)', () => {
  let db: Client;
  beforeAll(async () => { db = new Client(resolveConnection('local').config); await db.connect(); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const rango = async (sql: string, params: unknown[]): Promise<string> =>
    (await db.query<{ r: string }>(sql, params)).rows[0]!.r;

  it('venta terminal→terminal: tramos_ocupacion == tramos, el tramo posterior queda revendible', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20, tarifaImporte: 100 });
    const usuarioId = await crearUsuario(db);
    await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);

    const v1 = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 1111', origenOrden: 0, destinoOrden: 1,
      pasajeros: [{ asientoNum: 5, nombre: 'Ana', importe: 100 }], ahora,
    });
    const b = v1.boletos[0]!.boletoId;
    expect(await rango(`SELECT tramos::text AS r FROM core.boleto WHERE id=$1`, [b])).toBe('[0,1)');
    expect(await rango(`SELECT tramos_ocupacion::text AS r FROM core.boleto WHERE id=$1`, [b])).toBe('[0,1)');

    // El mismo asiento, tramo [1,3): no solapa, se vende.
    const v2 = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 222 2222', origenOrden: 1, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Beto', importe: 100 }], ahora,
    });
    expect(v2.boletos).toHaveLength(1);
  });

  /** Convierte el `orden` en una parada de solo descenso y le materializa su fila. */
  const paradaDescenso = async (fx: Awaited<ReturnType<typeof seedSalida>>, orden: number): Promise<void> => {
    await db.query(
      `UPDATE core.punto_ruta SET tipo='parada', sucursal_id=NULL
         WHERE id = (SELECT punto_id FROM core.salida_parada WHERE salida_id=$1 AND orden=$2)`,
      [fx.salidaId, orden],
    );
    await db.query(
      `UPDATE core.ruta_parada rp SET permite_ascenso=false, permite_descenso=true
         FROM core.salida sa JOIN core.horario h ON h.id=sa.horario_id
        WHERE sa.id=$1 AND rp.ruta_id=h.ruta_id
          AND rp.punto_id=(SELECT punto_id FROM core.salida_parada WHERE salida_id=$1 AND orden=$2)`,
      [fx.salidaId, orden],
    );
    await db.query(
      `UPDATE core.salida_parada SET hora_paso_programada=NULL, cierre_venta_en=NULL
        WHERE salida_id=$1 AND orden=$2`,
      [fx.salidaId, orden],
    );
  };

  it('tramo_ocupacion: destino = parada de descenso ⇒ el rango llega a n-1', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20, tarifaImporte: 100 });
    await paradaDescenso(fx, 2);
    expect(await rango(`SELECT core.tramo_ocupacion($1, 0, 2)::text AS r`, [fx.salidaId])).toBe('[0,3)');
    // terminal→terminal no se toca
    expect(await rango(`SELECT core.tramo_ocupacion($1, 0, 1)::text AS r`, [fx.salidaId])).toBe('[0,1)');
  });

  /** Convierte el `orden` en una parada de solo ascenso (retorno) y le da su fila. */
  const paradaAscenso = async (fx: Awaited<ReturnType<typeof seedSalida>>, orden: number): Promise<void> => {
    await db.query(
      `UPDATE core.punto_ruta SET tipo='parada', sucursal_id=NULL
         WHERE id = (SELECT punto_id FROM core.salida_parada WHERE salida_id=$1 AND orden=$2)`,
      [fx.salidaId, orden],
    );
    await db.query(
      `UPDATE core.ruta_parada rp SET permite_ascenso=true, permite_descenso=false
         FROM core.salida sa JOIN core.horario h ON h.id=sa.horario_id
        WHERE sa.id=$1 AND rp.ruta_id=h.ruta_id
          AND rp.punto_id=(SELECT punto_id FROM core.salida_parada WHERE salida_id=$1 AND orden=$2)`,
      [fx.salidaId, orden],
    );
  };

  it('tramo_ocupacion: origen = parada de ascenso sin POS ⇒ el rango empieza en 0 (P-3 / D3)', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20, tarifaImporte: 100 });
    await paradaAscenso(fx, 1);
    // origen orden 1 = parada de ascenso ⇒ lower = 0; destino orden 3 = terminal
    expect(await rango(`SELECT core.tramo_ocupacion($1, 1, 3)::text AS r`, [fx.salidaId])).toBe('[0,3)');
    // origen terminal (orden 0) no se toca
    expect(await rango(`SELECT core.tramo_ocupacion($1, 0, 3)::text AS r`, [fx.salidaId])).toBe('[0,3)');
    expect(await rango(`SELECT core.tramo_ocupacion($1, 2, 3)::text AS r`, [fx.salidaId])).toBe('[2,3)');
  });

  it('venta a una parada de descenso: el asiento se ocupa hasta el fin de la ruta y no se revende aguas abajo', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20, tarifaImporte: 100 });
    await paradaDescenso(fx, 2);
    const usuarioId = await crearUsuario(db);
    await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);

    const v = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 333 3333', origenOrden: 0, destinoOrden: 2,
      pasajeros: [{ asientoNum: 7, nombre: 'Cata', importe: 100 }], ahora,
    });
    const b = v.boletos[0]!.boletoId;
    expect(await rango(`SELECT tramos::text AS r FROM core.boleto WHERE id=$1`, [b])).toBe('[0,2)');
    expect(await rango(`SELECT tramos_ocupacion::text AS r FROM core.boleto WHERE id=$1`, [b])).toBe('[0,3)');
    expect(await rango(`SELECT tramos_ocupacion::text AS r FROM core.asiento_ocupacion WHERE boleto_id=$1`, [b])).toBe('[0,3)');

    // El tramo aguas abajo del mismo asiento está tomado (la ocupación llega a
    // n-1): una venta terminal→terminal [1,3) sobre el mismo asiento la rechaza
    // la constraint.
    await expect(registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 444 4444', origenOrden: 1, destinoOrden: 3,
      pasajeros: [{ asientoNum: 7, nombre: 'Dani', importe: 100 }], ahora,
    })).rejects.toThrow(/tramo que solapa/i);
  });

  it('asientos_libres respeta tramos_ocupacion: el asiento no aparece libre para [2,3) tras un boleto a la parada de descenso', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20, tarifaImporte: 100 });
    await paradaDescenso(fx, 2);
    const usuarioId = await crearUsuario(db);
    await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);

    await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 555 5555', origenOrden: 0, destinoOrden: 2,
      pasajeros: [{ asientoNum: 9, nombre: 'Eva', importe: 100 }], ahora,
    });

    const libres = (await db.query<{ a: number[] }>(
      `SELECT core.asientos_libres($1, 2, 3) AS a`, [fx.salidaId],
    )).rows[0]!.a;
    expect(libres).not.toContain(9);
  });
});
