/**
 * `escribirConfig`: escritura de configuración clase A con fecha de vigencia (F2b).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §3.1–§3.2
 *
 * Solo el escenario que comprueba la publicación marca el nodo como nube
 * (`sync.nodo.es_nube`), y lo hace dentro de su propio `it` para no tomar el lock
 * de esa fila única durante toda la suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { escribirConfig, proximaVentana } from '../../src/admin/escribir-config.js';

describe('escribirConfig · validación sin base', () => {
  const dbFalso = { query: async () => { throw new Error('no debería tocar la base'); } };

  it('rechaza una tabla que no es clase A antes de tocar la base', async () => {
    await expect(
      escribirConfig(dbFalso as never, { tabla: 'core.venta', fila: {}, modo: 'inmediato' }),
    ).rejects.toThrow(/clase A/i);
  });

  it('rechaza una tabla desconocida', async () => {
    await expect(
      escribirConfig(dbFalso as never, { tabla: 'core.inventada', fila: {}, modo: 'inmediato' }),
    ).rejects.toThrow(/clase A/i);
  });
});

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('escribirConfig · contra PostgreSQL (nodo marcado como nube)', () => {
  let db: Client;
  let agenciaId: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  // Códigos de sucursal libres (no se hardcodean: la base compartida y las
  // pruebas en paralelo pueden tener cualquiera ocupado).
  let libres: string[] = [];
  const codigoLibre = (): string => {
    const c = libres.shift();
    if (!c) throw new Error('no quedan códigos de sucursal libres');
    return c;
  };

  beforeEach(async () => {
    await db.query('BEGIN');
    const ag = await db.query<{ id: string }>(
      `SELECT id FROM core.agencia WHERE activo ORDER BY creado_en LIMIT 1`,
    );
    agenciaId = ag.rows[0]!.id;
    const { rows } = await db.query<{ c: string }>(
      `SELECT c FROM unnest(string_to_array('ABCDEFGHJKMNPQRSTVWXYZ23456789', NULL)) AS c
        WHERE c NOT IN (SELECT codigo FROM core.sucursal) ORDER BY c LIMIT 6`,
    );
    libres = rows.map((r) => r.c);
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const AHORA = new Date('2026-09-10T16:00:00.000Z');
  const ahora = (): Date => AHORA;

  const usuario = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    nombre: 'Persona F2b',
    email: `f2b-${Math.floor(Math.random() * 1e9)}@donaji.test`,
    rol: 'vendedor',
    ...extra,
  });

  const enCambioLog = async (tabla: string, id: string): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.cambio_log WHERE tabla = $1 AND fila_id = $2`,
      [tabla, id],
    );
    return Number(rows[0]!.n);
  };

  // -------------------------------------------------------------------------
  it('modo ventana: fija effective_from en la próxima 03:00 hora local', async () => {
    const r = await escribirConfig(db, {
      tabla: 'core.usuario', fila: usuario(), modo: 'ventana',
      zonaHoraria: 'America/Mexico_City', ahora,
    });
    expect(r.creada).toBe(true);
    expect(r.vigenciaEn).toBe('effective_from');
    expect(r.vigenciaDesde.getTime()).toBeGreaterThan(AHORA.getTime());

    const { rows } = await db.query<{ hhmm: string; ef: Date }>(
      `SELECT to_char($1::timestamptz AT TIME ZONE 'America/Mexico_City', 'HH24:MI') AS hhmm,
              effective_from AS ef
         FROM core.usuario WHERE id = $2`,
      [r.vigenciaDesde.toISOString(), r.id],
    );
    expect(rows[0]!.hhmm).toBe('03:00');
    expect(new Date(rows[0]!.ef).getTime()).toBe(r.vigenciaDesde.getTime());
  });

  it('publica el alta en sync.cambio_log (la config baja a las terminales)', async () => {
    // `trg_cambio_log` solo dispara si el nodo es la nube. Se marca aquí, no en
    // el beforeEach, para no serializar con el resto de la suite por el lock de
    // la fila única sync.nodo.
    await db.query("SET LOCAL donaji.forzar_nube = 'on'");
    const r = await escribirConfig(db, {
      tabla: 'core.usuario', fila: usuario(), modo: 'ventana', ahora,
    });
    expect(await enCambioLog('core.usuario', r.id)).toBeGreaterThanOrEqual(1);
  });

  it('modo inmediato exige confirmación explícita', async () => {
    await expect(
      escribirConfig(db, { tabla: 'core.usuario', fila: usuario(), modo: 'inmediato', ahora }),
    ).rejects.toThrow(/confirmarInmediato/);

    const r = await escribirConfig(db, {
      tabla: 'core.usuario', fila: usuario(), modo: 'inmediato',
      confirmarInmediato: true, ahora,
    });
    expect(r.vigenciaDesde.getTime()).toBe(AHORA.getTime());
  });

  it('modo programado usa la fecha dada, y la exige', async () => {
    await expect(
      escribirConfig(db, { tabla: 'core.usuario', fila: usuario(), modo: 'programado', ahora }),
    ).rejects.toThrow(/fechaProgramada/);

    const cuando = new Date('2026-12-01T06:00:00.000Z');
    const r = await escribirConfig(db, {
      tabla: 'core.usuario', fila: usuario(), modo: 'programado',
      fechaProgramada: cuando, ahora,
    });
    expect(r.vigenciaDesde.getTime()).toBe(cuando.getTime());
  });

  it('una segunda escritura con el mismo id actualiza en vez de duplicar', async () => {
    const primera = await escribirConfig(db, {
      tabla: 'core.usuario', fila: usuario({ nombre: 'Antes' }), modo: 'inmediato',
      confirmarInmediato: true, ahora,
    });
    const segunda = await escribirConfig(db, {
      tabla: 'core.usuario',
      fila: usuario({ id: primera.id, nombre: 'Después' }),
      modo: 'inmediato', confirmarInmediato: true, ahora,
    });
    expect(segunda.creada).toBe(false);

    const { rows } = await db.query<{ nombre: string; version: number }>(
      `SELECT nombre, version FROM core.usuario WHERE id = $1`, [primera.id],
    );
    expect(rows[0]!.nombre).toBe('Después');
    expect(rows[0]!.version).toBe(2);
  });

  it('una baja va en effective_until, no en effective_from', async () => {
    const alta = await escribirConfig(db, {
      tabla: 'core.usuario', fila: usuario(), modo: 'inmediato',
      confirmarInmediato: true, ahora,
    });
    const baja = await escribirConfig(db, {
      tabla: 'core.usuario',
      fila: { id: alta.id, ...usuario({ activo: false }) },
      modo: 'inmediato', confirmarInmediato: true, vigenciaEn: 'effective_until', ahora,
    });
    expect(baja.vigenciaEn).toBe('effective_until');

    const { rows } = await db.query<{ activo: boolean; eu: Date | null }>(
      `SELECT activo, effective_until AS eu FROM core.usuario WHERE id = $1`, [alta.id],
    );
    expect(rows[0]!.activo).toBe(false);
    expect(rows[0]!.eu).not.toBeNull();
  });

  it('deduce la zona de fila.zona_horaria cuando no se pasa explícita', async () => {
    const mx = await escribirConfig(db, {
      tabla: 'core.sucursal',
      fila: {
        agencia_id: agenciaId, nombre: 'Suc MX', direccion_completa: 'x', telefono_principal: 'x',
        codigo: codigoLibre(), zona_horaria: 'America/Mexico_City',
      },
      modo: 'ventana', ahora,
    });
    const tj = await escribirConfig(db, {
      tabla: 'core.sucursal',
      fila: {
        agencia_id: agenciaId, nombre: 'Suc TJ', direccion_completa: 'x', telefono_principal: 'x',
        codigo: codigoLibre(), zona_horaria: 'America/Tijuana',
      },
      modo: 'ventana', ahora,
    });
    // Tijuana va 1 h detrás de Ciudad de México: su próxima 03:00 local cae 1 h después en UTC.
    expect(tj.vigenciaDesde.getTime()).toBe(mx.vigenciaDesde.getTime() + 3_600_000);
  });

  it('rechaza una columna que la tabla no tiene', async () => {
    await expect(
      escribirConfig(db, {
        tabla: 'core.usuario', fila: usuario({ inventada: 1 }), modo: 'inmediato',
        confirmarInmediato: true, ahora,
      }),
    ).rejects.toThrow(/no tiene la columna "inventada"/);
  });

  it('proximaVentana: siempre en el futuro y a las 03:00 locales', async () => {
    const v = await proximaVentana(db, 'America/Mexico_City', AHORA);
    expect(v.getTime()).toBeGreaterThan(AHORA.getTime());
    const { rows } = await db.query<{ hhmm: string }>(
      `SELECT to_char($1::timestamptz AT TIME ZONE 'America/Mexico_City', 'HH24:MI') AS hhmm`,
      [v.toISOString()],
    );
    expect(rows[0]!.hhmm).toBe('03:00');
  });
  // Toda escritura serializa en `sync.hlc_estado` (defecto vigente): bajo la
  // suite en paralelo el timeout de 5 s por defecto se queda corto.
}, 25_000);
