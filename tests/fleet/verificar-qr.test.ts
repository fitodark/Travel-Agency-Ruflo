/**
 * Verificación del QR del boleto (03 §2.4): valida el HMAC contra el secreto de
 * la agencia y cruza el folio con la base local. Todo offline.
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { registrarAbordaje, verificarBoletoQr } from '../../src/fleet/abordaje.js';
import { buildQrText } from '../../src/printing/qr-text.js';
import { antesDelCierre, crearUsuario, seedCorte, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const KEY = 'secreto-de-prueba-hmac-qr-donaji';

run('verificación del QR del boleto (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  /** Salida hoy + un boleto pagado, con `config_ticket` que trae el secreto HMAC. */
  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 3, diasAdelante: 1 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);

    const { rows: ag } = await db.query<{ agencia_id: string }>(
      `SELECT agencia_id FROM core.sucursal WHERE id = $1`, [fx.sucursales[0]!],
    );
    await db.query(
      `INSERT INTO core.config_ticket (agencia_id, hmac_qr_secreto) VALUES ($1, $2)`,
      [ag[0]!.agencia_id, KEY],
    );

    const v = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2,
      pasajeros: [{ asientoNum: 4, nombre: 'Doña Rosa', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      ahora,
    });
    const b = v.boletos[0]!;

    const qr = (opts: { folio?: string; asiento?: number } = {}) => buildQrText({
      folio: opts.folio ?? b.folio,
      pasajero: 'DOÑA ROSA',
      asiento: opts.asiento ?? b.asientoNum,
      origen: fx.sucursales[0]!, destino: fx.sucursales[2]!,
      fechaHora: '2026-09-10 08:00', unidad: 'SPRINTER 1', importe: '450.00',
    }, { key: KEY });

    return { fx, usuarioId, b, ahora, qr };
  };

  it('QR bien firmado + boleto vigente hoy ⇒ veredicto ok', async () => {
    const { b, ahora, qr } = await prep();
    const r = await verificarBoletoQr(db, { qr: qr(), sucursalId: (await db.query<{ id: string }>(
      `SELECT sucursal_venta_id AS id FROM core.venta v JOIN core.boleto bo ON bo.venta_id = v.id WHERE bo.id = $1`,
      [b.boletoId])).rows[0]!.id, ahora });

    expect(r.firma).toBe('valida');
    expect(r.coincide).toBe(true);
    expect(r.veredicto).toBe('ok');
    expect(r.boleto?.folio).toBe(b.folio);
    expect(r.boleto?.salida.esHoy).toBe(true);
  });

  it('firma alterada ⇒ rechazar', async () => {
    const { fx, ahora, qr } = await prep();
    const roto = qr().slice(0, -1) + (qr().slice(-1) === 'A' ? 'B' : 'A');
    const r = await verificarBoletoQr(db, { qr: roto, sucursalId: fx.sucursales[0]!, ahora });
    expect(r.firma).toBe('invalida');
    expect(r.veredicto).toBe('rechazar');
  });

  it('QR sin campo de firma ⇒ revisar, firma sin_firma', async () => {
    const { fx, b, ahora } = await prep();
    const sinFirma = buildQrText({
      folio: b.folio, pasajero: 'X', asiento: b.asientoNum,
      origen: 'A', destino: 'B', fechaHora: '2026-09-10 08:00', unidad: 'U', importe: '450.00',
    }, { includeHmac: false });
    const r = await verificarBoletoQr(db, { qr: sinFirma, sucursalId: fx.sucursales[0]!, ahora });
    expect(r.firma).toBe('sin_firma');
    expect(r.veredicto).toBe('revisar');
    expect(r.boleto?.folio).toBe(b.folio);
  });

  it('boleto cancelado ⇒ rechazar', async () => {
    const { fx, b, ahora, qr } = await prep();
    await db.query(`UPDATE core.boleto SET estado = 'cancelado' WHERE id = $1`, [b.boletoId]);
    const r = await verificarBoletoQr(db, { qr: qr(), sucursalId: fx.sucursales[0]!, ahora });
    expect(r.firma).toBe('valida');
    expect(r.veredicto).toBe('rechazar');
    expect(r.nota).toMatch(/cancelado/i);
  });

  it('boleto que ya abordó ⇒ revisar', async () => {
    const { fx, b, usuarioId, ahora, qr } = await prep();
    await registrarAbordaje(db, {
      boletoId: b.boletoId, abordo: true, usuarioId, sucursalId: fx.sucursales[0]!, ahora,
    });
    const r = await verificarBoletoQr(db, { qr: qr(), sucursalId: fx.sucursales[0]!, ahora });
    expect(r.veredicto).toBe('revisar');
    expect(r.nota).toMatch(/a bordo/i);
  });

  it('folio que no está en esta terminal ⇒ revisar, boleto null', async () => {
    const { fx, ahora, qr } = await prep();
    const r = await verificarBoletoQr(db, {
      qr: qr({ folio: 'ZZ9999' }), sucursalId: fx.sucursales[0]!, ahora,
    });
    expect(r.boleto).toBeNull();
    expect(r.veredicto).toBe('revisar');
  });

  it('QR con asiento que no coincide con el boleto ⇒ revisar', async () => {
    const { fx, ahora, qr } = await prep();
    const r = await verificarBoletoQr(db, {
      qr: qr({ asiento: 17 }), sucursalId: fx.sucursales[0]!, ahora,
    });
    expect(r.firma).toBe('valida');
    expect(r.coincide).toBe(false);
    expect(r.veredicto).toBe('revisar');
  });
});
