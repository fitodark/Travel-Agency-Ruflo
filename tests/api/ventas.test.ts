/**
 * Rutas del flujo de venta (HTTP, contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F4)
 *
 * La lógica de venta ya la cubre `tests/ventas/venta.test.ts` (17). Aquí se
 * verifica el CABLEADO HTTP: auth, sucursal/usuario desde la sesión, forma de la
 * respuesta y el mapeo de errores de regla de negocio a 422.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { abrirCorte } from '../../src/caja/corte.js';
import { antesDelCierre, crearUsuarioConAcceso, seedSalida } from '../ventas/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('API · /ventas (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;
  let AHORA: Date;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => {
    if (app) await app.close();
    await db.query('ROLLBACK');
  });

  const preparar = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const { usuarioId, email } = await crearUsuarioConAcceso(db, fx.sucursales[0]!);
    await db.query(`UPDATE sync.nodo SET sucursal_id = $1 WHERE singleton`, [fx.sucursales[0]]);

    AHORA = await antesDelCierre(db, fx.salidaId, 0);
    app = await abrirApp(db, () => AHORA);
    const token = await tokenDe(db, email, fx.sucursales[0]!, () => AHORA);
    const corteId = await abrirCorte(db, {
      sucursalId: fx.sucursales[0]!, usuarioId, saldoInicial: 500, ahora: AHORA,
    });
    return { fx, token, corteId, usuarioId };
  };

  // -------------------------------------------------------------------------
  it('GET /ventas/salidas devuelve las salidas del tramo con disponibilidad', async () => {
    const { fx, token } = await preparar();
    const r = await app.inject({
      method: 'GET',
      url: `/ventas/salidas?fecha=${fx.fechaOperacion}&origen=${fx.sucursales[0]}`
        + `&destino=${fx.sucursales[3]}&personas=2`,
      headers: bearer(token),
    });
    expect(r.statusCode).toBe(200);
    const salidas = r.json();
    const mia = salidas.find((s: { salidaId: string }) => s.salidaId === fx.salidaId);
    expect(mia).toBeDefined();
    expect(mia.origenOrden).toBe(0);
    expect(mia.destinoOrden).toBe(3);
    expect(mia.seleccionable).toBe(true);
    expect(mia.asientosOfrecibles.length).toBeGreaterThanOrEqual(2);
  });

  it('POST /ventas registra una venta pagada y GET /ventas/:id devuelve saldo y boletos', async () => {
    const { fx, token, corteId } = await preparar();
    const crear = await app.inject({
      method: 'POST', url: '/ventas', headers: bearer(token),
      payload: {
        salidaId: fx.salidaId, origenOrden: 0, destinoOrden: 3,
        contactoTelefono: '953 111 2222',
        pasajeros: [
          { asientoNum: 2, nombre: 'Ana Ruiz', importe: 450 },
          { asientoNum: 3, nombre: 'Beto Sosa', importe: 450 },
        ],
        pago: { metodo: 'efectivo', monto: 900, corteCajaId: corteId },
      },
    });
    expect(crear.statusCode).toBe(201);
    const venta = crear.json();
    expect(venta.estado).toBe('liquidada');
    expect(venta.saldoPendiente).toBe(0);
    expect(venta.boletos).toHaveLength(2);
    expect(venta.printJobs).toBe(2);

    const detalle = await app.inject({
      method: 'GET', url: `/ventas/${venta.ventaId}`, headers: bearer(token),
    });
    expect(detalle.statusCode).toBe(200);
    const d = detalle.json();
    expect(d.saldoPendiente).toBe(0);
    expect(d.boletos).toHaveLength(2);
    expect(d.boletos[0].folio).toMatch(/^.\w{5}$/);
  });

  it('una reservación sin pago queda pendiente y luego se liquida por /pagos', async () => {
    const { fx, token, corteId } = await preparar();
    const crear = await app.inject({
      method: 'POST', url: '/ventas', headers: bearer(token),
      payload: {
        salidaId: fx.salidaId, origenOrden: 0, destinoOrden: 3,
        contactoTelefono: '953 111 2222', esReservacion: true,
        pasajeros: [{ asientoNum: 5, nombre: 'Cyn', importe: 450 }],
      },
    });
    expect(crear.statusCode).toBe(201);
    const venta = crear.json();
    expect(venta.estado).toBe('pendiente');
    expect(venta.printJobs).toBe(0);

    const pago = await app.inject({
      method: 'POST', url: `/ventas/${venta.ventaId}/pagos`, headers: bearer(token),
      payload: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
    });
    expect(pago.statusCode).toBe(200);
    const p = pago.json();
    expect(p.liquidada).toBe(true);
    expect(p.printJobs).toBe(1);
  });

  it('un error de regla de negocio se mapea a 422 con el mensaje', async () => {
    const { fx, token, corteId } = await preparar();
    await db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [fx.salidaId]);

    const r = await app.inject({
      method: 'POST', url: '/ventas', headers: bearer(token),
      payload: {
        salidaId: fx.salidaId, origenOrden: 0, destinoOrden: 3,
        contactoTelefono: '953 111 2222',
        pasajeros: [{ asientoNum: 2, nombre: 'Tarde', importe: 450 }],
        pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('regla_negocio');
    expect(r.json().mensaje).toMatch(/no se puede vender ni reservar/i);
  });

  it('POST /ventas exige sesión', async () => {
    await preparar();
    const r = await app.inject({
      method: 'POST', url: '/ventas',
      payload: { salidaId: '00000000-0000-7000-8000-000000000000', origenOrden: 0, destinoOrden: 1, contactoTelefono: 'x', pasajeros: [{ asientoNum: 1, nombre: 'x', importe: 0 }] },
    });
    expect(r.statusCode).toBe(401);
  });

  it('POST /ventas/lease concede o rechaza como dato, no como error', async () => {
    const { fx, token } = await preparar();
    const r = await app.inject({
      method: 'POST', url: '/ventas/lease', headers: bearer(token),
      payload: { salidaId: fx.salidaId, asientoNum: 8, desde: 0, hasta: 3 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().estado).toBe('otorgado');
    expect(r.json().leaseId).toBeTruthy();
  });
});
