/**
 * Réplica de bajada transaccional (0083).
 * docs/architecture/06-lugar-paso-paqueteria.md §2 (Fase B2)
 *
 *   - la nube publica venta/boleto/pago a las terminales de la salida, menos
 *     a la que la escribió, aunque la fila llegue replicada;
 *   - el nodo NO vuelve a subir lo que bajó (guarda de outbox);
 *   - el pull solo trae lo dirigido a su sucursal (+ la configuración).
 *
 * Contra PostgreSQL real: la base local en transacción revertida (con
 * `donaji.forzar_nube` para hacerla publicar) y, para el pull, una nube y un
 * nodo desechables del banco de caos.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { pull } from '../../src/sync/pull.js';
import { crearUsuario, seedCorte, seedSalida } from '../ventas/fixture.js';
import { abrirAdmin, construirIds, crearNodo, hayLocal, soltarNodo } from './harness.js';

const run = hayLocal ? describe : describe.skip;

run('réplica de bajada · publicación en la nube (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const dePublicadas = async (tabla: string, filaId: string) => (await db.query<{ destinatarios: string[] }>(
    `SELECT destinatarios FROM sync.cambio_log WHERE tabla = $1 AND fila_id = $2`, [tabla, filaId],
  )).rows;

  it('venta, boletos y pago bajan a las terminales de la salida, no a la que escribió', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);

    // La fila "la escribió" la sucursal de origen: así lo verá la nube al ingerirla.
    await db.query(`SET LOCAL donaji.forzar_nube = 'on'`);
    const r = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 2, nombre: 'Ana Ruiz', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
    });

    const v = await dePublicadas('core.venta', r.ventaId);
    expect(v.length).toBeGreaterThan(0);
    const dest = new Set(v.at(-1)!.destinatarios);
    for (const s of fx.sucursales.slice(1)) expect(dest.has(s)).toBe(true);

    expect((await dePublicadas('core.boleto', r.boletos[0]!.boletoId)).length).toBeGreaterThan(0);
    const { rows: p } = await db.query<{ id: string }>(
      `SELECT id FROM core.pago WHERE venta_id = $1`, [r.ventaId],
    );
    expect((await dePublicadas('core.pago', p[0]!.id)).length).toBeGreaterThan(0);
  });

  it('una fila que llega replicada de una terminal SÍ se publica, sin devolvérsela a su dueña', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    await db.query(`SET LOCAL donaji.forzar_nube = 'on'`);

    const id = '019caa5f-0000-7000-8000-0c0000000001';
    const payload = {
      id, sucursal_venta_id: fx.sucursales[1], usuario_id: usuarioId,
      contacto_telefono: '953 000 0000', salida_id: fx.salidaId,
      parada_origen_orden: 1, parada_destino_orden: 3, importe_total: 450, estado: 'pendiente',
      es_reservacion: true, sync_sucursal_id: fx.sucursales[1],
      hlc_ts: new Date().toISOString(), hlc_cnt: 0, version: 1,
    };
    const { rows } = await db.query<{ estado: string }>(
      `SELECT estado FROM sync.ingest_fila('core.venta', $1, $2::jsonb)`, [id, JSON.stringify(payload)],
    );
    expect(rows[0]!.estado).toBe('aceptada');

    const pub = await dePublicadas('core.venta', id);
    expect(pub).toHaveLength(1);
    expect(pub[0]!.destinatarios).not.toContain(fx.sucursales[1]);
    expect(pub[0]!.destinatarios).toContain(fx.sucursales[0]);
  });

  it('el nodo no vuelve a subir lo que bajó (outbox)', async () => {
    const id = '019caa5f-0000-7000-8000-0c0000000002';
    const payload = {
      id, nombre: 'Cliente de otra terminal', telefono: '953 999 0000',
      sync_sucursal_id: '019caa5f-0000-7000-8000-0c0000000099',
      hlc_ts: new Date().toISOString(), hlc_cnt: 0, version: 1,
    };
    await db.query(`SELECT * FROM sync.ingest_fila('core.cliente', $1, $2::jsonb)`, [id, JSON.stringify(payload)]);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.outbox WHERE fila_id = $1`, [id],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('lo escrito localmente sí sube (la guarda no tapa el caso normal)', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO core.cliente (nombre, telefono) VALUES ('Cliente local', '953 111 0000') RETURNING id`,
    );
    const { rows: o } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.outbox WHERE fila_id = $1`, [rows[0]!.id],
    );
    expect(Number(o[0]!.n)).toBe(1);
  });
});

run('réplica de bajada · el pull filtra por sucursal (nodos desechables)', () => {
  const IDS = construirIds('c3', ['P', 'Q']);
  const DB_NUBE = 'donaji_caos_bajada_nube';
  const DB_P = 'donaji_caos_bajada_p';
  let admin: Client;
  let nube: Client;
  let nodoP: Client;

  beforeAll(async () => {
    admin = await abrirAdmin();
    nube = await crearNodo(admin, DB_NUBE, { esNube: true, sucursalId: null });
    nodoP = await crearNodo(admin, DB_P, { sucursalId: IDS.sucursales[0]! });
  }, 180_000);

  afterAll(async () => {
    await nodoP?.end().catch(() => { /* ya cerrado */ });
    await nube?.end().catch(() => { /* ya cerrado */ });
    await soltarNodo(admin, DB_P);
    await soltarNodo(admin, DB_NUBE);
    await admin?.end().catch(() => { /* ya cerrado */ });
  }, 120_000);

  it('trae lo dirigido a P y lo dirigido a todos; lo dirigido a Q no', async () => {
    const cliente = (n: number, nombre: string) => ({
      id: `019caa5f-0000-7000-8000-0c3000000${n}00`, nombre, telefono: '953 000 0000',
      sync_sucursal_id: IDS.sucursales[1], hlc_ts: new Date().toISOString(), hlc_cnt: 0, version: 1,
    });
    const paraP = cliente(1, 'Para P');
    const paraQ = cliente(2, 'Para Q');
    const paraTodos = cliente(3, 'Para todos');   // destinatarios NULL, como la configuración
    await nube.query(
      `INSERT INTO sync.cambio_log (tabla, fila_id, payload, destinatarios)
       VALUES ('core.cliente', $1, $2::jsonb, ARRAY[$5::uuid]),
              ('core.cliente', $3, $4::jsonb, ARRAY[$6::uuid]),
              ('core.cliente', $7, $8::jsonb, NULL)`,
      [paraP.id, JSON.stringify(paraP), paraQ.id, JSON.stringify(paraQ),
       IDS.sucursales[0], IDS.sucursales[1], paraTodos.id, JSON.stringify(paraTodos)],
    );

    const r = await pull(nodoP, nube, { batchSize: 1000, maxBatches: 50 });
    expect(r.rechazadas).toBe(0);

    const { rows } = await nodoP.query<{ nombre: string }>(
      `SELECT nombre FROM core.cliente WHERE id = ANY($1::uuid[]) ORDER BY nombre`,
      [[paraP.id, paraQ.id, paraTodos.id]],
    );
    expect(rows.map((x) => x.nombre)).toEqual(['Para P', 'Para todos']);

    // Y no la reencoló hacia arriba.
    const { rows: ob } = await nodoP.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.outbox WHERE fila_id = $1`, [paraP.id],
    );
    expect(Number(ob[0]!.n)).toBe(0);
  });
});
