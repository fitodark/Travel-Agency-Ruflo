/**
 * Fase 0 de "paradas autorizadas" — catálogo `core.punto_ruta` y re-cableado
 * estructural de `ruta_parada` / `salida_parada` (contra PostgreSQL real).
 *
 * docs/architecture/05-paradas-autorizadas-tarifas.md §3 y §4 · migración 0048
 *
 * ALCANCE. Solo lo que 0048 introduce ESTRUCTURALMENTE:
 *   - `core.punto_ruta` existe, es clase A y su CHECK terminal<=>sucursal aplica.
 *   - el backfill dejó un punto `terminal` (id determinista) por cada sucursal.
 *   - `ruta_parada.punto_id` / `salida_parada.punto_id` quedan poblados por el
 *     backfill de la migración y por el trigger de compatibilidad.
 *   - `salida_parada.hora_paso_programada` / `cierre_venta_en` aceptan NULL.
 *   - `materializar_salidas` no tira una ruta que tiene una parada de solo
 *     descenso (el `LEFT JOIN core.sucursal`), y esa parada no entra a
 *     `salida_parada` en Fase 0 (no tiene `horario_parada`).
 *
 * NADA de lógica de Fase 1+ (banderas en búsqueda/venta, `tramos_ocupacion`,
 * tarifa estricta, `repartir_cupo_offline` con paradas de descenso): no existe.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { claseDe } from '../../src/sync/clases.js';
import { materializarHorario } from '../../src/fleet/materializar.js';
import { seedRuta } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('Fase 0 · catálogo de puntos de ruta (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  // -------------------------------------------------------------------------
  // core.punto_ruta: existencia, clase A, CHECK terminal<=>sucursal
  // -------------------------------------------------------------------------
  it('core.punto_ruta se registra como entidad clase A (trg_cambio_log + outbox + estándar)', async () => {
    // `registrar_entidad` + `publicar_a_nodos` dejan estos tres triggers.
    const { rows } = await db.query<{ tgname: string }>(
      `SELECT t.tgname
         FROM pg_trigger t
         JOIN pg_class c     ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core' AND c.relname = 'punto_ruta'
          AND NOT t.tgisinternal
        ORDER BY t.tgname`,
    );
    const nombres = rows.map((r) => r.tgname);
    expect(nombres).toContain('trg_cambio_log');   // publicar_a_nodos → clase A
    expect(nombres).toContain('trg_outbox');       // registrar_entidad
    expect(nombres).toContain('trg_estandar');     // registrar_entidad

    // Y la fuente de verdad del motor la clasifica igual.
    expect(claseDe('core.punto_ruta')).toBe('A');
  });

  it('el CHECK terminal<=>sucursal rechaza una terminal sin sucursal y una parada con sucursal', async () => {
    const { rows: s } = await db.query<{ id: string }>(
      `SELECT id FROM core.sucursal WHERE activo LIMIT 1`,
    );
    const sucursalId = s[0]!.id;

    // Un statement fallido aborta la transacción; se aísla cada uno en un savepoint.
    const rechaza = async (sql: string, params: unknown[], patron: RegExp): Promise<void> => {
      await db.query('SAVEPOINT sp');
      await expect(db.query(sql, params)).rejects.toThrow(patron);
      await db.query('ROLLBACK TO SAVEPOINT sp');
    };

    await rechaza(
      `INSERT INTO core.punto_ruta (nombre, tipo, sucursal_id) VALUES ('X', 'terminal', NULL)`,
      [], /punto_ruta_terminal_chk/,
    );
    await rechaza(
      `INSERT INTO core.punto_ruta (nombre, tipo, sucursal_id) VALUES ('X', 'parada', $1)`,
      [sucursalId], /punto_ruta_terminal_chk/,
    );
    await rechaza(
      `INSERT INTO core.punto_ruta (nombre, tipo) VALUES ('X', 'otra_cosa')`,
      [], /punto_ruta_tipo_check/,
    );
  });

  // -------------------------------------------------------------------------
  // Backfill de la migración
  // -------------------------------------------------------------------------
  it('el backfill dejó un punto terminal, con id determinista, por cada sucursal activa', async () => {
    const { rows: falta } = await db.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM core.sucursal s
        WHERE s.activo
          AND NOT EXISTS (
            SELECT 1 FROM core.punto_ruta p
             WHERE p.tipo = 'terminal' AND p.sucursal_id = s.id)`,
    );
    expect(Number(falta[0]!.n)).toBe(0);

    // id = md5('core.punto_ruta:' || sucursal_id) — así nube y nodos convergen.
    const { rows: det } = await db.query<{ ok: boolean }>(
      `SELECT bool_and(id = md5('core.punto_ruta:' || sucursal_id::text)::uuid) AS ok
         FROM core.punto_ruta WHERE tipo = 'terminal'`,
    );
    expect(det[0]!.ok).toBe(true);
  });

  it('ruta_parada.punto_id y salida_parada.punto_id no tienen nulos tras el backfill', async () => {
    for (const tabla of ['core.ruta_parada', 'core.salida_parada']) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${tabla} WHERE punto_id IS NULL`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });

  it('salida_parada.hora_paso_programada y cierre_venta_en aceptan NULL', async () => {
    const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'salida_parada'
          AND column_name IN ('hora_paso_programada', 'cierre_venta_en')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'cierre_venta_en', is_nullable: 'YES' },
      { column_name: 'hora_paso_programada', is_nullable: 'YES' },
    ]);
  });

  // -------------------------------------------------------------------------
  // Trigger de compatibilidad: crear una ruta por sucursal_id sigue funcionando
  // -------------------------------------------------------------------------
  it('seedRuta (por sucursal_id) deja cada ruta_parada con punto_id terminal y banderas true/true', async () => {
    const fx = await seedRuta(db, { paradas: 3 });

    const { rows } = await db.query<{
      n: string; con_punto: string; ambas_banderas: string; punto_ok: string;
    }>(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE rp.punto_id IS NOT NULL) AS con_punto,
              count(*) FILTER (WHERE rp.permite_ascenso AND rp.permite_descenso) AS ambas_banderas,
              count(*) FILTER (WHERE pr.tipo = 'terminal' AND pr.sucursal_id = rp.sucursal_id) AS punto_ok
         FROM core.ruta_parada rp
         JOIN core.punto_ruta pr ON pr.id = rp.punto_id
        WHERE rp.ruta_id = $1`,
      [fx.rutaId],
    );
    expect(Number(rows[0]!.n)).toBe(3);
    expect(Number(rows[0]!.con_punto)).toBe(3);
    expect(Number(rows[0]!.ambas_banderas)).toBe(3);
    expect(Number(rows[0]!.punto_ok)).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Ruta con una parada de solo descenso
  // -------------------------------------------------------------------------
  it('una ruta con una parada de solo descenso: 2 terminales + 1 parada, banderas y sucursal_id NULL', async () => {
    const fx = await seedRuta(db, { paradas: 3, paradaDescensoEnOrden: 1 });

    const { rows: puntos } = await db.query<{ tipo: string; n: string }>(
      `SELECT pr.tipo, count(*) AS n
         FROM core.ruta_parada rp
         JOIN core.punto_ruta pr ON pr.id = rp.punto_id
        WHERE rp.ruta_id = $1
        GROUP BY pr.tipo ORDER BY pr.tipo`,
      [fx.rutaId],
    );
    expect(puntos).toEqual([
      { tipo: 'parada', n: '1' },
      { tipo: 'terminal', n: '2' },
    ]);

    const { rows: parada } = await db.query<{
      permite_ascenso: boolean; permite_descenso: boolean;
      sucursal_id: string | null; tipo: string;
    }>(
      `SELECT rp.permite_ascenso, rp.permite_descenso, rp.sucursal_id, pr.tipo
         FROM core.ruta_parada rp
         JOIN core.punto_ruta pr ON pr.id = rp.punto_id
        WHERE rp.ruta_id = $1 AND rp.orden = 1`,
      [fx.rutaId],
    );
    expect(parada[0]).toMatchObject({
      permite_ascenso: false,
      permite_descenso: true,
      sucursal_id: null,
      tipo: 'parada',
    });
  });

  it('materializar_salidas NO tira la ruta con parada de descenso; esa parada no entra a salida_parada', async () => {
    const fx = await seedRuta(db, { paradas: 3, paradaDescensoEnOrden: 1 });

    const r = await materializarHorario(db, fx.horarioId, { dias: 0 });
    expect(r.creadas).toBe(1);
    expect(r.sinParadas).toBe(0);

    // salida_parada: solo las 2 terminales (ordenes 0 y 2), con su punto terminal.
    const { rows } = await db.query<{ orden: number; tipo: string; con_hora: boolean }>(
      `SELECT sp.orden, pr.tipo, (sp.hora_paso_programada IS NOT NULL) AS con_hora
         FROM core.salida_parada sp
         JOIN core.salida s      ON s.id = sp.salida_id
         JOIN core.punto_ruta pr ON pr.id = sp.punto_id
        WHERE s.horario_id = $1
        ORDER BY sp.orden`,
      [fx.horarioId],
    );
    expect(rows).toEqual([
      { orden: 0, tipo: 'terminal', con_hora: true },
      { orden: 2, tipo: 'terminal', con_hora: true },
    ]);
  });

  it('regresión: una ruta de puras terminales sigue materializando sus 3 paradas', async () => {
    const fx = await seedRuta(db, { paradas: 3 });

    const r = await materializarHorario(db, fx.horarioId, { dias: 0 });
    expect(r.creadas).toBe(1);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM core.salida_parada sp
         JOIN core.salida s ON s.id = sp.salida_id
        WHERE s.horario_id = $1`,
      [fx.horarioId],
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });
});
