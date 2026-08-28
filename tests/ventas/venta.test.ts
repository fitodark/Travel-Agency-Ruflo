/**
 * Registro de venta / reservación y pagos (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §2
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F4, pasos 4-6)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { adquirirLease, leasesVivos } from '../../src/ventas/lease.js';
import {
  registrarPago, registrarVenta, saldoDeVenta, verificarTransferencia,
} from '../../src/ventas/venta.js';
import { antesDelCierre, crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('registro de venta (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  interface Ctx {
    salidaId: string; sucursales: string[]; usuarioId: string;
    corteId: string; ahora: Date; horarioId: string;
  }

  /** Salida a 20 días, corte abierto en el origen, usuario y reloj antes del cierre. */
  const preparar = async (paradas = 4): Promise<Ctx> => {
    const fx = await seedSalida(db, { paradas, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);
    return {
      salidaId: fx.salidaId, sucursales: fx.sucursales, usuarioId, corteId, ahora,
      horarioId: fx.horarioId,
    };
  };

  const dosPasajeros = [
    { asientoNum: 2, nombre: 'Ana Ruiz', importe: 450 },
    { asientoNum: 3, nombre: 'Beto Sosa', importe: 450 },
  ];

  // -------------------------------------------------------------------------
  it('venta pagada en efectivo: boletos con folio, ocupación firme, ticket encolado', async () => {
    const c = await preparar();
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: dosPasajeros,
      pago: { metodo: 'efectivo', monto: 900, corteCajaId: c.corteId },
      ahora: c.ahora,
    });

    expect(r.estado).toBe('liquidada');
    expect(r.importeTotal).toBe(900);
    expect(r.pagado).toBe(900);
    expect(r.saldoPendiente).toBe(0);
    expect(r.boletos).toHaveLength(2);
    expect(r.printJobs).toBe(2);
    expect(r.imprimible).toBe(true);

    const { rows: oc } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.asiento_ocupacion
        WHERE salida_id = $1 AND estado = 'firme'`, [c.salidaId],
    );
    expect(Number(oc[0]!.n)).toBe(2);

    const { rows: pj } = await db.query<{ n: string; folio: string }>(
      `SELECT count(*) AS n, min(datos->>'folio') AS folio FROM core.print_job
        WHERE template_key = 'boleto' AND boleto_id IN
          (SELECT id FROM core.boleto WHERE venta_id = $1)`, [r.ventaId],
    );
    expect(Number(pj[0]!.n)).toBe(2);
    expect(pj[0]!.folio, 'el snapshot lleva el folio').toMatch(/^.\w{5}$/);
  });

  it('los folios son distintos y llevan el prefijo de la sucursal', async () => {
    const c = await preparar();
    const { rows: cod } = await db.query<{ codigo: string }>(
      `SELECT codigo FROM core.sucursal WHERE id = $1`, [c.sucursales[0]],
    );
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: dosPasajeros,
      pago: { metodo: 'efectivo', monto: 900, corteCajaId: c.corteId },
      ahora: c.ahora,
    });
    const folios = r.boletos.map((b) => b.folio);
    expect(new Set(folios).size).toBe(2);
    expect(folios.every((f) => f.startsWith(cod[0]!.codigo))).toBe(true);
  });

  it('reservación sin pago: pendiente, sin ticket, pero el asiento SÍ queda firme', async () => {
    const c = await preparar();
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [dosPasajeros[0]!], esReservacion: true, ahora: c.ahora,
    });

    expect(r.estado).toBe('pendiente');
    expect(r.pagado).toBe(0);
    expect(r.saldoPendiente).toBe(450);
    expect(r.printJobs).toBe(0);
    expect(r.imprimible).toBe(false);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.asiento_ocupacion
        WHERE salida_id = $1 AND asiento_num = 2 AND estado = 'firme'`, [c.salidaId],
    );
    expect(Number(rows[0]!.n), 'la reservación aparta el asiento').toBe(1);
  });

  it('abono parcial: pendiente y sin ticket hasta liquidar', async () => {
    const c = await preparar();
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: dosPasajeros,
      pago: { metodo: 'efectivo', monto: 300, esAbono: true, corteCajaId: c.corteId },
      ahora: c.ahora,
    });
    expect(r.pagado).toBe(300);
    expect(r.saldoPendiente).toBe(600);
    expect(r.estado).toBe('pendiente');
    expect(r.printJobs).toBe(0);
  });

  it('transferencia: no cuenta al saldo hasta verificarla', async () => {
    const c = await preparar();
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: dosPasajeros,
      pago: { metodo: 'transferencia', monto: 900, referencia: 'REF-9', corteCajaId: c.corteId },
      ahora: c.ahora,
    });
    expect(r.pagado, 'una transferencia sin verificar no es dinero confirmado').toBe(0);
    expect(r.estado).toBe('pendiente');
    expect(r.printJobs).toBe(0);

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.pago WHERE venta_id = $1`, [r.ventaId],
    );
    const v = await verificarTransferencia(db, rows[0]!.id, c.usuarioId, c.ahora);
    expect(v.pagado).toBe(900);
    expect(v.liquidada).toBe(true);
    expect(v.printJobs).toBe(2);

    const saldo = await saldoDeVenta(db, r.ventaId);
    expect(saldo!.saldoPendiente).toBe(0);
  });

  it('solo quien registró la venta puede verificar la transferencia', async () => {
    const c = await preparar();
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [dosPasajeros[0]!],
      pago: { metodo: 'transferencia', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
    });
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.pago WHERE venta_id = $1`, [r.ventaId],
    );
    const otro = await crearUsuario(db);
    await expect(verificarTransferencia(db, rows[0]!.id, otro, c.ahora))
      .rejects.toThrow(/solo quien registró/i);
  });

  it('`registrarPago` liquida una reservación y encola sus tickets — cobro en otra sucursal (C5)', async () => {
    const c = await preparar();
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: dosPasajeros, esReservacion: true, ahora: c.ahora,
    });
    expect(r.estado).toBe('pendiente');

    // Se cobra en el destino: corte de esa sucursal.
    const cobradorId = await crearUsuario(db);
    const corteDestino = await seedCorte(db, c.sucursales[3]!, cobradorId);
    const p = await registrarPago(db, {
      ventaId: r.ventaId, sucursalCobroId: c.sucursales[3]!, usuarioId: cobradorId,
      metodo: 'efectivo', monto: 900, corteCajaId: corteDestino, ahora: c.ahora,
    });

    expect(p.liquidada).toBe(true);
    expect(p.saldoPendiente).toBe(0);
    expect(p.printJobs).toBe(2);

    const { rows: pago } = await db.query<{ cobro: string }>(
      `SELECT sucursal_cobro_id AS cobro FROM core.pago WHERE id = $1`, [p.pagoId],
    );
    expect(pago[0]!.cobro, 'el pago suma al corte de la sucursal que cobra').toBe(c.sucursales[3]);

    const { rows: venta } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.venta WHERE id = $1`, [r.ventaId],
    );
    expect(venta[0]!.estado).toBe('liquidada');
  });

  it('un pago sin corte de caja abierto lanza', async () => {
    const c = await preparar();
    const sinCorte = await crearUsuario(db);
    await expect(registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[1]!, usuarioId: sinCorte,
      contactoTelefono: '953 111 2222', origenOrden: 1, destinoOrden: 3,
      pasajeros: [{ asientoNum: 8, nombre: 'Cyn', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450 },
      ahora: c.ahora,
    })).rejects.toThrow(/no hay un corte de caja abierto/i);
  });

  // -------------------------------------------------------------------------
  // Reglas de asiento
  // -------------------------------------------------------------------------
  it('sin conexión no se puede vender un asiento fuera del cupo propio', async () => {
    const c = await preparar();
    await expect(registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 8, nombre: 'Cyn', importe: 450 }],  // 8 es de S2
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
      conConexion: false, ahora: c.ahora,
    })).rejects.toThrow(/no está en el cupo vigente/i);
  });

  it('sin conexión sí se vende un asiento del cupo propio', async () => {
    const c = await preparar();
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Dan', importe: 450 }],   // 5 es de S1
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
      conConexion: false, ahora: c.ahora,
    });
    expect(r.estado).toBe('liquidada');
  });

  it('con conexión y lease se vende un asiento de otra sucursal; el lease se consume', async () => {
    const c = await preparar();
    const lease = await adquirirLease(db, {
      salidaId: c.salidaId, asientoNum: 8, desde: 0, hasta: 3,
      sucursalId: c.sucursales[0]!, ahora: c.ahora,
    });
    expect(lease.estado).toBe('otorgado');

    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 8, nombre: 'Eva', importe: 450, leaseId: lease.leaseId! }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
    });
    expect(r.estado).toBe('liquidada');
    expect(await leasesVivos(db, c.salidaId, c.ahora), 'el lease quedó consumido').toEqual([]);
  });

  it('un lease de otra sucursal no autoriza la venta', async () => {
    const c = await preparar();
    const lease = await adquirirLease(db, {
      salidaId: c.salidaId, asientoNum: 8, desde: 0, hasta: 3,
      sucursalId: c.sucursales[1]!, ahora: c.ahora,
    });
    await expect(registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 8, nombre: 'Eva', importe: 450, leaseId: lease.leaseId! }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
    })).rejects.toThrow(/es de otra sucursal/i);
  });

  it('la doble venta del mismo asiento en tramos que solapan la revienta la constraint', async () => {
    const c = await preparar();
    const comun = {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      ahora: c.ahora,
    } as const;
    await registrarVenta(db, {
      ...comun, pasajeros: [{ asientoNum: 5, nombre: 'Uno', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
    });
    await expect(registrarVenta(db, {
      ...comun, pasajeros: [{ asientoNum: 5, nombre: 'Dos', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
    })).rejects.toThrow(/ya está vendido/i);
  });

  // -------------------------------------------------------------------------
  // Validaciones de entrada
  // -------------------------------------------------------------------------
  it('no se puede vender en una salida en ruta', async () => {
    const c = await preparar();
    await db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [c.salidaId]);
    await expect(registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [dosPasajeros[0]!], ahora: c.ahora,
    })).rejects.toThrow(/no se puede vender ni reservar/i);
  });

  it('el teléfono de contacto es obligatorio (S11)', async () => {
    const c = await preparar();
    await expect(registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '  ', origenOrden: 0, destinoOrden: 3,
      pasajeros: [dosPasajeros[0]!], ahora: c.ahora,
    })).rejects.toThrow(/teléfono de contacto/i);
  });

  it('pasada la hora de cierre de la parada de origen no se vende', async () => {
    const c = await preparar();
    const { rows } = await db.query<{ cierre: Date }>(
      `SELECT cierre_venta_en AS cierre FROM core.salida_parada
        WHERE salida_id = $1 AND orden = 0`, [c.salidaId],
    );
    await expect(registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [dosPasajeros[0]!],
      ahora: new Date(rows[0]!.cierre.getTime() + 60_000),
    })).rejects.toThrow(/ya cerró/i);
  });

  it('el importe total es la suma de los importes de los pasajeros', async () => {
    const c = await preparar();
    const r = await registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [
        { asientoNum: 2, nombre: 'A', importe: 450 },
        { asientoNum: 3, nombre: 'B', importe: 500 },
        { asientoNum: 4, nombre: 'C', importe: 480 },
      ],
      ahora: c.ahora,
    });
    expect(r.importeTotal).toBe(1430);
  });
});
