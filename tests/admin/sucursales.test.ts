/**
 * Alta / edición / baja de sucursales desde la consola de administración (F2b, slice 2).
 *
 * Contra PostgreSQL real, en transacción revertida. Solo el caso que comprueba la
 * publicación marca el nodo como nube, dentro de su propio `it`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  crearSucursal, darDeBajaSucursal, editarSucursal, listarSucursales, regenerarHotp,
} from '../../src/admin/sucursales.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;
const AHORA = new Date('2026-09-10T16:00:00.000Z');
const ahora = (): Date => AHORA;

run('consola · sucursales (PostgreSQL real)', () => {
  let db: Client;
  let agenciaId: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.agencia WHERE activo ORDER BY creado_en LIMIT 1`,
    );
    agenciaId = rows[0]!.id;
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const datos = (codigo: string, extra: Record<string, unknown> = {}) => ({
    agenciaId,
    nombre: `Terminal ${codigo}`,
    direccionCompleta: `Calle ${codigo} 100, Centro`,
    telefonoPrincipal: '953 000 0000',
    codigo,
    ...extra,
  });

  const semilla = async (sucursalId: string): Promise<Buffer | null> => {
    const { rows } = await db.query<{ semilla: Buffer }>(
      `SELECT semilla FROM auth_local.revocacion_hotp WHERE sucursal_id = $1 AND activo`,
      [sucursalId],
    );
    return rows[0]?.semilla ?? null;
  };

  // ---- dominio -----------------------------------------------------------
  it('crearSucursal da de alta la sucursal y genera su semilla HOTP de 20 bytes', async () => {
    const r = await crearSucursal(db, datos('Z'), { ahora });
    expect(r.codigo).toBe('Z');

    const { rows } = await db.query<{ nombre: string; zona: string }>(
      `SELECT nombre, zona_horaria AS zona FROM core.sucursal WHERE id = $1`, [r.id],
    );
    expect(rows[0]!.nombre).toBe('Terminal Z');
    expect(rows[0]!.zona).toBe('America/Mexico_City');

    const s = await semilla(r.id);
    expect(s).not.toBeNull();
    expect(s!.length).toBe(20);
  });

  it('crearSucursal asigna el siguiente código libre si no se pasa', async () => {
    const r = await crearSucursal(db, {
      agenciaId, nombre: 'Auto', direccionCompleta: 'x', telefonoPrincipal: 'x',
    }, { ahora });
    expect(r.codigo).toHaveLength(1);
    expect('0123456789ABCDEFGHJKMNPQRSTVWXYZ').toContain(r.codigo);
  });

  it('crearSucursal rechaza un código fuera del alfabeto y una zona desconocida', async () => {
    await expect(crearSucursal(db, datos('I'), { ahora })).rejects.toThrow(/código/i);
    await expect(crearSucursal(db, datos('AB'), { ahora })).rejects.toThrow(/código/i);
    await expect(
      crearSucursal(db, datos('Y', { zonaHoraria: 'Marte/Olympus' }), { ahora }),
    ).rejects.toThrow(/zona horaria/i);
  });

  it('el modo de propagación llega hasta el alta', async () => {
    const v = await crearSucursal(db, datos('X'), { modo: 'ventana', ahora });
    expect(new Date(v.effectiveFrom).getTime()).toBeGreaterThan(AHORA.getTime());

    await expect(
      crearSucursal(db, datos('W'), { modo: 'inmediato', ahora }),
    ).rejects.toThrow(/confirmarInmediato/);
  });

  it('editarSucursal cambia campos y sube la versión', async () => {
    const { id } = await crearSucursal(db, datos('Z'), { ahora });
    await editarSucursal(db, id, { nombre: 'Renombrada', telefonoPrincipal: '953 111 2222' },
      { modo: 'inmediato', confirmarInmediato: true, ahora });

    const { rows } = await db.query<{ nombre: string; tel: string; version: number }>(
      `SELECT nombre, telefono_principal AS tel, version FROM core.sucursal WHERE id = $1`, [id],
    );
    expect(rows[0]).toMatchObject({ nombre: 'Renombrada', tel: '953 111 2222', version: 2 });
  });

  it('darDeBajaSucursal marca activo=false con effective_until', async () => {
    const { id } = await crearSucursal(db, datos('Z'), { ahora });
    const r = await darDeBajaSucursal(db, id, { modo: 'inmediato', confirmarInmediato: true, ahora });
    expect(new Date(r.effectiveUntil).getTime()).toBe(AHORA.getTime());

    const { rows } = await db.query<{ activo: boolean; eu: Date | null }>(
      `SELECT activo, effective_until AS eu FROM core.sucursal WHERE id = $1`, [id],
    );
    expect(rows[0]!.activo).toBe(false);
    expect(rows[0]!.eu).not.toBeNull();
  });

  it('regenerarHotp cambia la semilla', async () => {
    const { id } = await crearSucursal(db, datos('Z'), { ahora });
    const antes = await semilla(id);
    await regenerarHotp(db, id, { ahora });
    const despues = await semilla(id);
    expect(despues).not.toBeNull();
    expect(Buffer.compare(antes!, despues!)).not.toBe(0);
  });

  it('listarSucursales incluye las inactivas y marca si tienen HOTP', async () => {
    const { id } = await crearSucursal(db, datos('Z'), { ahora });
    await darDeBajaSucursal(db, id, { modo: 'inmediato', confirmarInmediato: true, ahora });

    const lista = await listarSucursales(db);
    const mia = lista.find((s) => s.id === id);
    expect(mia).toBeDefined();
    expect(mia!.activo).toBe(false);
    expect(mia!.tieneHotp).toBe(true);
  });

  it('el alta publica la sucursal y su semilla a las terminales', async () => {
    await db.query("SET LOCAL donaji.forzar_nube = 'on'");
    const { id } = await crearSucursal(db, datos('Z'), { ahora });

    const { rows } = await db.query<{ tabla: string }>(
      `SELECT DISTINCT tabla FROM sync.cambio_log WHERE fila_id = $1`, [id],
    );
    const tablas = rows.map((r) => r.tabla).sort();
    expect(tablas).toEqual(['auth_local.revocacion_hotp', 'core.sucursal']);
  });
  // Cada alta son dos escrituras (sucursal + semilla), y toda escritura de la
  // base serializa en la fila única `sync.hlc_estado` (defecto vigente de F1).
  // Bajo la suite en paralelo, el timeout de 5 s por defecto se queda corto.
}, 25_000);
