/**
 * "Historial de Cortes" (0077): paginado, filtro por usuario, detalle de un
 * corte y de sus movimientos con método de pago — separado de la operación
 * del corte activo (ver tests/api/caja.test.ts). También cubre la regresión
 * de 0076: un gerente en modo consulta (sin sucursal activa) debe poder
 * consultar el historial de CUALQUIERA de sus sucursales asignadas.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { seedCaja } from '../caja/fixture.js';
import { crearUsuarioConAcceso } from '../ventas/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

// Reloj mutable (a diferencia de caja.test.ts): la paginación ordena por
// `abierto_en DESC` y necesitamos cortes con marcas de tiempo distintas.
let reloj = new Date(Date.now() + 30 * 86_400_000);
const ahora = (): Date => reloj;
const avanzar = (minutos: number): void => { reloj = new Date(reloj.getTime() + minutos * 60_000); };

run('API · /caja/cortes (historial, 0077)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    reloj = new Date(Date.now() + 30 * 86_400_000);
    await db.query('BEGIN');
    app = await abrirApp(db, ahora);
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  const abrir = async (token: string, saldoInicial = 100) => {
    const r = await app.inject({
      method: 'POST', url: '/caja/corte', headers: bearer(token), payload: { saldoInicial },
    });
    expect(r.statusCode).toBe(201);
    return r.json().corteId as string;
  };
  const cerrar = async (token: string, corteId: string, saldoDeclarado = 100) => {
    const r = await app.inject({
      method: 'POST', url: `/caja/corte/${corteId}/cerrar`, headers: bearer(token),
      payload: { saldoDeclarado },
    });
    expect(r.statusCode).toBe(200);
  };

  // ---------------------------------------------------------------------------
  it('pagina el historial: total correcto, orden por más reciente y tamaño de página', async () => {
    // Gerente (no admin): el admin ve TODA la base, incluida la actividad que
    // ya exista en la BD de dev — un gerente queda acotado a su sucursal, que
    // aquí es de un solo uso, así que el conteo da exacto.
    const fx = await seedCaja(db, 1);
    const sucA = fx.sucursales[0]!;
    const ger = await crearUsuarioConAcceso(db, sucA, 'gerente');
    const tokGer = await tokenDe(db, ger.email, sucA, ahora);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await abrir(tokGer, 100 + i);
      await cerrar(tokGer, id, 100 + i);
      ids.push(id);
      avanzar(10);
    }
    // Se abrieron en orden ids[0] (más viejo) .. ids[2] (más nuevo).

    const r1 = await app.inject({
      method: 'GET', url: '/caja/cortes?porPagina=2&pagina=1', headers: bearer(tokGer),
    });
    expect(r1.statusCode).toBe(200);
    const p1 = r1.json();
    expect(p1.total).toBe(3);
    expect(p1.filas.map((c: { corteId: string }) => c.corteId)).toEqual([ids[2], ids[1]]);

    const r2 = await app.inject({
      method: 'GET', url: '/caja/cortes?porPagina=2&pagina=2', headers: bearer(tokGer),
    });
    const p2 = r2.json();
    expect(p2.total).toBe(3);
    expect(p2.filas.map((c: { corteId: string }) => c.corteId)).toEqual([ids[0]]);
  });

  it('filtra por usuario que abrió el corte y alimenta el combo /cortes/usuarios', async () => {
    const fx = await seedCaja(db, 1);
    const sucA = fx.sucursales[0]!;
    const ger = await crearUsuarioConAcceso(db, sucA, 'gerente');
    const v1 = await crearUsuarioConAcceso(db, sucA, 'vendedor');
    const v2 = await crearUsuarioConAcceso(db, sucA, 'vendedor');
    const tokGer = await tokenDe(db, ger.email, sucA, ahora);
    const tokV1 = await tokenDe(db, v1.email, sucA, ahora);
    const tokV2 = await tokenDe(db, v2.email, sucA, ahora);

    const c1 = await abrir(tokV1); await cerrar(tokV1, c1); avanzar(5);
    const c2 = await abrir(tokV2); await cerrar(tokV2, c2);

    const combo = await app.inject({ method: 'GET', url: '/caja/cortes/usuarios', headers: bearer(tokGer) });
    expect(combo.statusCode).toBe(200);
    expect(combo.json().map((u: { id: string }) => u.id).sort()).toEqual(
      [v1.usuarioId, v2.usuarioId].sort(),
    );

    const filtrado = await app.inject({
      method: 'GET', url: `/caja/cortes?usuarioAperturaId=${v1.usuarioId}`, headers: bearer(tokGer),
    });
    expect(filtrado.json().filas.map((c: { corteId: string }) => c.corteId)).toEqual([c1]);
  });

  it('GET /caja/cortes/:id regresa el resumen; un id inexistente es 403 (no hay fila que ver)', async () => {
    const fx = await seedCaja(db, 1);
    const sucA = fx.sucursales[0]!;
    const adm = await crearUsuarioConAcceso(db, sucA, 'administrador');
    const tokAdm = await tokenDe(db, adm.email, sucA, ahora);
    const corteId = await abrir(tokAdm, 250);

    const r = await app.inject({ method: 'GET', url: `/caja/cortes/${corteId}`, headers: bearer(tokAdm) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ corteId, saldoInicial: 250, estado: 'abierto' });

    // `corte_visible_por` exige que la fila exista; un id que no existe nunca
    // pasa ese filtro (para ningún rol), así que no llega a la rama 404.
    const rFalta = await app.inject({
      method: 'GET', url: '/caja/cortes/00000000-0000-0000-0000-000000000000', headers: bearer(tokAdm),
    });
    expect(rFalta.statusCode).toBe(403);
  });

  it('GET /corte/:id/movimientos-detalle trae el detalle (egreso sin método de pago)', async () => {
    const fx = await seedCaja(db, 1);
    const sucA = fx.sucursales[0]!;
    const adm = await crearUsuarioConAcceso(db, sucA, 'administrador');
    const tokAdm = await tokenDe(db, adm.email, sucA, ahora);
    const corteId = await abrir(tokAdm);
    await app.inject({
      method: 'POST', url: `/caja/corte/${corteId}/egresos`, headers: bearer(tokAdm),
      payload: { monto: 40, descripcion: 'plumones' },
    });

    const r = await app.inject({
      method: 'GET', url: `/caja/corte/${corteId}/movimientos-detalle`, headers: bearer(tokAdm),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([
      expect.objectContaining({
        tipo: 'egreso', monto: 40, metodoPago: null, pasajeros: null,
      }),
    ]);
  });

  it('un vendedor no entra al módulo (403) en /cortes, /cortes/usuarios y /cortes/:id', async () => {
    const fx = await seedCaja(db, 1);
    const sucA = fx.sucursales[0]!;
    const v = await crearUsuarioConAcceso(db, sucA, 'vendedor');
    const tokV = await tokenDe(db, v.email, sucA, ahora);
    const corteId = await abrir(tokV);

    for (const url of ['/caja/cortes', '/caja/cortes/usuarios', `/caja/cortes/${corteId}`,
      `/caja/corte/${corteId}/movimientos-detalle`]) {
      const r = await app.inject({ method: 'GET', url, headers: bearer(tokV) });
      expect(r.statusCode).toBe(403);
    }
  });

  // ---------------------------------------------------------------------------
  // Regresión 0076/0077: un gerente en modo consulta (sin sucursal activa) debe
  // poder ver el historial de CUALQUIERA de sus sucursales asignadas, no solo
  // la que tenía activa antes de entrar en modo consulta.
  // ---------------------------------------------------------------------------
  it('un gerente en modo consulta ve el corte y los movimientos de su OTRA sucursal', async () => {
    const fx = await seedCaja(db, 2);
    const [sucA, sucB] = fx.sucursales as [string, string];
    const ger = await crearUsuarioConAcceso(db, sucA, 'gerente');
    await db.query(
      'INSERT INTO core.usuario_sucursal (usuario_id, sucursal_id) VALUES ($1, $2)',
      [ger.usuarioId, sucB],
    );
    const vB = await crearUsuarioConAcceso(db, sucB, 'vendedor');
    const tokGer = await tokenDe(db, ger.email, sucA, ahora);
    const tokVB = await tokenDe(db, vB.email, sucB, ahora);

    // sucA (donde el gerente tiene su sesión) sin corte abierto ⇒ puede entrar
    // en modo consulta; sucB tiene un corte abierto por el vendedor.
    const corteB = await abrir(tokVB, 150);

    const entrar = await app.inject({
      method: 'POST', url: '/auth/modo-consulta', headers: bearer(tokGer),
    });
    expect(entrar.statusCode).toBe(200);

    const detalle = await app.inject({
      method: 'GET', url: `/caja/cortes/${corteB}`, headers: bearer(tokGer),
    });
    expect(detalle.statusCode).toBe(200);
    expect(detalle.json()).toMatchObject({ corteId: corteB, sucursalId: sucB });

    const movs = await app.inject({
      method: 'GET', url: `/caja/corte/${corteB}/movimientos-detalle`, headers: bearer(tokGer),
    });
    expect(movs.statusCode).toBe(200);

    const corresponsal = await app.inject({
      method: 'GET', url: `/caja/corte/${corteB}/corresponsal`, headers: bearer(tokGer),
    });
    expect(corresponsal.statusCode).toBe(200);

    const lista = await app.inject({
      method: 'GET', url: `/caja/cortes?sucursalId=${sucB}`, headers: bearer(tokGer),
    });
    expect(lista.statusCode).toBe(200);
    expect(lista.json().filas.map((c: { corteId: string }) => c.corteId)).toEqual([corteB]);
  });
});
