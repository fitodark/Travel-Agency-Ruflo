/**
 * Retro del equipo (4 nov): «Por entregar» con historial completo y un envío a
 * «en ruta» desde su detalle (0089).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  buscarEnvioPorFolio, despacharEnvio, entregarEnvio, recibirEnvio, registrarEnvio,
  type RegistrarEnvioArgs,
} from '../../src/paqueteria/envio.js';
import { historialEntregas } from '../../src/paqueteria/bandeja.js';
import { crearUsuario, seedCorte, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('paquetería · historial de entregas y en ruta por envío (PostgreSQL real)', () => {
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
    await seedCorte(db, fx.sucursales[0]!, usuarioId);
    await seedCorte(db, fx.sucursales[3]!, usuarioId);
    return { fx, usuarioId };
  };

  const envio = (
    fx: { salidaId: string; sucursales: string[] }, usuarioId: string,
    extra: Partial<RegistrarEnvioArgs> = {},
  ) => registrarEnvio(db, {
    salidaId: fx.salidaId, sucursalOrigenId: fx.sucursales[0]!, usuarioId,
    sucursalDestinoId: fx.sucursales[3]!,
    remitenteNombre: 'Rosa Pérez', remitenteTelefono: '953 111 2222',
    destinatarioNombre: 'Carlos López', destinatarioTelefono: '55 3333 4444',
    descripcion: 'Caja', bultos: 1, importe: 200, modalidad: 'pagado',
    pago: { metodo: 'efectivo' },
    ...extra,
  });

  const rechaza = async (f: () => Promise<unknown>, re: RegExp) => {
    await db.query('SAVEPOINT intento');
    await expect(f()).rejects.toThrow(re);
    await db.query('ROLLBACK TO SAVEPOINT intento');
  };

  it('un envío pasa a en ruta desde su origen, una sola vez', async () => {
    const { fx, usuarioId } = await prep();
    const a = await envio(fx, usuarioId);
    const b = await envio(fx, usuarioId);

    await rechaza(
      () => despacharEnvio(db, { envioId: a.envioId, sucursalId: fx.sucursales[3]!, usuarioId }),
      /terminal de origen/,
    );

    const r = await despacharEnvio(db, { envioId: a.envioId, sucursalId: fx.sucursales[0]!, usuarioId });
    expect(r.estado).toBe('en_ruta');
    // Solo ese: el otro del mismo viaje sigue registrado.
    expect((await buscarEnvioPorFolio(db, b.folio))!.estado).toBe('registrado');

    await rechaza(
      () => despacharEnvio(db, { envioId: a.envioId, sucursalId: fx.sucursales[0]!, usuarioId }),
      /ya está en_ruta/,
    );
  });

  it('no despacha un envío de una salida cancelada', async () => {
    const { fx, usuarioId } = await prep();
    const a = await envio(fx, usuarioId);
    await db.query(`UPDATE core.salida SET estado = 'cancelada' WHERE id = $1`, [fx.salidaId]);
    await rechaza(
      () => despacharEnvio(db, { envioId: a.envioId, sucursalId: fx.sucursales[0]!, usuarioId }),
      /salida del envío está cancelada/,
    );
  });

  it('el historial conserva los entregados: pendientes primero, filtros y paginado', async () => {
    const { fx, usuarioId } = await prep();
    const destino = fx.sucursales[3]!;
    const pendiente = await envio(fx, usuarioId, { remitenteNombre: 'Ana Ruiz', destinatarioNombre: 'Beto Sol' });
    const viejo = await envio(fx, usuarioId);
    const nuevo = await envio(fx, usuarioId, { destinatarioNombre: 'María Gómez' });
    const enCamino = await envio(fx, usuarioId);

    for (const e of [pendiente, viejo, nuevo]) {
      await recibirEnvio(db, { envioId: e.envioId, sucursalId: destino, usuarioId });
    }
    await entregarEnvio(db, {
      envioId: viejo.envioId, sucursalId: destino, usuarioId, nombreVerificado: true,
      ahora: new Date('2030-03-10T18:00:00Z'),
    });
    await entregarEnvio(db, {
      envioId: nuevo.envioId, sucursalId: destino, usuarioId, nombreVerificado: true,
      ahora: new Date('2030-03-12T18:00:00Z'),
    });

    const pag = { limite: 20, offset: 0 };
    const todos = await historialEntregas(db, destino, {}, pag);
    // El que aún no llega no está; el pendiente va primero; luego del más reciente al más viejo.
    expect(todos.filas.map((e) => e.folio)).toEqual([pendiente.folio, nuevo.folio, viejo.folio]);
    expect(todos.total).toBe(3);
    expect(todos.filas.map((e) => e.folio)).not.toContain(enCamino.folio);
    expect(todos.filas[0]!.entregadoEn).toBeNull();
    expect(todos.filas[1]!.entregadoEn).toEqual(new Date('2030-03-12T18:00:00Z'));
    expect(todos.filas[1]!.entregadoPor).toBeTruthy();

    const folios = async (f: Parameters<typeof historialEntregas>[2]) =>
      (await historialEntregas(db, destino, f, pag)).filas.map((e) => e.folio);

    expect(await folios({ vista: 'por_entregar' })).toEqual([pendiente.folio]);
    expect(await folios({ vista: 'entregados' })).toEqual([nuevo.folio, viejo.folio]);
    // Fecha de entrega en la zona de la sucursal (12:00 CST del 10 y del 12).
    expect(await folios({ entregaDesde: '2030-03-11', entregaHasta: '2030-03-12' })).toEqual([nuevo.folio]);
    expect(await folios({ remitente: 'ana r' })).toEqual([pendiente.folio]);
    expect(await folios({ destinatario: 'GÓMEZ' })).toEqual([nuevo.folio]);
    expect(await folios({ folio: viejo.folio.slice(-4) })).toContain(viejo.folio);
    // Un comodín escrito por el usuario se busca literal.
    expect(await folios({ remitente: '%' })).toEqual([]);

    const pagina2 = await historialEntregas(db, destino, {}, { limite: 2, offset: 2 });
    expect(pagina2.filas.map((e) => e.folio)).toEqual([viejo.folio]);
    expect(pagina2.total).toBe(3);
  });
});
