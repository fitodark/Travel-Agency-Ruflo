/**
 * Contrato de los módulos del motor que todavía no existen.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.3, §6, §6.1
 *                  docs/architecture/01b-consistencia-asientos.md §5, §6, §7
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F1)
 *
 * `src/sync/engine.ts`, `src/sync/reconcile.ts` y `src/sync/salud.ts` están en
 * construcción. Este archivo define, DESDE LA PRUEBA, la superficie que necesitan para
 * ser probables — que no es lo mismo que la superficie que necesitan para funcionar.
 *
 * Todo aquí es `it.todo`: no se ejecuta y no rompe la suite. Cuando los módulos
 * aterricen, cada `it.todo` se convierte en una prueba y el bloque de tipos de abajo
 * se BORRA en favor de los tipos reales.
 *
 * ---------------------------------------------------------------------------------
 * TRES EXIGENCIAS DE DISEÑO, ANTES QUE CUALQUIER FIRMA
 *
 * 1. `ahora()` inyectable en el motor. Sin eso, probar "72 h sin sync -> modo
 *    degradado" o "backoff a los 5 min" exige esperar horas de reloj, y esas pruebas
 *    acaban borrándose. El motor no debe llamar a `Date.now()` directamente nunca.
 *
 * 2. El arbitraje debe ser una FUNCIÓN PURA sobre datos, no un procedimiento que
 *    consulte la base. 01b §6 exige que "ambos nodos calculen el mismo ganador": eso
 *    solo es verificable si se le pueden dar las mismas entradas a dos llamadas y
 *    comparar. Si el arbitraje vive dentro de un `UPDATE ... RETURNING`, la propiedad
 *    central del sistema deja de ser comprobable.
 *
 * 3. La conexión a la nube debe entrar como FÁBRICA (`() => Promise<Client>`), no como
 *    `Client` ya abierto. El motor tiene que sobrevivir a que la nube no exista al
 *    arrancar —que es el caso normal en una terminal que enciende sin internet— y a
 *    reconectar después sin reiniciar el proceso.
 * ---------------------------------------------------------------------------------
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import type { Client } from 'pg';
import {
  clasificarDeriva, medirDeriva, medirSalud, registrarDeriva, registrarRespaldo, reportarSalud,
} from '../../src/sync/salud.js';
import {
  arbitrar, compararOcupaciones, prioridadDe, type Ocupacion,
} from '../../src/sync/arbitraje.js';
import { elegirAsientoReasignado, type MapaUnidad } from '../../src/sync/reasignacion.js';
import {
  abrirAdmin, abrirLocal, construirIds, crearNodo, hayLocal, sembrarMaestros, soltarNodo, type Ids,
} from './harness.js';

// ===========================================================================
// CONTRATO — los módulos ya aterrizaron; aquí solo quedan punteros.
// ===========================================================================

// `src/sync/engine.ts` ATERRIZÓ como la clase `SyncEngine` (toma dos `Client`
// abiertos; `src/sync/servicio.ts` los reconecta) con `calcularBackoff` puro,
// `ciclo()`, `pushInmediato()`, `snapshot` y `modo`. Sus 12 pruebas —cadencia,
// backoff, `sin_red`, degradado, dos motores— viven en `tests/sync/engine.test.ts`.

/** `src/sync/reconcile.ts` */
export namespace ContratoReconcile {
  // ---- Checksum y diff dirigido (§6.1) ----
  // ATERRIZÓ en `src/sync/reconcile.ts` (`reconciliar`, `BloqueChecksum` con
  // `soloEnLocal` / `soloEnNube` / `versionDistinta`) apoyado en
  // `sync.filas_bloque` (migración 0033). Sus pruebas viven en
  // `tests/sync/reconcile.test.ts`.

  // ---- Arbitraje determinista (01b §6) ----
  // ATERRIZÓ en `src/sync/arbitraje.ts` (`prioridadDe`, `compararOcupaciones`,
  // `arbitrar`, `resolverConflictoAsiento`). Sus pruebas viven más abajo (las
  // puras) y en `tests/sync/arbitraje.test.ts` (la aplicación a la base).

  // ---- Reasignación del perdedor (01b §7) ----
  // ATERRIZÓ en `src/sync/reasignacion.ts` (`elegirAsientoReasignado` puro,
  // `proponerReasignacion` y `reasignarPerdedores`). Pruebas puras abajo; la
  // aplicación a la base en `tests/sync/reasignacion.test.ts`.
}

// `src/sync/salud.ts` ATERRIZÓ: sus tipos reales viven ahí y sus pruebas están
// más abajo, ya ejecutables. El contrato propuesto se borró.

// ===========================================================================
// Propiedades PURAS del arbitraje y la reasignación. El resto de los módulos
// del motor tiene sus pruebas en archivos propios (ver punteros arriba).
// ===========================================================================

describe('src/sync/reconcile.ts — checksum y clases de conflicto', () => {
  // El checksum, el diff fila a fila (`soloEnLocal` / `soloEnNube` /
  // `versionDistinta`) y el re-push dirigido ATERRIZARON: sus pruebas están en
  // `tests/sync/reconcile.test.ts`.

  // El corazón de F0 y de F4. La APLICACIÓN a la base (el perdedor pasa a
  // `conflicto`, su boleto a `conflicto_sobreventa`, sin borrarse) vive en
  // `tests/sync/arbitraje.test.ts`. Aquí, las propiedades PURAS.
  it('ARBITRAJE · dos nodos con los mismos datos calculan el MISMO ganador', () => {
    const base: Omit<Ocupacion, 'id' | 'boletoId' | 'sucursalId'> = {
      salidaId: 's', asientoNum: 7, tramos: '[0,3)',
      emitidoEn: new Date('2026-09-01T10:00:00Z'),
      impreso: false, pagado: true, abonoParcial: false,
    };
    const a: Ocupacion = { ...base, id: 'o1', boletoId: 'b1', sucursalId: 'AAA' };
    const b: Ocupacion = {
      ...base, id: 'o2', boletoId: 'b2', sucursalId: 'BBB',
      emitidoEn: new Date('2026-09-01T10:05:00Z'),
    };
    const nodo1 = arbitrar([a, b]);
    const nodo2 = arbitrar([b, a]);
    expect(nodo1.gana.id).toBe(nodo2.gana.id);
    expect(nodo1.gana.id).toBe('o1');
  });

  it('ARBITRAJE · gana el boleto pagado e impreso sobre el pagado sin imprimir', () => {
    const impreso: Ocupacion = {
      id: 'o1', boletoId: 'b1', sucursalId: 'A', salidaId: 's', asientoNum: 7, tramos: '[0,3)',
      emitidoEn: new Date('2026-09-01T12:00:00Z'), impreso: true, pagado: true, abonoParcial: false,
    };
    const soloPagado: Ocupacion = {
      ...impreso, id: 'o2', boletoId: 'b2', sucursalId: 'B', impreso: false,
      emitidoEn: new Date('2026-09-01T09:00:00Z'),  // más antiguo, pero no impreso
    };
    expect(prioridadDe(impreso)).toBe(1);
    expect(prioridadDe(soloPagado)).toBe(2);
    expect(arbitrar([soloPagado, impreso]).gana.id).toBe('o1');
  });

  it('ARBITRAJE · gana el pagado sobre el abono parcial, y el abono sobre la reservación', () => {
    const mk = (id: string, p: Partial<Ocupacion>): Ocupacion => ({
      id, boletoId: `b${id}`, sucursalId: 'A', salidaId: 's', asientoNum: 7, tramos: '[0,3)',
      emitidoEn: new Date('2026-09-01T10:00:00Z'), impreso: false, pagado: false, abonoParcial: false,
      ...p,
    });
    const pagado = mk('1', { pagado: true });
    const abono = mk('2', { abonoParcial: true });
    const reserva = mk('3', {});
    expect([prioridadDe(pagado), prioridadDe(abono), prioridadDe(reserva)]).toEqual([2, 3, 4]);
    expect(arbitrar([reserva, abono, pagado]).gana.id).toBe('1');
    expect(arbitrar([reserva, abono]).gana.id).toBe('2');
  });

  it('ARBITRAJE · a igual prioridad gana el `emitido_en` más antiguo', () => {
    const mk = (id: string, iso: string): Ocupacion => ({
      id, boletoId: `b${id}`, sucursalId: 'A', salidaId: 's', asientoNum: 7, tramos: '[0,3)',
      emitidoEn: new Date(iso), impreso: false, pagado: true, abonoParcial: false,
    });
    const tarde = mk('tarde', '2026-09-01T10:10:00Z');
    const temprano = mk('temprano', '2026-09-01T10:00:00Z');
    expect(arbitrar([tarde, temprano]).gana.id).toBe('temprano');
  });

  it('ARBITRAJE · a igual emisión desempata por sucursal y luego por boleto, de forma estable', () => {
    const base = {
      salidaId: 's', asientoNum: 7, tramos: '[0,3)',
      emitidoEn: new Date('2026-09-01T10:00:00Z'),
      impreso: false, pagado: true, abonoParcial: false,
    } as const;
    const sucA: Ocupacion = { ...base, id: 'o1', boletoId: 'bZ', sucursalId: 'AAA' };
    const sucB: Ocupacion = { ...base, id: 'o2', boletoId: 'bA', sucursalId: 'BBB' };
    expect(arbitrar([sucB, sucA]).gana.sucursalId).toBe('AAA');

    const mismaSuc1: Ocupacion = { ...base, id: 'o3', boletoId: 'b111', sucursalId: 'X' };
    const mismaSuc2: Ocupacion = { ...base, id: 'o4', boletoId: 'b999', sucursalId: 'X' };
    expect(arbitrar([mismaSuc2, mismaSuc1]).gana.boletoId).toBe('b111');
  });

  it('ARBITRAJE · el resultado NO cambia si se invierte el orden de llegada a la nube', () => {
    const mk = (id: string, suc: string, iso: string, pagado: boolean): Ocupacion => ({
      id, boletoId: `b${id}`, sucursalId: suc, salidaId: 's', asientoNum: 7, tramos: '[0,3)',
      emitidoEn: new Date(iso), impreso: false, pagado, abonoParcial: false,
    });
    const cs = [
      mk('1', 'C', '2026-09-01T10:03:00Z', false),
      mk('2', 'A', '2026-09-01T10:01:00Z', true),
      mk('3', 'B', '2026-09-01T10:02:00Z', true),
    ];
    const g1 = arbitrar(cs).gana.id;
    const g2 = arbitrar([...cs].reverse()).gana.id;
    const g3 = arbitrar([cs[2]!, cs[0]!, cs[1]!]).gana.id;
    expect([g2, g3]).toEqual([g1, g1]);
    expect(g1).toBe('2');  // pagado + emitido_en más antiguo entre los pagados
  });

  it('ARBITRAJE · es total: nunca devuelve empate para dos ocupaciones distintas', () => {
    const gemelas = (id: string): Ocupacion => ({
      id, boletoId: 'b', sucursalId: 'S', salidaId: 's', asientoNum: 7, tramos: '[0,3)',
      emitidoEn: new Date('2026-09-01T10:00:00Z'), impreso: false, pagado: true, abonoParcial: false,
    });
    // Iguales en todo salvo el id de la ocupación: el comparador aún desempata.
    expect(compararOcupaciones(gemelas('o1'), gemelas('o2'))).toBeLessThan(0);
    expect(compararOcupaciones(gemelas('o2'), gemelas('o1'))).toBeGreaterThan(0);
    expect(compararOcupaciones(gemelas('o1'), gemelas('o1'))).toBe(0);
  });

  // REASIGNACIÓN (01b §7): las propiedades PURAS de `elegirAsientoReasignado`.
  // La aplicación a la base — folio intacto, nota_auditoria, reimpresión
  // encolada, excepción alta con la unidad llena — está en
  // `tests/sync/reasignacion.test.ts`.
  const MAPA_MINI: MapaUnidad = {
    asientos: [
      { num: 1, fila: 0, col: 0 }, { num: 2, fila: 0, col: 1 }, { num: 3, fila: 0, col: 3 },
      { num: 4, fila: 1, col: 0 }, { num: 5, fila: 1, col: 1 }, { num: 6, fila: 1, col: 3 },
    ],
    bloques: [
      { clave: 'X0', asientos: [1, 2, 3] },
      { clave: 'X1', asientos: [4, 5, 6] },
    ],
  };

  it('REASIGNACIÓN · prefiere otro asiento del MISMO bloque', () => {
    // Pierde el 1 (bloque X0 = {1,2,3}). El 2 está libre, y también el 5 (otro bloque).
    const e = elegirAsientoReasignado(MAPA_MINI, 1, [2, 5], []);
    expect(e).toEqual({ asiento: 2, motivo: 'mismo_bloque' });
  });

  it('REASIGNACIÓN · si no hay en el bloque, uno adyacente a un acompañante', () => {
    // Pierde el 1; su bloque X0 no tiene libres salvo él. Acompañante en el 4
    // (fila 1, col 0); el 5 (fila 1, col 1) es contiguo. El 6 también libre pero
    // no adyacente (col 3, con pasillo).
    const e = elegirAsientoReasignado(MAPA_MINI, 1, [5, 6], [4]);
    expect(e).toEqual({ asiento: 5, motivo: 'adyacente_a_acompanante' });
  });

  it('REASIGNACIÓN · si no hay ni bloque ni adyacente, cualquiera libre', () => {
    const e = elegirAsientoReasignado(MAPA_MINI, 1, [6], []);
    expect(e).toEqual({ asiento: 6, motivo: 'cualquiera' });
  });

  it('REASIGNACIÓN · con la unidad llena devuelve null', () => {
    expect(elegirAsientoReasignado(MAPA_MINI, 1, [], [])).toBeNull();
    expect(elegirAsientoReasignado(MAPA_MINI, 1, [1], []), 'solo el propio no cuenta').toBeNull();
  });
});

const IDS_SALUD: Ids = construirIds('d4', ['H']);
const DB_SALUD_NODO = 'donaji_salud_nodo';
const DB_SALUD_NUBE = 'donaji_salud_nube';
const runSalud = hayLocal ? describe : describe.skip;

runSalud('src/sync/salud.ts — tablero de diagnóstico remoto', () => {
  let admin: Client;
  let node: Client;
  let nube: Client;
  const sucursal = IDS_SALUD.sucursales[0]!;

  const filaOutbox = async (
    estado: string, intentos: number, creadoEn?: string,
  ): Promise<void> => {
    await node.query(
      `INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt, estado, intentos, creado_en)
       VALUES ('core.venta', core.uuid_v7(), '{}'::jsonb, now(), 0, $1, $2, coalesce($3::timestamptz, now()))`,
      [estado, intentos, creadoEn ?? null],
    );
  };

  const abrirExcepcion = async (severidad: string, estado: string): Promise<void> => {
    await node.query(
      `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, estado)
       VALUES ('rechazo_ingesta', $1, sync.sucursal_local(), $2)`,
      [severidad, estado],
    );
  };

  const fijarUltimaSync = async (cuando: Date | null): Promise<void> => {
    await node.query(
      `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa)
       VALUES (sync.sucursal_local(), $1)
       ON CONFLICT (sucursal_id) DO UPDATE SET ultima_sync_exitosa = EXCLUDED.ultima_sync_exitosa`,
      [cuando],
    );
  };

  beforeAll(async () => {
    admin = await abrirAdmin();
    nube = await crearNodo(admin, DB_SALUD_NUBE, { esNube: true, sucursalId: null });
    await sembrarMaestros(nube, IDS_SALUD);
    node = await crearNodo(admin, DB_SALUD_NODO, {
      sucursalId: sucursal, versionBinario: 'N-test',
    });
  }, 120_000);

  afterAll(async () => {
    await node?.end().catch(() => { /* ya cerrado */ });
    await nube?.end().catch(() => { /* ya cerrado */ });
    await soltarNodo(admin, DB_SALUD_NODO);
    await soltarNodo(admin, DB_SALUD_NUBE);
    await admin?.end().catch(() => { /* ya cerrado */ });
  }, 120_000);

  afterEach(async () => {
    await node.query(
      `TRUNCATE sync.outbox, sync.excepcion, sync.respaldo, sync.checksum_bloque, sync.salud`,
    );
    await node.query(
      `UPDATE sync.config_aplicado
          SET ultima_pasada = NULL, ultima_epoca = NULL, sesiones_cerradas_total = 0`,
    );
  });

  it('separa outbox pendiente de outbox atascado: hoy el operador no puede distinguirlos', async () => {
    await filaOutbox('pendiente', 0);
    await filaOutbox('enviado', 1);
    await filaOutbox('confirmado', 9);      // ya subió: no cuenta, aunque tenga muchos intentos
    await filaOutbox('rechazado', 2);       // atascado por estado
    await filaOutbox('pendiente', 8);       // atascado por intentos

    const s = await medirSalud(node);
    expect(s.outboxPendiente, 'lo que todavía puede subir solo').toBe(2);
    expect(s.outboxAtascado, 'lo rechazado o con demasiados intentos').toBe(2);
  });

  it('reporta la antigüedad de la fila más vieja sin subir, que es la exposición real', async () => {
    await filaOutbox('confirmado', 0, '2020-01-01T00:00:00Z');  // vieja pero ya subió: no cuenta
    await filaOutbox('pendiente', 0, '2026-08-20T10:00:00Z');
    await filaOutbox('enviado', 0, '2026-08-25T10:00:00Z');

    const s = await medirSalud(node);
    expect(s.outboxMasAntiguoEn?.toISOString()).toBe('2026-08-20T10:00:00.000Z');
  });

  it('reporta versión de esquema y de binario por nodo (D-8)', async () => {
    const s = await medirSalud(node);
    expect(s.versionBinario, 'la versión del binario instalado').toBe('N-test');
    expect(s.versionEsquema, 'la última migración aplicada').toMatch(/^\d{4}_/);
  });

  it('marca `degradado` a las 72 h sin sync exitosa', async () => {
    const ahora = new Date('2026-08-27T12:00:00Z');
    const ahoraFn = (): Date => ahora;

    await fijarUltimaSync(null);
    expect(
      (await medirSalud(node, { ahora: ahoraFn })).degradado,
      'un nodo que nunca sincronizó está empezando, no degradado',
    ).toBe(false);

    await fijarUltimaSync(new Date(ahora.getTime() - 71 * 60 * 60 * 1000));
    expect((await medirSalud(node, { ahora: ahoraFn })).degradado, 'a 71 h todavía no').toBe(false);

    await fijarUltimaSync(new Date(ahora.getTime() - 73 * 60 * 60 * 1000));
    expect((await medirSalud(node, { ahora: ahoraFn })).degradado, 'a 73 h sí').toBe(true);
  });

  it('cuenta excepciones abiertas por severidad, no solo el total', async () => {
    await abrirExcepcion('critica', 'abierta');
    await abrirExcepcion('critica', 'abierta');
    await abrirExcepcion('alta', 'abierta');
    await abrirExcepcion('media', 'resuelta');   // no cuenta: no está abierta
    await abrirExcepcion('baja', 'descartada');  // idem

    const s = await medirSalud(node);
    expect(s.excepcionesAbiertas).toEqual({ critica: 2, alta: 1, media: 0, baja: 0 });
  });

  it('reporta la antigüedad del último respaldo local: con una sola PC es la única defensa (R2)', async () => {
    expect((await medirSalud(node)).ultimoRespaldoEn, 'sin respaldos aún').toBeNull();

    await registrarRespaldo(node, { archivo: 'donaji-SA-viejo.dump', bytes: 1, versionEsquema: '0015_x' });
    await new Promise((r) => setTimeout(r, 10));
    await registrarRespaldo(node, { archivo: 'donaji-SA-nuevo.dump', bytes: 2, versionEsquema: '0015_x' });

    const s = await medirSalud(node);
    expect(s.ultimoRespaldoEn, 'toma el más reciente').not.toBeNull();
    expect(Date.now() - s.ultimoRespaldoEn!.getTime(), 'y es de hace un instante').toBeLessThan(60_000);
  });

  it('reporta cuándo corrió el aplicador de configuración por última vez (03 §3.3)', async () => {
    expect((await medirSalud(node)).ultimaPasadaAplicador, 'aún no ha corrido').toBeNull();

    await node.query(
      `UPDATE sync.config_aplicado SET ultima_pasada = now() WHERE singleton`,
    );
    const s = await medirSalud(node);
    expect(s.ultimaPasadaAplicador).not.toBeNull();
    expect(Date.now() - s.ultimaPasadaAplicador!.getTime()).toBeLessThan(60_000);
  });

  it('DERIVA · clasifica la deriva en ok/alerta/degradado/fuera_de_zona_muerta según 01b §4', () => {
    expect(clasificarDeriva(0)).toBe('ok');
    expect(clasificarDeriva(2 * 60)).toBe('ok');
    expect(clasificarDeriva(-2 * 60), 'el signo no importa para la clase').toBe('ok');
    expect(clasificarDeriva(5 * 60)).toBe('alerta');
    expect(clasificarDeriva(10 * 60)).toBe('degradado');
    expect(clasificarDeriva(16 * 60)).toBe('fuera_de_zona_muerta');
    expect(clasificarDeriva(-16 * 60)).toBe('fuera_de_zona_muerta');
  });

  it('DERIVA · mide contra el reloj de la NUBE, no contra el del propio nodo', async () => {
    // Dos Postgres locales comparten reloj de pared: la deriva real es ~0. Lo que
    // se verifica es que la medición cruza a la nube y no se limita a leer
    // `sync.salud`, que aquí está vacío.
    await node.query(
      `INSERT INTO sync.salud (sucursal_id, deriva_reloj_seg)
       VALUES (sync.sucursal_local(), 9999)`,
    );
    const d = await medirDeriva(node, nube);
    expect(typeof d).toBe('number');
    expect(Math.abs(d), 'reloj compartido: deriva cercana a cero').toBeLessThan(10);
    expect(d, 'no devolvió el 9999 que hay en sync.salud').not.toBe(9999);
  });

  it('DERIVA · más de 15 min abre excepción `deriva_reloj` porque la zona muerta ya no protege', async () => {
    await registrarDeriva(node, 3 * 60);
    expect(
      (await medirSalud(node)).excepcionesAbiertas.alta,
      'dentro de la zona muerta no abre nada',
    ).toBe(0);
    expect((await medirSalud(node)).derivaRelojSeg, 'pero sí deja registrada la medición').toBe(180);

    await registrarDeriva(node, 16 * 60);
    await registrarDeriva(node, 20 * 60);  // segunda pasada: NO debe duplicar

    const { rows } = await node.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.excepcion
        WHERE tipo = 'deriva_reloj' AND estado = 'abierta'`,
    );
    expect(Number(rows[0]!.n), 'una sola excepción abierta, deduplicada').toBe(1);

    const s = await medirSalud(node);
    expect(s.claseDeriva).toBe('fuera_de_zona_muerta');
    expect(s.excepcionesAbiertas.alta).toBe(1);
  });

  it('`reportarSalud` sobrevive a que la nube esté caída sin perder la medición local', async () => {
    // Un cliente ya cerrado: cualquier `query` sobre él lanza de inmediato, igual
    // que una nube inalcanzable, y sin el timeout de intentar conectar a la nada.
    const nubeCaida = await abrirLocal(DB_SALUD_NUBE);
    await nubeCaida.end();

    await filaOutbox('pendiente', 0);
    await expect(reportarSalud(node, nubeCaida), 'no propaga el fallo de la nube').resolves.toBeUndefined();

    // La medición local siguió funcionando después.
    const s = await medirSalud(node);
    expect(s.outboxPendiente).toBe(1);
  });
});
