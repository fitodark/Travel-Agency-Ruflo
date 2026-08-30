/**
 * Rutas de viajes efectuados (HTTP, contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
 *
 * La lógica de F7 ya la cubren `tests/fleet/`. Aquí, el cableado HTTP: sesión →
 * sucursal/usuario, permisos, y el mapeo de las reglas de negocio a 422.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { seedSalida, sembrarOcupacion, crearUsuarioConAcceso } from '../ventas/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-15T09:00:00.000Z');
const ahora = (): Date => AHORA;

run('API · /viajes (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    app = await abrirApp(db, ahora);
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  const prep = async (rol = 'vendedor') => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const suc = fx.sucursales[0]!;
    // El nodo "es" esta sucursal: su `sync.salud` está vacío y el login no la ve
    // degradada (mismo motivo que en los fixtures de auth/caja).
    await db.query(`UPDATE sync.nodo SET sucursal_id = $1::uuid WHERE singleton`, [suc]);
    const { usuarioId, email } = await crearUsuarioConAcceso(db, suc, rol);
    const b1 = await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: suc, usuarioId, asiento: 2, desde: 0, hasta: 3,
    });
    const b2 = await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: suc, usuarioId, asiento: 3, desde: 0, hasta: 3,
    });
    const token = await tokenDe(db, email, suc, ahora);
    return { fx, suc, token, b1, b2 };
  };

  const url = (p: string): string => `/viajes${p}`;

  // -------------------------------------------------------------------------
  it('GET /viajes exige sesión', async () => {
    const r = await app.inject({ method: 'GET', url: url('?fecha=2026-09-15') });
    expect(r.statusCode).toBe(401);
  });

  it('GET /viajes lista las salidas del día de mi sucursal con su conteo de boletos', async () => {
    const { fx, token } = await prep();
    const r = await app.inject({
      method: 'GET', url: url(`?fecha=${fx.fechaOperacion}`), headers: bearer(token),
    });
    expect(r.statusCode).toBe(200);
    const mia = r.json().find((s: { salidaId: string }) => s.salidaId === fx.salidaId);
    expect(mia).toBeDefined();
    expect(mia.boletos).toBe(2);
    expect(mia.estado).toBe('programada');
  });

  it('GET /viajes/:id/checklist arranca todo en `pendiente` y refleja la captura', async () => {
    const { fx, token, b1 } = await prep();

    const antes = await app.inject({
      method: 'GET', url: url(`/${fx.salidaId}/checklist`), headers: bearer(token),
    });
    expect(antes.json()).toHaveLength(2);
    expect(antes.json().every((f: { estadoAbordaje: string }) => f.estadoAbordaje === 'pendiente'))
      .toBe(true);

    const cap = await app.inject({
      method: 'POST', url: url('/abordaje'), headers: bearer(token),
      payload: { boletoId: b1.boletoId, abordo: true },
    });
    expect(cap.statusCode).toBe(201);

    const despues = await app.inject({
      method: 'GET', url: url(`/${fx.salidaId}/checklist`), headers: bearer(token),
    });
    const fila = despues.json().find((f: { boletoId: string }) => f.boletoId === b1.boletoId);
    expect(fila.estadoAbordaje).toBe('abordo');
  });

  it('POST /viajes/:id/manifiestos encola las dos copias', async () => {
    const { fx, token } = await prep();
    const r = await app.inject({
      method: 'POST', url: url(`/${fx.salidaId}/manifiestos`), headers: bearer(token),
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().conductor.printJobId).toEqual(expect.any(String));
    expect(r.json().terminal.pasajeros).toBe(2);

    const jobs = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.print_job
        WHERE datos->>'salida_id' = $1 AND template_key LIKE 'manifiesto_%' AND activo`,
      [fx.salidaId],
    );
    expect(Number(jobs.rows[0]!.n)).toBe(2);
  });

  it('en ruta → finalizar cambia el estado de la salida', async () => {
    const { fx, token } = await prep();

    const enRuta = await app.inject({
      method: 'POST', url: url(`/${fx.salidaId}/en-ruta`), headers: bearer(token),
      payload: {},
    });
    expect(enRuta.statusCode).toBe(200);
    expect(enRuta.json().estado).toBe('en_ruta');

    const fin = await app.inject({
      method: 'POST', url: url(`/${fx.salidaId}/finalizar`), headers: bearer(token),
    });
    expect(fin.json().estado).toBe('finalizada');
  });

  it('finalizar una salida que no está en ruta → 422 regla de negocio', async () => {
    const { fx, token } = await prep();
    const r = await app.inject({
      method: 'POST', url: url(`/${fx.salidaId}/finalizar`), headers: bearer(token),
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().mensaje).toMatch(/en ruta/i);
  });

  it('capturar abordaje sobre un boleto inexistente → 422', async () => {
    const { token } = await prep();
    const r = await app.inject({
      method: 'POST', url: url('/abordaje'), headers: bearer(token),
      payload: { boletoId: '00000000-0000-7000-8000-000000000000', abordo: true },
    });
    expect(r.statusCode).toBe(422);
  });

  it('GET /viajes/boleto busca por folio (string, case-insensitive) y trae el viaje', async () => {
    const { fx, token, b1 } = await prep();
    const { rows } = await db.query<{ folio: string }>(
      `SELECT folio FROM core.boleto WHERE id = $1`, [b1.boletoId],
    );
    const folio = rows[0]!.folio.trim();

    const r = await app.inject({
      method: 'GET', url: url(`/boleto?folio=${folio.toLowerCase()}`), headers: bearer(token),
    });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.folio).toBe(folio);
    expect(b.boletoId).toBe(b1.boletoId);
    expect(b.salida.salidaId).toBe(fx.salidaId);
    expect(b.salida.origen).toBeTruthy();
    expect(b.salida.destino).toBeTruthy();
    expect(b.estadoAbordaje).toBe('pendiente');
  });

  it('GET /viajes/boleto con un folio que no existe → 404', async () => {
    const { token } = await prep();
    for (const folio of ['ZZ9999', 'ZZ999' /* longitud inválida */]) {
      const r = await app.inject({
        method: 'GET', url: url(`/boleto?folio=${folio}`), headers: bearer(token),
      });
      expect(r.statusCode, folio).toBe(404);
    }
  });
});
