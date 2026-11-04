/**
 * Fase A (0079/0080) — abordaje en lugar de paso + cobro por conductor.
 * docs/architecture/06-lugar-paso-paqueteria.md §1.1 (L1..L7).
 *
 *   - lugar de paso en texto libre, guardado en la venta;
 *   - `conductor`: saldada, efectivo en el corte de quien reserva, SIN imprimir;
 *   - pago completo en taquilla con lugar de paso ⇒ boleto normal (imprime);
 *   - sin pago / abono / conductor sin lugar ⇒ rechazo;
 *   - no-show: se cancela aun en ruta, con devolución en el corte que cobró.
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { cancelarBoleto } from '../../src/fleet/abordaje.js';
import { saldoCorte } from '../../src/caja/corte.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('lugar de paso + cobro por conductor (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    return { fx, usuarioId, corteId };
  };

  const base = (fx: { salidaId: string; sucursales: string[] }, usuarioId: string) => ({
    salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
    contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
  });

  const LUGAR = 'Gasolinera de Chila de las Flores';

  /** Un rechazo aborta la transacción: cada intento va en su propio savepoint. */
  const rechaza = async (f: () => Promise<unknown>, re: RegExp) => {
    await db.query('SAVEPOINT intento');
    await expect(f()).rejects.toThrow(re);
    await db.query('ROLLBACK TO SAVEPOINT intento');
  };

  it('conductor: saldada, efectivo en el corte de quien reserva, sin imprimir', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarVenta(db, {
      ...base(fx, usuarioId),
      pasajeros: [{ asientoNum: 2, nombre: 'Ana Ruiz', importe: 450 },
                  { asientoNum: 3, nombre: 'Beto Sosa', importe: 450 }],
      pago: { metodo: 'conductor', monto: 900, corteCajaId: corteId },
      lugarAbordaje: `  ${LUGAR}  `,
    });
    expect(r.estado).toBe('liquidada');
    expect(r.saldoPendiente).toBe(0);
    expect(r.printJobs).toBe(0);
    expect(r.imprimible).toBe(false);

    const { rows: v } = await db.query<{ lugar_abordaje: string; es_reservacion: boolean }>(
      `SELECT lugar_abordaje, es_reservacion FROM core.venta WHERE id = $1`, [r.ventaId],
    );
    expect(v[0]).toEqual({ lugar_abordaje: LUGAR, es_reservacion: true });

    const { rows: pj } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.print_job pj JOIN core.boleto b ON b.id = pj.boleto_id
        WHERE b.venta_id = $1`, [r.ventaId],
    );
    expect(Number(pj[0]!.n)).toBe(0);

    const saldo = await saldoCorte(db, corteId);
    expect(saldo!.ingresosEfectivo).toBe(900);
    expect(saldo!.efectivoCalculado).toBe(saldo!.saldoInicial + 900);
  });

  it('pago completo en taquilla con lugar de paso: boleto normal que se imprime', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarVenta(db, {
      ...base(fx, usuarioId),
      pasajeros: [{ asientoNum: 4, nombre: 'Carla Paz', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      lugarAbordaje: LUGAR,
    });
    expect(r.estado).toBe('liquidada');
    expect(r.printJobs).toBe(1);
    const { rows: v } = await db.query<{ es_reservacion: boolean }>(
      `SELECT es_reservacion FROM core.venta WHERE id = $1`, [r.ventaId],
    );
    expect(v[0]!.es_reservacion).toBe(false);
  });

  it('lugar de paso sin pago o con abono parcial se rechaza', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const pasajeros = [{ asientoNum: 5, nombre: 'Dora Gil', importe: 450 }];
    await rechaza(() => registrarVenta(db, { ...base(fx, usuarioId), pasajeros, lugarAbordaje: LUGAR }), /lugar de paso se paga completa/i);
    await rechaza(() => registrarVenta(db, {
      ...base(fx, usuarioId), pasajeros, lugarAbordaje: LUGAR,
      pago: { metodo: 'efectivo', monto: 100, esAbono: true, corteCajaId: corteId },
    }), /lugar de paso se paga completa/i);
  });

  it('conductor sin lugar de paso o por menos del total se rechaza', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const pasajeros = [{ asientoNum: 6, nombre: 'Eva Luna', importe: 450 }];
    await rechaza(() => registrarVenta(db, {
      ...base(fx, usuarioId), pasajeros,
      pago: { metodo: 'conductor', monto: 450, corteCajaId: corteId },
    }), /solo aplica cuando el pasajero aborda en un lugar de paso/i);
    await rechaza(() => registrarVenta(db, {
      ...base(fx, usuarioId), pasajeros, lugarAbordaje: LUGAR,
      pago: { metodo: 'conductor', monto: 200, corteCajaId: corteId },
    }), /cubre el total/i);
  });

  it('un lugar de paso de más de 80 caracteres se rechaza', async () => {
    const { fx, usuarioId, corteId } = await prep();
    await rechaza(() => registrarVenta(db, {
      ...base(fx, usuarioId),
      pasajeros: [{ asientoNum: 7, nombre: 'Fer Mora', importe: 450 }],
      pago: { metodo: 'conductor', monto: 450, corteCajaId: corteId },
      lugarAbordaje: 'x'.repeat(81),
    }), /80 caracteres/i);
  });

  it('no-show: se cancela con la salida en ruta y la devolución sale del corte', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarVenta(db, {
      ...base(fx, usuarioId),
      pasajeros: [{ asientoNum: 8, nombre: 'Gil Rey', importe: 450 }],
      pago: { metodo: 'conductor', monto: 450, corteCajaId: corteId },
      lugarAbordaje: LUGAR,
    });

    const { rows: h } = await db.query<{ hora: Date }>(
      `SELECT hora_paso_programada AS hora FROM core.salida_parada
        WHERE salida_id = $1 AND orden = 0`, [fx.salidaId],
    );
    await db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [fx.salidaId]);
    const enRuta = new Date(h[0]!.hora.getTime() + 30 * 60_000);

    const c = await cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
      motivo: 'no se presentó en el lugar de paso', ahora: enRuta,
    });
    expect(c.ventaCancelada).toBe(true);
    expect(c.reembolsoMonto).toBe(450);

    const saldo = await saldoCorte(db, corteId);
    expect(saldo!.efectivoCalculado).toBe(saldo!.saldoInicial);   // +450 − 450

    const { rows: o } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.asiento_ocupacion WHERE boleto_id = $1`, [r.boletos[0]!.boletoId],
    );
    expect(o[0]!.estado).toBe('liberado');
  });

  it('no-show con la salida finalizada ya no se puede cancelar', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarVenta(db, {
      ...base(fx, usuarioId),
      pasajeros: [{ asientoNum: 9, nombre: 'Hugo Paz', importe: 450 }],
      pago: { metodo: 'conductor', monto: 450, corteCajaId: corteId },
      lugarAbordaje: LUGAR,
    });
    await db.query(`UPDATE core.salida SET estado = 'finalizada' WHERE id = $1`, [fx.salidaId]);
    await expect(cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
    })).rejects.toThrow(/finalizada/i);
  });

  it('una venta normal sigue respetando la ventana de 1 h', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarVenta(db, {
      ...base(fx, usuarioId),
      pasajeros: [{ asientoNum: 10, nombre: 'Iris Sol', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
    });
    const { rows: h } = await db.query<{ hora: Date }>(
      `SELECT hora_paso_programada AS hora FROM core.salida_parada
        WHERE salida_id = $1 AND orden = 0`, [fx.salidaId],
    );
    await expect(cancelarBoleto(db, {
      boletoId: r.boletos[0]!.boletoId, usuarioId, sucursalId: fx.sucursales[0]!,
      ahora: new Date(h[0]!.hora.getTime() - 30 * 60_000),
    })).rejects.toThrow(/1 h/i);
  });
});
