/**
 * Reconciliación por checksum: el diff fila a fila y el re-push dirigido.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §6.1
 *                  docs/architecture/04-riesgos-roadmap.md §2 (R3), §8
 *
 * `sync.calcular_checksum` dice SI un bloque diverge; `sync.filas_bloque` (0033) más
 * `reconciliar()` dicen QUÉ fila y de qué lado. Estas pruebas fijan esa superficie:
 * antes vivían como `it.todo` en `motor-pendiente.test.ts`.
 *
 * NUBE SIMULADA: base local marcada `sync.nodo.es_nube = true`. Mismas migraciones,
 * mismos triggers, misma `ingest_batch`. Lo único que no cubre —"¿llegó a Supabase?"—
 * lo cubre `f1-criterios.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import type { Client } from 'pg';
import { bootstrap } from '../../src/sync/bootstrap.js';
import { push } from '../../src/sync/push.js';
import { reconciliar } from '../../src/sync/reconcile.js';
import {
  abrirAdmin, construirIds, contar, crearNodo, hayLocal, sembrarMaestros,
  silenciarEcoDeConfiguracion, soltarNodo, vender, type Ids,
} from './harness.js';

const IDS: Ids = construirIds('e5', ['E', 'F']);
const DB_NUBE = 'donaji_reconcile_nube';
const DB_S1 = 'donaji_reconcile_s1';
const SUC = IDS.sucursales[0]!;

const run = hayLocal ? describe : describe.skip;

run('reconcile · checksum, diff dirigido y clases de conflicto', () => {
  let admin: Client;
  let nube: Client;
  let s1: Client;

  beforeAll(async () => {
    admin = await abrirAdmin();
    nube = await crearNodo(admin, DB_NUBE, { esNube: true, sucursalId: null });
    await sembrarMaestros(nube, IDS);
    s1 = await crearNodo(admin, DB_S1, { sucursalId: SUC, versionBinario: 'N' });
    const b = await bootstrap(s1, nube);
    expect(b.puedeVender).toBe(true);
    await silenciarEcoDeConfiguracion(s1);
  }, 180_000);

  afterAll(async () => {
    await s1?.end().catch(() => { /* ya cerrado */ });
    await nube?.end().catch(() => { /* ya cerrado */ });
    await soltarNodo(admin, DB_S1);
    await soltarNodo(admin, DB_NUBE);
    await admin?.end().catch(() => { /* ya cerrado */ });
  }, 120_000);

  afterEach(async () => {
    for (const c of [s1, nube]) {
      await c.query(`TRUNCATE core.venta, core.boleto CASCADE`);
      await c.query(`TRUNCATE sync.excepcion, sync.checksum_bloque`);
    }
    await s1.query(`DELETE FROM sync.outbox`);
  });

  /** Vende `n` boletos en el nodo (sin ocupación: solo interesan venta y boleto). */
  const venderN = async (n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = await vender(s1, {
        ids: IDS, sucursalId: SUC, asiento: 10 + i, tramos: '[0,3)', sinOcupacion: true,
      });
      expect(v.ok, v.motivo ?? '').toBe(true);
      ids.push(v.boletoId!);
    }
    return ids;
  };

  const divergenciasAbiertas = (c: Client): Promise<number> =>
    contar(c, `SELECT count(*) AS n FROM sync.excepcion
               WHERE tipo = 'divergencia_checksum' AND estado = 'abierta'`);

  const opts = { dias: 2 } as const;

  // -------------------------------------------------------------------------
  it('no reporta divergencia cuando el bloque está vacío en los dos lados', async () => {
    const r = await reconciliar(s1, nube, opts);
    expect(r.bloques, 'nada vendido: ningún bloque que comparar').toHaveLength(0);
    expect(r.divergentes).toHaveLength(0);
    expect(await divergenciasAbiertas(s1)).toBe(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('nombra en soloEnLocal una fila que el nodo tiene y la nube no', async () => {
    const [b1] = await venderN(2);
    await push(s1, nube, { versionNodo: 'N' });
    // La nube "pierde" un boleto que ya había recibido.
    await nube.query(`DELETE FROM core.boleto WHERE id = $1`, [b1]);

    const r = await reconciliar(s1, nube, opts);
    const bloque = r.divergentes.find((d) => d.tabla === 'core.boleto');
    expect(bloque, 'el bloque de boleto debe salir divergente').toBeDefined();
    expect(bloque!.soloEnLocal).toEqual([b1]);
    expect(bloque!.soloEnNube).toEqual([]);
    expect(bloque!.versionDistinta).toEqual([]);
    expect(bloque!.filasLocal).toBe(2);
    expect(bloque!.filasNube).toBe(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('detecta la fila que le falta al nodo tras restaurar un respaldo viejo (§8)', async () => {
    const ids = await venderN(2);
    await push(s1, nube, { versionNodo: 'N' });
    // El disco del nodo murió y se restauró un respaldo de hace unas horas: una de
    // las ventas ya subidas no está en la copia. La nube sí la tiene.
    await s1.query(`DELETE FROM core.boleto WHERE id = $1`, [ids[1]]);

    const r = await reconciliar(s1, nube, opts);
    const bloque = r.divergentes.find((d) => d.tabla === 'core.boleto');
    expect(bloque).toBeDefined();
    expect(bloque!.soloEnNube, 'la nube conserva lo que el nodo perdió').toEqual([ids[1]]);
    expect(bloque!.soloEnLocal).toEqual([]);
    // No se puede reponer desde el nodo: queda como excepción crítica para un humano.
    expect(r.reencoladas).toBe(0);
    expect(await divergenciasAbiertas(s1)).toBeGreaterThanOrEqual(1);
    const sev = await contar(s1, `SELECT count(*) AS n FROM sync.excepcion
      WHERE tipo = 'divergencia_checksum' AND severidad = 'critica'`);
    expect(sev, 'falta un dato en el nodo: crítica').toBeGreaterThanOrEqual(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('distingue divergencia de EXISTENCIA de divergencia de CONTENIDO', async () => {
    const [b1] = await venderN(1);
    await push(s1, nube, { versionNodo: 'N' });
    // Misma fila en ambos lados, pero editada en la nube: sube su `version`.
    await nube.query(
      `UPDATE core.boleto SET pasajero_nombre = 'CORREGIDO EN NUBE' WHERE id = $1`, [b1],
    );

    const r = await reconciliar(s1, nube, opts);
    const bloque = r.divergentes.find((d) => d.tabla === 'core.boleto');
    expect(bloque).toBeDefined();
    expect(bloque!.versionDistinta, 'mismo id, otra version').toEqual([b1]);
    expect(bloque!.soloEnLocal, 'no es un problema de existencia').toEqual([]);
    expect(bloque!.soloEnNube).toEqual([]);
    expect(bloque!.filasLocal).toBe(bloque!.filasNube);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('el re-push dirigido reencola solo las filas divergentes, no el día entero', async () => {
    const [b1] = await venderN(3);
    await push(s1, nube, { versionNodo: 'N' });
    await nube.query(`DELETE FROM core.boleto WHERE id = $1`, [b1]);
    await s1.query(`DELETE FROM sync.outbox`); // el push dejó todo en confirmado; partimos de cero

    const r = await reconciliar(s1, nube, opts);
    expect(r.reencoladas, 'divergía 1 de 3 boletos del día').toBe(1);

    const enOutbox = await s1.query<{ fila_id: string }>(
      `SELECT fila_id FROM sync.outbox WHERE tabla = 'core.boleto' AND estado = 'pendiente'`,
    );
    expect(enOutbox.rows.map((x) => x.fila_id)).toEqual([b1]);
  }, 60_000);

  // -------------------------------------------------------------------------
  it('abre una excepción `divergencia_checksum` con el bloque exacto', async () => {
    const [b1] = await venderN(2);
    await push(s1, nube, { versionNodo: 'N' });
    await nube.query(`DELETE FROM core.boleto WHERE id = $1`, [b1]);

    await reconciliar(s1, nube, opts);

    const { rows } = await s1.query<{ entidad: string; detalle: Record<string, unknown> }>(
      `SELECT entidad, detalle FROM sync.excepcion
        WHERE tipo = 'divergencia_checksum' AND estado = 'abierta'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entidad).toBe('core.boleto');
    expect(rows[0]!.detalle['dia'], 'el día operativo del bloque').toBeDefined();
    expect(rows[0]!.detalle['solo_en_local']).toEqual([b1]);
    expect(rows[0]!.detalle['faltan_en_nube']).toBe(1);
  }, 60_000);
});
