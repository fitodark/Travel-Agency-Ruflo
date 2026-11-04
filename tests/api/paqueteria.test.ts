/**
 * Rutas de paquetería (HTTP, contra PostgreSQL real): el cableado de la Fase G.
 * La lógica la cubren `tests/paqueteria/*`; aquí: sesión → sucursal/usuario,
 * forma de las respuestas y reglas de negocio → 422.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { abrirCorte } from '../../src/caja/corte.js';
import { antesDelCierre, crearUsuarioConAcceso, seedSalida } from '../ventas/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('API · /paqueteria (PostgreSQL real)', () => {
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

  /** Un 422 aborta la transacción compartida: cada rechazo esperado va en su savepoint. */
  const rechazada = async (peticion: InjectOptions): Promise<number> => {
    await db.query('SAVEPOINT intento');
    const r = await app.inject(peticion);
    await db.query('ROLLBACK TO SAVEPOINT intento');
    return r.statusCode;
  };

  const preparar = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const origen = await crearUsuarioConAcceso(db, fx.sucursales[0]!);
    const destino = await crearUsuarioConAcceso(db, fx.sucursales[3]!);
    await db.query(`UPDATE sync.nodo SET sucursal_id = $1 WHERE singleton`, [fx.sucursales[0]]);
    AHORA = await antesDelCierre(db, fx.salidaId, 0);
    app = await abrirApp(db, () => AHORA);
    const tOrigen = await tokenDe(db, origen.email, fx.sucursales[0]!, () => AHORA);
    const tDestino = await tokenDe(db, destino.email, fx.sucursales[3]!, () => AHORA);
    await abrirCorte(db, { sucursalId: fx.sucursales[0]!, usuarioId: origen.usuarioId, saldoInicial: 500, ahora: AHORA });
    await abrirCorte(db, { sucursalId: fx.sucursales[3]!, usuarioId: destino.usuarioId, saldoInicial: 500, ahora: AHORA });
    return { fx, tOrigen, tDestino };
  };

  it('registra en origen, se consulta por folio, se recibe y se entrega cobrando en destino', async () => {
    const { fx, tOrigen, tDestino } = await preparar();

    const salidas = await app.inject({
      method: 'GET', headers: bearer(tOrigen),
      url: `/paqueteria/salidas?fecha=${fx.fechaOperacion}&destinoId=${fx.sucursales[3]}`,
    });
    expect(salidas.statusCode).toBe(200);
    expect(salidas.json().find((s: { salidaId: string }) => s.salidaId === fx.salidaId)?.abierta).toBe(true);

    const crear = await app.inject({
      method: 'POST', url: '/paqueteria', headers: bearer(tOrigen),
      payload: {
        salidaId: fx.salidaId, sucursalDestinoId: fx.sucursales[3],
        remitenteNombre: 'Rosa Pérez', remitenteTelefono: '953 111 2222',
        destinatarioNombre: 'Carlos Pérez López', destinatarioTelefono: '55 3333 4444',
        descripcion: '3 cajas', bultos: 3, importe: 600, modalidad: 'por_cobrar',
      },
    });
    expect(crear.statusCode).toBe(201);
    const { envioId, folio, printJobs } = crear.json();
    expect(printJobs).toBe(4);

    const porFolio = await app.inject({ method: 'GET', url: `/paqueteria/folio?folio=${folio}`, headers: bearer(tDestino) });
    expect(porFolio.json()).toMatchObject({ estado: 'registrado', porCobrar: 600, bultos: 3 });

    const recibir = await app.inject({ method: 'POST', url: `/paqueteria/${envioId}/recibir`, headers: bearer(tDestino) });
    expect(recibir.statusCode).toBe(200);
    const bandeja = await app.inject({ method: 'GET', url: '/paqueteria/destino?estado=por_entregar', headers: bearer(tDestino) });
    expect(bandeja.json().map((e: { folio: string }) => e.folio)).toContain(folio);

    expect(await rechazada({
      method: 'POST', url: `/paqueteria/${envioId}/entregar`, headers: bearer(tDestino),
      payload: { nombreVerificado: false },
    })).toBe(422);

    const entregar = await app.inject({
      method: 'POST', url: `/paqueteria/${envioId}/entregar`, headers: bearer(tDestino),
      payload: { nombreVerificado: true, pago: { metodo: 'efectivo', efectivoRecibido: 1000 } },
    });
    expect(entregar.statusCode).toBe(200);
    expect(entregar.json()).toMatchObject({ estado: 'entregado', estadoPago: 'pagado' });
  });

  it('el origen no puede recibir ni el destino cancelar (422)', async () => {
    const { fx, tOrigen, tDestino } = await preparar();
    const crear = await app.inject({
      method: 'POST', url: '/paqueteria', headers: bearer(tOrigen),
      payload: {
        salidaId: fx.salidaId, sucursalDestinoId: fx.sucursales[3],
        remitenteNombre: 'Rosa', remitenteTelefono: '953', destinatarioNombre: 'Carlos',
        destinatarioTelefono: '55', descripcion: 'Sobre', bultos: 1, importe: 100,
        modalidad: 'pagado', pago: { metodo: 'transferencia', referencia: 'SPEI 1' },
      },
    });
    const { envioId } = crear.json();
    expect(await rechazada({ method: 'POST', url: `/paqueteria/${envioId}/recibir`, headers: bearer(tOrigen) })).toBe(422);
    expect(await rechazada({
      method: 'POST', url: `/paqueteria/${envioId}/cancelar`, headers: bearer(tDestino), payload: { motivo: 'x' },
    })).toBe(422);

    const cola = await app.inject({ method: 'GET', url: '/paqueteria/transferencias-por-verificar', headers: bearer(tOrigen) });
    expect(cola.json().map((t: { envioId: string }) => t.envioId)).toContain(envioId);
  });
});
