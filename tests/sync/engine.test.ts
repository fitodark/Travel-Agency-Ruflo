/**
 * `src/sync/engine.ts` — ciclo, cadencia, backoff y modo degradado.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.3
 *                  docs/architecture/03-...-degradado §1.5
 *
 * Estas pruebas eran los 12 `it.todo` de `motor-pendiente.test.ts`. El motor
 * ATERRIZÓ como la clase `SyncEngine` (no `crearMotor`): toma dos `Client` ya
 * abiertos y `src/sync/servicio.ts` es quien los reconecta. `ciclo()` corre un
 * push y un pull y resuelve al terminar — así las pruebas no dependen de timers.
 *
 * NUBE SIMULADA: base local `es_nube = true`, mismas migraciones.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import type { Client } from 'pg';
import { bootstrap } from '../../src/sync/bootstrap.js';
import { SyncEngine, calcularBackoff } from '../../src/sync/engine.js';
import { outboxPendiente } from '../../src/sync/push.js';
import {
  abrirAdmin, abrirLocal, construirIds, contar, crearNodo, hayLocal, sembrarMaestros,
  silenciarEcoDeConfiguracion, soltarNodo, vender, type Ids,
} from './harness.js';

const IDS: Ids = construirIds('e6', ['G', 'H']);
const DB_NUBE = 'donaji_engine_nube';
const DB_S1 = 'donaji_engine_s1';
const SUC = IDS.sucursales[0]!;

const run = hayLocal ? describe : describe.skip;

run('engine · ciclo, cadencia y backoff', () => {
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
    // Resiliente: si un test dejó una conexión rara, que un fallo de limpieza no
    // arrastre a los siguientes.
    const q = async (c: Client, sql: string): Promise<void> => {
      await c.query(sql).catch(() => { /* mejor esfuerzo */ });
    };
    await q(s1, `TRUNCATE core.venta, core.boleto CASCADE`);
    await q(nube, `TRUNCATE core.venta, core.boleto CASCADE`);
    await q(s1, `DELETE FROM sync.outbox`);
    await q(s1, `TRUNCATE sync.salud, sync.excepcion, sync.cursor`);
    await q(nube, `DELETE FROM sync.cambio_log WHERE tabla LIKE 'core.%_poison'`);
  });

  let asiento = 20;
  const venderUno = async (): Promise<string> => {
    const v = await vender(s1, {
      ids: IDS, sucursalId: SUC, asiento: asiento++, tramos: '[0,3)', sinOcupacion: true,
    });
    expect(v.ok, v.motivo ?? '').toBe(true);
    return v.ventaId!;
  };

  // -------------------------------------------------------------------------
  it('respeta la cadencia del §3.3: push mucho más frecuente que pull', async () => {
    let pushes = 0;
    let pulls = 0;
    const engine = new SyncEngine(s1, nube, { pushIntervalMs: 40, pullIntervalMs: 220 });
    engine.observar((ev) => {
      if (ev.tipo === 'push_ok') pushes++;
      if (ev.tipo === 'pull_ok') pulls++;
    });

    await engine.iniciar();
    await new Promise((r) => setTimeout(r, 700));
    await engine.detener();

    expect(pushes, 'al menos ~10 pushes en 700 ms a 40 ms').toBeGreaterThanOrEqual(5);
    expect(pulls, 'y algún pull').toBeGreaterThanOrEqual(2);
    expect(pushes).toBeGreaterThan(pulls);
  }, 30_000);

  // -------------------------------------------------------------------------
  it('dispara un push inmediato tras una venta, sin esperar el tick', async () => {
    const ventaId = await venderUno();
    const engine = new SyncEngine(s1, nube, { pushIntervalMs: 999_999 });

    const r = await engine.pushInmediato();
    expect(r?.aceptadas).toBeGreaterThanOrEqual(1);

    const enNube = await contar(nube, `SELECT count(*) AS n FROM core.venta WHERE id = $1`, [ventaId]);
    expect(enNube, 'la venta llegó a la nube de inmediato').toBe(1);
    expect(engine.snapshot.ciclosPush).toBe(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  it('con la nube caída no lanza: acumula en outbox y el modo queda `sin_red`', async () => {
    await venderUno();
    const nubeCaida = await abrirLocal(DB_NUBE);
    await nubeCaida.end();
    const engine = new SyncEngine(s1, nubeCaida, { pushIntervalMs: 999_999 });

    const res = await engine.ciclo();
    expect(res.error, 'el ciclo reporta el fallo, no lo lanza').not.toBeNull();
    expect(res.push, 'push no completó').toBeNull();
    expect(engine.modo).toBe('sin_red');
    expect(engine.snapshot.fallosConsecutivos).toBeGreaterThan(0);
    expect(await outboxPendiente(s1), 'la venta sigue en el outbox, no se perdió').toBeGreaterThanOrEqual(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  it('el backoff crece de forma monótona y se topa en backoffMaxMs (puro)', () => {
    const base = 1_000;
    const max = 300_000;
    const sinJitter = (): number => 0.5;
    const serie = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => calcularBackoff(n, base, max, sinJitter));

    for (let i = 1; i < serie.length; i++) {
      expect(serie[i]!, `intento ${i + 1} ≥ intento ${i}`).toBeGreaterThanOrEqual(serie[i - 1]!);
    }
    expect(calcularBackoff(1, base, max, sinJitter)).toBe(base);
    expect(calcularBackoff(50, base, max, sinJitter), 'topado').toBe(max);
    expect(calcularBackoff(0, base, max, sinJitter), 'sin fallos, sin espera').toBe(0);
  });

  // -------------------------------------------------------------------------
  it('el backoff se reinicia tras el primer ciclo exitoso', async () => {
    await venderUno();
    // Conexiones dedicadas: el push se rompe bloqueando `sync.lote_recibido` en la
    // nube (lo consulta `sync.ingest_batch` antes del bucle de filas, fuera del
    // `EXCEPTION WHEN OTHERS` de `ingest_fila`, así que el error SÍ propaga). Nada
    // de esto toca la conexión `nube` compartida.
    const cloudLento = await abrirLocal(DB_NUBE);
    const bloqueador = await abrirLocal(DB_NUBE);
    try {
      await cloudLento.query(`SET lock_timeout = '150ms'`);
      const engine = new SyncEngine(s1, cloudLento, { pushIntervalMs: 999_999 });

      await bloqueador.query('BEGIN');
      await bloqueador.query('LOCK TABLE sync.lote_recibido IN ACCESS EXCLUSIVE MODE');
      await engine.pushInmediato(); // el push espera el lock, se rinde y falla
      expect(engine.snapshot.fallosConsecutivos, 'falló').toBeGreaterThan(0);
      expect(engine.snapshot.esperaBackoffMs, 'con backoff pendiente').toBeGreaterThan(0);

      await bloqueador.query('ROLLBACK'); // libera el lock
      await engine.pushInmediato();
      expect(engine.snapshot.fallosConsecutivos, 'reseteado tras el éxito').toBe(0);
      expect(engine.snapshot.esperaBackoffMs).toBe(0);
    } finally {
      await bloqueador.query('ROLLBACK').catch(() => { /* ya cerrado */ });
      await bloqueador.end().catch(() => { /* ya cerrado */ });
      await cloudLento.end().catch(() => { /* ya cerrado */ });
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  it('al reconectar tras un corte largo drena en lotes sin un solo lote gigante', async () => {
    for (let i = 0; i < 12; i++) await venderUno(); // 12 venta + 12 boleto = 24 filas
    const engine = new SyncEngine(s1, nube, { batchSize: 5, pushIntervalMs: 999_999 });

    const res = await engine.ciclo();
    expect(res.push!.lotes, '24 filas / 5 por lote').toBeGreaterThanOrEqual(3);
    expect(res.push!.aceptadas).toBe(24);
    expect(await contar(nube, `SELECT count(*) AS n FROM core.boleto`), 'todo llegó').toBe(12);
    expect(await outboxPendiente(s1)).toBe(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  it('`detener()` espera al ciclo en curso: no deja un lote a medias', async () => {
    for (let i = 0; i < 30; i++) await venderUno();
    const engine = new SyncEngine(s1, nube, { batchSize: 3, pushIntervalMs: 5 });

    await engine.iniciar();
    await new Promise((r) => setTimeout(r, 40)); // deja arrancar un push
    await engine.detener();

    // Si `detener` cortara a media corrida, quedarían filas sin confirmar y el
    // outbox no estaría en cero tras un push que sí terminó.
    expect(engine.snapshot.ciclosPush).toBeGreaterThanOrEqual(1);
    expect(await outboxPendiente(s1), 'el push en curso terminó su trabajo').toBe(0);
    expect(await contar(nube, `SELECT count(*) AS n FROM core.venta`)).toBe(30);
  }, 30_000);

  // -------------------------------------------------------------------------
  it('dos motores sobre el mismo nodo no envían el mismo renglón dos veces', async () => {
    const ventaId = await venderUno();
    // Cada motor con SU propia conexión al nodo y a la nube (como serían dos
    // procesos): el `FOR UPDATE SKIP LOCKED` del outbox es lo que se prueba.
    const s1b = await abrirLocal(DB_S1);
    const nube2 = await abrirLocal(DB_NUBE);
    try {
      const e1 = new SyncEngine(s1, nube, { pushIntervalMs: 999_999 });
      const e2 = new SyncEngine(s1b, nube2, { pushIntervalMs: 999_999 });
      await Promise.all([e1.pushInmediato(), e2.pushInmediato()]);

      expect(
        await contar(nube, `SELECT count(*) AS n FROM core.venta WHERE id = $1`, [ventaId]),
        'una sola fila en la nube',
      ).toBe(1);
      expect(
        await contar(s1, `SELECT count(*) AS n FROM sync.outbox WHERE fila_id = $1 AND estado <> 'confirmado'`, [ventaId]),
        'confirmada una sola vez',
      ).toBe(0);
    } finally {
      await s1b.end().catch(() => { /* ya cerrado */ });
      await nube2.end().catch(() => { /* ya cerrado */ });
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  it('con `ahora()` desplazado 73 h el modo pasa a `degradado` sin esperar tres días', async () => {
    const ancla = new Date('2026-06-15T12:00:00Z');
    await s1.query(
      `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa)
       VALUES (sync.sucursal_local(), $1)
       ON CONFLICT (sucursal_id) DO UPDATE SET ultima_sync_exitosa = EXCLUDED.ultima_sync_exitosa`,
      [ancla],
    );
    const engine = new SyncEngine(s1, nube, {
      pushIntervalMs: 999_999,
      now: () => ancla.getTime() + 73 * 3_600_000,
    });

    await engine.iniciar();
    await engine.detener();

    expect(engine.snapshot.degradado).toBe(true);
    expect(engine.modo).toBe('degradado');
  }, 30_000);

  // -------------------------------------------------------------------------
  it('en modo degradado sigue drenando el outbox: degradar no es dejar de sincronizar', async () => {
    const ancla = new Date('2026-06-15T12:00:00Z');
    await s1.query(
      `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa)
       VALUES (sync.sucursal_local(), $1)
       ON CONFLICT (sucursal_id) DO UPDATE SET ultima_sync_exitosa = EXCLUDED.ultima_sync_exitosa`,
      [ancla],
    );
    const engine = new SyncEngine(s1, nube, {
      pushIntervalMs: 999_999,
      now: () => ancla.getTime() + 80 * 3_600_000,
    });
    await engine.iniciar();
    await engine.detener();
    expect(engine.snapshot.degradado, 'arranca degradado').toBe(true);

    const ventaId = await venderUno();
    const res = await engine.ciclo();
    expect(res.push!.aceptadas).toBeGreaterThanOrEqual(1);
    expect(
      await contar(nube, `SELECT count(*) AS n FROM core.venta WHERE id = $1`, [ventaId]),
      'la venta llegó a la nube pese al modo degradado',
    ).toBe(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  it('un error en el pull no impide el push del mismo ciclo', async () => {
    const ventaId = await venderUno();
    // Fila de bajada envenenada: `id` que no es un uuid → `sync.ingest_fila` lanza.
    await nube.query(
      `INSERT INTO sync.cambio_log (tabla, fila_id, payload)
       VALUES ('core.parametro_poison', core.uuid_v7(), '{"id":"no-soy-uuid"}'::jsonb)`,
    );
    const engine = new SyncEngine(s1, nube, { pushIntervalMs: 999_999 });

    const res = await engine.ciclo();

    expect(res.push?.aceptadas, 'el push del ciclo sí completó').toBeGreaterThanOrEqual(1);
    expect(
      await contar(nube, `SELECT count(*) AS n FROM core.venta WHERE id = $1`, [ventaId]),
    ).toBe(1);
    expect(res.pull, 'el pull falló').toBeNull();
    expect(res.error).not.toBeNull();
  }, 30_000);

  // -------------------------------------------------------------------------
  // El "catch-up de pull ANTES de vender fuera de cupo" (§3.3) NO es una
  // propiedad solo del motor: exige que el camino de venta consulte una señal
  // ("¿el nodo está al día con el cupo?") y bloquee el override si no. El motor
  // ya expone `modo === 'degradado'` y `snapshot.ultimaSyncExitosa`; falta el
  // enganche en `src/ventas/`. Queda como `it.todo` hasta esa decisión.
  it.todo('hace catch-up de pull ANTES de permitir vender asientos fuera de cupo (§3.3)');
});
