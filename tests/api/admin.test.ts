/**
 * Sección de administración embebida en la API de la terminal (`/admin/*`).
 *
 * Escribe en la NUBE (aquí, la misma base en tx revertida) con la sesión LOCAL
 * del administrador. Sin `dbNube` → 503. Sin rol administrador → 403.
 *
 * Blueprint v0.2 · docs/architecture/blueprint.md §4.1
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../src/db/connection.js';
import { seedAuth } from '../auth/fixture.js';
import { abrirApp, bearer, tokenDe } from './helpers.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const AHORA = new Date('2026-09-10T12:00:00.000Z');
const ahora = (): Date => AHORA;

run('API · /admin (PostgreSQL real)', () => {
  let db: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    // La misma conexión hace de local y de "nube" para la prueba.
    app = await abrirApp(db, ahora, { dbNube: db });
  });
  afterEach(async () => {
    await app.close();
    await db.query('ROLLBACK');
  });

  it('GET /admin/salud reporta disponible cuando hay nube', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/salud' });
    expect(r.statusCode).toBe(200);
    expect(r.json().disponible).toBe(true);
  });

  it('sin token → 401; con rol no-admin → 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/sucursales' })).statusCode).toBe(401);

    const vend = await seedAuth(db, { rol: 'vendedor' });
    const tok = await tokenDe(db, vend.email, vend.sucursalAId, ahora);
    const r = await app.inject({ method: 'GET', url: '/admin/sucursales', headers: bearer(tok) });
    expect(r.statusCode).toBe(403);
  });

  it('un administrador lista y da de alta sucursales y usuarios', async () => {
    const admin = await seedAuth(db, { rol: 'administrador' });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);

    const lista = await app.inject({ method: 'GET', url: '/admin/sucursales', headers: bearer(tok) });
    expect(lista.statusCode).toBe(200);
    expect(Array.isArray(lista.json())).toBe(true);

    const alta = await app.inject({
      method: 'POST', url: '/admin/sucursales', headers: bearer(tok),
      payload: {
        agenciaId: admin.agenciaId, nombre: 'Sucursal Admin', direccionCompleta: 'Calle 9',
        telefonoPrincipal: '951 999 0000', modo: 'inmediato', confirmarInmediato: true,
      },
    });
    expect(alta.statusCode).toBe(201);
    expect(alta.json().escritoPor).toBe(admin.email);

    const usuarios = await app.inject({ method: 'GET', url: '/admin/usuarios', headers: bearer(tok) });
    expect(usuarios.statusCode).toBe(200);

    const nuevo = await app.inject({
      method: 'POST', url: '/admin/usuarios', headers: bearer(tok),
      payload: {
        nombre: 'Vendedor Nuevo', email: `nuevo-${Date.now()}@donaji.test`, rol: 'vendedor',
        sucursalIds: [admin.sucursalAId], modo: 'inmediato', confirmarInmediato: true,
      },
    });
    expect(nuevo.statusCode).toBe(201);
    expect(nuevo.json().passwordTemporal).toBeTruthy();
  });

  it('un administrador crea una ruta con paradas y un horario', async () => {
    const admin = await seedAuth(db, { rol: 'administrador', sucursales: 2 });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);

    const ruta = await app.inject({
      method: 'POST', url: '/admin/rutas-detalle', headers: bearer(tok),
      payload: { nombre: `Ruta QA ${Date.now()}`, sucursalIds: [admin.sucursalAId, admin.sucursalBId] },
    });
    expect(ruta.statusCode, ruta.body).toBe(201);
    const rutaId = ruta.json().id as string;

    const detalle = await app.inject({ method: 'GET', url: '/admin/rutas-detalle', headers: bearer(tok) });
    const r = (detalle.json() as { id: string; paradas: { id: string; orden: number }[] }[]).find((x) => x.id === rutaId)!;
    expect(r.paradas).toHaveLength(2);

    const horario = await app.inject({
      method: 'POST', url: '/admin/horarios', headers: bearer(tok),
      payload: {
        rutaId, horaSalida: '07:00', diasSemana: [1, 2, 3, 4, 5],
        pasos: r.paradas.map((p) => ({ rutaParadaId: p.id, orden: p.orden, horaPaso: p.orden === 0 ? '07:00' : '09:30' })),
      },
    });
    expect(horario.statusCode, horario.body).toBe(201);

    const lista = await app.inject({ method: 'GET', url: `/admin/horarios?rutaId=${rutaId}`, headers: bearer(tok) });
    expect(lista.json()).toHaveLength(1);
    expect(lista.json()[0].pasos).toHaveLength(2);
  });

  it('un administrador da de alta una unidad y un conductor asociado', async () => {
    const admin = await seedAuth(db, { rol: 'administrador' });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);

    const tipos = await app.inject({ method: 'GET', url: '/admin/tipos-unidad', headers: bearer(tok) });
    expect(tipos.statusCode).toBe(200);
    const tipoUnidadId = (tipos.json() as { id: string; clave: string }[])[0]?.id;
    expect(tipoUnidadId).toBeTruthy();

    const eco = `T-${Date.now() % 100000}`;
    const unidad = await app.inject({
      method: 'POST', url: '/admin/unidades', headers: bearer(tok),
      payload: { numeroEconomico: eco, placas: 'ABC-1234', tipoUnidadId, sucursalBaseId: admin.sucursalAId },
    });
    expect(unidad.statusCode, unidad.body).toBe(201);
    const unidadId = unidad.json().id as string;

    // número económico duplicado → 400 con mensaje claro
    const dup = await app.inject({
      method: 'POST', url: '/admin/unidades', headers: bearer(tok),
      payload: { numeroEconomico: eco, tipoUnidadId },
    });
    expect(dup.statusCode).toBe(400);

    const nombre = `Conductor QA ${Date.now()}`;
    const conductor = await app.inject({
      method: 'POST', url: '/admin/conductores', headers: bearer(tok),
      payload: { nombre, telefono: '951 000 0000', tipoUnidadId, unidadHabitualId: unidadId },
    });
    expect(conductor.statusCode, conductor.body).toBe(201);

    const lista = await app.inject({ method: 'GET', url: '/admin/conductores-detalle', headers: bearer(tok) });
    const c = (lista.json() as { nombre: string; unidadHabitual: string | null; tipoUnidad: string }[])
      .find((x) => x.nombre === nombre)!;
    expect(c.unidadHabitual).toBe(eco);

    const baja = await app.inject({ method: 'POST', url: `/admin/unidades/${unidadId}/baja`, headers: bearer(tok) });
    expect(baja.statusCode).toBe(200);
    const uds = await app.inject({ method: 'GET', url: '/admin/unidades-detalle', headers: bearer(tok) });
    expect((uds.json() as { id: string; activo: boolean }[]).find((u) => u.id === unidadId)?.activo).toBe(false);
  });

  it('POST /admin/rutas-detalle rechaza una ruta con una sola parada', async () => {
    const admin = await seedAuth(db, { rol: 'administrador' });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);
    const r = await app.inject({
      method: 'POST', url: '/admin/rutas-detalle', headers: bearer(tok),
      payload: { nombre: 'x', sucursalIds: [admin.sucursalAId] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('POST /admin/config/:tabla rechaza una tabla fuera de la lista', async () => {
    const admin = await seedAuth(db, { rol: 'administrador' });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);
    const r = await app.inject({
      method: 'POST', url: '/admin/config/core.boleto', headers: bearer(tok),
      payload: { fila: { id: '00000000-0000-7000-8000-000000000000' }, modo: 'inmediato', confirmarInmediato: true },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('tabla_no_administrable');
  });

  it('sin nube (`dbNube` null) todo /admin salvo /salud responde 503', async () => {
    await app.close();
    app = await abrirApp(db, ahora, { dbNube: null });

    const salud = await app.inject({ method: 'GET', url: '/admin/salud' });
    expect(salud.json().disponible).toBe(false);

    const admin = await seedAuth(db, { rol: 'administrador' });
    const tok = await tokenDe(db, admin.email, admin.sucursalAId, ahora);
    const r = await app.inject({ method: 'GET', url: '/admin/sucursales', headers: bearer(tok) });
    expect(r.statusCode).toBe(503);
  });
});
