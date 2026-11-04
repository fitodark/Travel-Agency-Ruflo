/**
 * Fase E (0086) — paquetería: en ruta, recepción en destino, entrega y cobro.
 * docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P8, P9).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  buscarEnvioPorFolio, despacharEnvios, entregarEnvio, enviosParaMiSucursal, recibirEnvio,
  registrarEnvio, type RegistrarEnvioArgs,
} from '../../src/paqueteria/envio.js';
import { marcarEnRuta } from '../../src/fleet/abordaje.js';
import { saldoCorte } from '../../src/caja/corte.js';
import { crearUsuario, seedCorte, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('paquetería · en ruta, recepción y entrega (PostgreSQL real)', () => {
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
    const corteOrigen = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const corteDestino = await seedCorte(db, fx.sucursales[3]!, usuarioId);
    return { fx, usuarioId, corteOrigen, corteDestino };
  };

  const envio = (
    fx: { salidaId: string; sucursales: string[] }, usuarioId: string,
    extra: Partial<RegistrarEnvioArgs> = {},
  ) => registrarEnvio(db, {
    salidaId: fx.salidaId, sucursalOrigenId: fx.sucursales[0]!, usuarioId,
    sucursalDestinoId: fx.sucursales[3]!,
    remitenteNombre: 'Rosa Pérez', remitenteTelefono: '953 111 2222',
    destinatarioNombre: 'Carlos Pérez López', destinatarioTelefono: '55 3333 4444',
    descripcion: '2 cajas', bultos: 2, importe: 300, modalidad: 'por_cobrar',
    ...extra,
  });

  const estado = async (folio: string) => (await buscarEnvioPorFolio(db, folio))!;

  const rechaza = async (f: () => Promise<unknown>, re: RegExp) => {
    await db.query('SAVEPOINT intento');
    await expect(f()).rejects.toThrow(re);
    await db.query('ROLLBACK TO SAVEPOINT intento');
  };

  it('marcar en ruta despacha los envíos del origen; una intermedia despacha los suyos', async () => {
    const { fx, usuarioId } = await prep();
    const delOrigen = await envio(fx, usuarioId);
    const deIntermedia = await envio(fx, usuarioId, { sucursalOrigenId: fx.sucursales[1]! });

    await marcarEnRuta(db, { salidaId: fx.salidaId, usuarioId });
    expect((await estado(delOrigen.folio)).estado).toBe('en_ruta');
    expect((await estado(deIntermedia.folio)).estado).toBe('registrado');

    const d = await despacharEnvios(db, { salidaId: fx.salidaId, sucursalId: fx.sucursales[1]!, usuarioId });
    expect(d.despachados).toBe(1);
    expect((await estado(deIntermedia.folio)).estado).toBe('en_ruta');
  });

  it('solo el destino recibe; queda en sucursal con su cobro pendiente', async () => {
    const { fx, usuarioId } = await prep();
    const e = await envio(fx, usuarioId);
    await rechaza(() => recibirEnvio(db, { envioId: e.envioId, sucursalId: fx.sucursales[2]!, usuarioId }),
      /solo la sucursal destino/i);

    const r = await recibirEnvio(db, { envioId: e.envioId, sucursalId: fx.sucursales[3]!, usuarioId });
    expect(r).toMatchObject({ estado: 'en_sucursal', estadoPago: 'pendiente', porCobrar: 300 });

    const porEntregar = await enviosParaMiSucursal(db, fx.sucursales[3]!, ['en_sucursal']);
    expect(porEntregar.map((x) => x.folio)).toContain(e.folio);
  });

  it('entrega por cobrar: exige nombre verificado y el cobro completo, que entra al corte del destino', async () => {
    const { fx, usuarioId, corteDestino } = await prep();
    const e = await envio(fx, usuarioId);
    const base = { envioId: e.envioId, sucursalId: fx.sucursales[3]!, usuarioId };

    await rechaza(() => entregarEnvio(db, { ...base, nombreVerificado: true }), /primero regístralo/i);
    await recibirEnvio(db, base);
    await rechaza(() => entregarEnvio(db, { ...base, nombreVerificado: false }), /credencial de elector/i);
    await rechaza(() => entregarEnvio(db, { ...base, nombreVerificado: true }), /cobra \$300/i);

    const r = await entregarEnvio(db, {
      ...base, nombreVerificado: true,
      pago: { metodo: 'efectivo', efectivoRecibido: 500, corteCajaId: corteDestino },
    });
    expect(r).toMatchObject({ estado: 'entregado', estadoPago: 'pagado' });
    expect((await saldoCorte(db, corteDestino))!.ingresosEfectivo).toBe(300);

    // Se registra QUE se verificó, nunca un número de credencial.
    const { rows } = await db.query<{ detalle: Record<string, unknown> }>(
      `SELECT detalle FROM core.evento_envio WHERE envio_id = $1 AND tipo = 'entregado'`, [e.envioId],
    );
    expect(rows[0]!.detalle).toEqual({ entregado_a: 'Carlos Pérez López', verificado_contra: 'credencial_elector' });
  });

  it('por cobrar con transferencia: se entrega y queda por confirmar', async () => {
    const { fx, usuarioId, corteDestino } = await prep();
    const e = await envio(fx, usuarioId);
    const base = { envioId: e.envioId, sucursalId: fx.sucursales[3]!, usuarioId };
    await recibirEnvio(db, base);
    const r = await entregarEnvio(db, {
      ...base, nombreVerificado: true,
      pago: { metodo: 'transferencia', referencia: 'SPEI 9', corteCajaId: corteDestino },
    });
    expect(r).toMatchObject({ estado: 'entregado', estadoPago: 'por_confirmar' });
    expect((await saldoCorte(db, corteDestino))!.ingresos).toBe(0);
  });

  it('un envío ya pagado se entrega sin cobro (y rechaza un cobro de más)', async () => {
    const { fx, usuarioId, corteOrigen, corteDestino } = await prep();
    const e = await envio(fx, usuarioId, {
      modalidad: 'pagado', pago: { metodo: 'efectivo', corteCajaId: corteOrigen },
    });
    const base = { envioId: e.envioId, sucursalId: fx.sucursales[3]!, usuarioId };
    await recibirEnvio(db, base);
    await rechaza(() => entregarEnvio(db, {
      ...base, nombreVerificado: true, pago: { metodo: 'efectivo', corteCajaId: corteDestino },
    }), /ya está pagado/i);
    const r = await entregarEnvio(db, { ...base, nombreVerificado: true });
    expect(r.estado).toBe('entregado');
    await rechaza(() => recibirEnvio(db, base), /ya está entregado/i);
  });
});
