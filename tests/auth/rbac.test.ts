/**
 * RBAC contra `core.rol_permiso` — la matriz de permisos como dato, no como `if`.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.4
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { permisosDe, puede } from '../../src/auth/rbac.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('rbac (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  it('el vendedor puede vender pero no configurar', async () => {
    expect(await puede(db, 'vendedor', 'venta.crear')).toBe(true);
    expect(await puede(db, 'vendedor', 'corte.abrir')).toBe(true);
    expect(await puede(db, 'vendedor', 'config.usuarios')).toBe(false);
    expect(await puede(db, 'vendedor', 'venta.anular')).toBe(false);
  });

  it('el gerente supervisa pero no configura horarios ni usuarios', async () => {
    expect(await puede(db, 'gerente', 'venta.anular')).toBe(true);
    expect(await puede(db, 'gerente', 'excepcion.resolver')).toBe(true);
    expect(await puede(db, 'gerente', 'asiento.override')).toBe(true);
    expect(await puede(db, 'gerente', 'config.horarios')).toBe(false);
    expect(await puede(db, 'gerente', 'movimiento.ver_inactivos')).toBe(false);
  });

  it('el administrador configura y audita', async () => {
    expect(await puede(db, 'administrador', 'config.usuarios')).toBe(true);
    expect(await puede(db, 'administrador', 'config.tarifas')).toBe(true);
    expect(await puede(db, 'administrador', 'movimiento.ver_inactivos')).toBe(true);
    expect(await puede(db, 'administrador', 'dashboard.ver')).toBe(true);
  });

  it('un rol o permiso inexistente devuelve false, no lanza', async () => {
    expect(await puede(db, 'superusuario', 'todo')).toBe(false);
    expect(await puede(db, 'vendedor', 'permiso.que.no.existe')).toBe(false);
  });

  it('`permisosDe` lista los permisos del rol, ordenados y sin los de otros', async () => {
    const v = await permisosDe(db, 'vendedor');
    expect(v).toContain('venta.crear');
    expect(v).toContain('ticket.reimprimir');
    expect(v).not.toContain('config.usuarios');
    expect([...v].sort()).toEqual(v);

    const a = await permisosDe(db, 'administrador');
    expect(a.length).toBeGreaterThan(v.length);
  });
});
