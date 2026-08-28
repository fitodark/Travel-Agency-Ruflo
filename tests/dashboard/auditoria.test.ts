/**
 * Auditoría, salud de sync y gastos del dashboard (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8, slice 2)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { abrirCorte } from '../../src/caja/corte.js';
import { anularMovimiento, registrarEgreso } from '../../src/caja/movimiento.js';
import {
  auditoriaInactivos, excepcionesAbiertas, excepcionesResumen, gastos, saludSucursales,
} from '../../src/dashboard/auditoria.js';
import { crearUsuario, seedCaja } from '../caja/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

const RANGO = ['2020-01-01', '2100-01-01'] as const;

run('dashboard · auditoría, salud y gastos (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  // -------------------------------------------------------------------------
  it('un egreso anulado aparece en la auditoría de inactivos con su motivo', async () => {
    const fx = await seedCaja(db, 1);
    const u = await crearUsuario(db);
    const corteId = await abrirCorte(db, {
      sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500,
    });
    const movId = await registrarEgreso(db, {
      corteId, usuarioId: u, monto: 90, descripcion: 'café',
    });
    await anularMovimiento(db, { movimientoId: movId, usuarioId: u, motivo: 'devuelto por el proveedor' });

    const inactivos = await auditoriaInactivos(db, { tabla: 'core.movimiento_caja' });
    const mio = inactivos.find((r) => r.id === movId);
    expect(mio).toBeDefined();
    expect(mio!.desactivadoMotivo).toBe('devuelto por el proveedor');
    expect(mio!.resumen).toMatch(/egreso de \$90.*café/);
  });

  it('salud de sucursales: refleja `sync.salud` y clasifica `degradado`', async () => {
    const fx = await seedCaja(db, 3);
    // Una que sincronizó hace poco, otra hace mucho, otra que nunca reportó.
    await db.query(
      `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa, outbox_pendiente, version_esquema)
       VALUES ($1, now() - interval '10 minutes', 0, '0029_x'),
              ($2, now() - interval '5 days', 12, '0021_x')`,
      [fx.sucursales[0], fx.sucursales[1]],
    );

    const salud = await saludSucursales(db);
    const porId = new Map(salud.map((s) => [s.sucursalId, s]));
    expect(porId.get(fx.sucursales[0]!)!.degradado).toBe(false);
    expect(porId.get(fx.sucursales[1]!)!.degradado).toBe(true);
    expect(porId.get(fx.sucursales[1]!)!.outboxPendiente).toBe(12);
    expect(porId.get(fx.sucursales[2]!)!.degradado, 'nunca reportó').toBeNull();
  });

  it('excepciones abiertas: listado ordenado por severidad y resumen por severidad', async () => {
    const fx = await seedCaja(db, 1);
    // El `pretest` deja `sync.excepcion` vacía; aquí se hace `DELETE` (no
    // `TRUNCATE`, cuyo ACCESS EXCLUSIVE interbloquea en paralelo) por si otro
    // proceso dejó ruido. El rollback del test lo restaura.
    await db.query('DELETE FROM sync.excepcion');
    await db.query(
      `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, estado)
       VALUES ('deriva_reloj', 'alta',    $1, 'abierta'),
              ('sobreventa',   'critica', $1, 'abierta'),
              ('respaldo_vencido', 'media', $1, 'resuelta')`,
      [fx.sucursales[0]],
    );

    const lista = await excepcionesAbiertas(db);
    expect(lista.map((e) => e.tipo)).toEqual(['sobreventa', 'deriva_reloj']);
    expect(lista[0]!.severidad, 'la crítica primero').toBe('critica');

    const resumen = await excepcionesResumen(db);
    expect(resumen).toEqual({ critica: 1, alta: 1, media: 0, baja: 0 });
  });

  it('gastos: egresos de caja por sucursal y la nómina mensual', async () => {
    const fx = await seedCaja(db, 1);
    const u = await crearUsuario(db);
    await db.query(`UPDATE core.usuario SET sueldo = 12000 WHERE id = $1`, [u]);
    const corteId = await abrirCorte(db, {
      sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500,
    });
    await registrarEgreso(db, { corteId, usuarioId: u, monto: 150, descripcion: 'limpieza' });
    await registrarEgreso(db, { corteId, usuarioId: u, monto: 60, descripcion: 'focos' });

    const g = await gastos(db, RANGO[0], RANGO[1]);
    const egresos = g.filter((x) => x.concepto.startsWith('egreso_'));
    expect(egresos.reduce((a, x) => a + x.monto, 0)).toBe(210);

    const nomina = g.find((x) => x.concepto === 'nomina_mensual')!;
    expect(nomina.sucursal).toBeNull();
    expect(nomina.monto).toBeGreaterThanOrEqual(12000);
  });

  it('un egreso anulado no cuenta en gastos (regresó al corte)', async () => {
    const fx = await seedCaja(db, 1);
    const u = await crearUsuario(db);
    const corteId = await abrirCorte(db, {
      sucursalId: fx.sucursales[0]!, usuarioId: u, saldoInicial: 500,
    });
    const movId = await registrarEgreso(db, { corteId, usuarioId: u, monto: 200, descripcion: 'x' });
    await anularMovimiento(db, { movimientoId: movId, usuarioId: u, motivo: 'error' });

    const g = await gastos(db, RANGO[0], RANGO[1]);
    const egr = g.filter((x) => x.concepto.startsWith('egreso_') && x.sucursal !== null);
    expect(egr.reduce((a, x) => a + x.monto, 0)).toBe(0);
  });
});
