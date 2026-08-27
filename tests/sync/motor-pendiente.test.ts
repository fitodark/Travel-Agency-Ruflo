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
import type { PullResult } from '../../src/sync/pull.js';
import type { PushResult } from '../../src/sync/push.js';
import {
  clasificarDeriva, medirDeriva, medirSalud, registrarDeriva, registrarRespaldo, reportarSalud,
} from '../../src/sync/salud.js';
import {
  abrirAdmin, abrirLocal, construirIds, crearNodo, hayLocal, sembrarMaestros, soltarNodo, type Ids,
} from './harness.js';

// ===========================================================================
// PROPUESTA DE CONTRATO — borrar cuando existan los módulos reales
// ===========================================================================

/** `src/sync/engine.ts` */
export namespace ContratoEngine {
  export type Estado = 'detenido' | 'inactivo' | 'sincronizando' | 'sin_red' | 'degradado';

  /** Cadencia del §3.3. Todo en milisegundos salvo lo que diga otra cosa. */
  export interface Cadencia {
    pushMs: number;              // 5_000 en operación normal
    pullMs: number;              // 30_000 en operación normal
    loteDrenaje: number;         // 500 al reconectar tras un corte largo
    backoffInicialMs: number;    // 1_000
    backoffMaxMs: number;        // 300_000, para no martillar una nube caída
    degradadoTrasHoras: number;  // 72 (03 §1.5)
  }

  export interface Opciones {
    node: Client;
    /** Fábrica, no cliente: la terminal enciende sin internet más veces de las que se cree. */
    abrirNube: () => Promise<Client>;
    sucursalId: string;
    versionNodo: string;
    cadencia?: Partial<Cadencia>;
    /** Inyectable. Ver exigencia 1 de la cabecera. */
    ahora?: () => Date;
  }

  export interface ResultadoCiclo {
    push: PushResult | null;
    pull: PullResult | null;
    error: Error | null;
    /** Backoff calculado para el siguiente intento. Se expone para poder observarlo. */
    proximoIntentoMs: number;
    estado: Estado;
  }

  export interface Motor {
    iniciar(): void;
    detener(): Promise<void>;
    /** Un ciclo inmediato, como el que dispara una venta (§3.3). Resuelve al terminar. */
    ciclo(): Promise<ResultadoCiclo>;
    estado(): Estado;
    /** Última sincronización exitosa; `null` si nunca hubo. Alimenta el stale-guard. */
    ultimaSyncExitosa(): Date | null;
  }

  export type CrearMotor = (opts: Opciones) => Motor;

  /** Puro, exportado aparte: el backoff debe probarse sin levantar nada. */
  export type SiguienteBackoff = (intentosFallidos: number, cadencia: Cadencia) => number;
}

/** `src/sync/reconcile.ts` */
export namespace ContratoReconcile {
  export interface Bloque {
    tabla: string;
    sucursalId: string;
    /** Día operativo `YYYY-MM-DD`. */
    dia: string;
    filas: number;
    hash: string;
  }

  export interface Divergencia {
    tabla: string;
    dia: string;
    filasLocal: number;
    filasNube: number;
    hashLocal: string;
    hashNube: string;
    /**
     * Qué filas faltan de cada lado. Sin esto, "los hashes no coinciden" no es
     * accionable: el §6.1 promete "el bloque exacto y un re-push dirigido", y dirigido
     * significa saber QUÉ reenviar.
     */
    soloEnLocal: string[];
    soloEnNube: string[];
    /** `version` distinta con el mismo `id`: divergencia de contenido, no de existencia. */
    versionDistinta: string[];
  }

  export type CalcularBloques = (
    c: Client, sucursalId: string, dias: readonly string[], tablas?: readonly string[],
  ) => Promise<Bloque[]>;

  export interface ResultadoConciliacion {
    divergencias: Divergencia[];
    filasReencoladas: number;
    excepcionesAbiertas: number;
  }

  export type Conciliar = (
    node: Client, cloud: Client,
    opts: { sucursalId: string; dias: readonly string[]; rePush?: boolean },
  ) => Promise<ResultadoConciliacion>;

  // ---- Arbitraje determinista (01b §6). PURO. Ver exigencia 2 de la cabecera. ----

  /** Lo mínimo para calcular prioridad. Nada de esto puede depender de la nube. */
  export interface Ocupacion {
    id: string;
    boletoId: string;
    sucursalId: string;
    salidaId: string;
    asientoNum: number;
    /** Reloj de quien emitió, no de quien recibe. */
    emitidoEn: Date;
    impreso: boolean;
    pagado: boolean;
    abonoParcial: boolean;
  }

  /** Niveles 1..4 del cuadro de 01b §6. Mayor gana. */
  export type PrioridadDe = (o: Ocupacion) => 1 | 2 | 3 | 4;

  /**
   * Orden total determinista: prioridad, luego `emitidoEn` más antiguo, luego
   * `sucursalId`, luego `boletoId`. Devuelve <0, 0 o >0 como un comparador.
   * NUNCA debe mirar el orden de llegada a la nube.
   */
  export type Comparar = (a: Ocupacion, b: Ocupacion) => number;

  export interface Arbitraje {
    gana: Ocupacion;
    pierden: Ocupacion[];
  }
  export type Arbitrar = (candidatas: readonly Ocupacion[]) => Arbitraje;

  // ---- Reasignación del perdedor (01b §7) ----

  export type MotivoReasignacion = 'mismo_bloque' | 'adyacente_a_acompanante' | 'cualquiera';

  export interface Reasignacion {
    boletoId: string;
    asientoAnterior: number;
    asientoNuevo: number;
    motivo: MotivoReasignacion;
    /** El folio NO cambia: es lo que hace reversible una sobreventa ya impresa. */
    folio: string;
  }

  /** `null` cuando la unidad va llena: ahí entra la cola de excepciones con severidad alta. */
  export type ProponerReasignacion = (
    c: Client, boletoId: string,
  ) => Promise<Reasignacion | null>;
}

// `src/sync/salud.ts` ATERRIZÓ: sus tipos reales viven ahí y sus pruebas están
// más abajo, ya ejecutables. El contrato propuesto se borró.

// ===========================================================================
// Lo que hay que probar en cuanto exista cada módulo
// ===========================================================================

describe('src/sync/engine.ts — ciclo, cadencia y backoff', () => {
  it.todo('respeta la cadencia del §3.3: push cada 5 s y pull cada 30 s en operación normal');
  it.todo('dispara un push inmediato tras una venta, sin esperar el tick');
  it.todo('con la nube caída no lanza: acumula en outbox y deja el estado en `sin_red`');
  it.todo('el backoff crece de forma monótona y se topa en backoffMaxMs');
  it.todo('el backoff se reinicia tras el primer ciclo exitoso');
  it.todo('al reconectar tras un corte largo drena en lotes de 500 sin monopolizar la caja');
  it.todo('`detener()` espera al ciclo en curso: no deja un lote a medias');
  it.todo('dos motores sobre el mismo nodo no envían el mismo renglón dos veces');
  it.todo('con `ahora()` desplazado 73 h el estado pasa a `degradado` sin esperar tres días');
  it.todo('en modo degradado sigue drenando el outbox: degradar no es dejar de sincronizar');
  it.todo('un error en el pull no impide el push del mismo ciclo, ni al revés');
  it.todo('hace catch-up de pull ANTES de permitir vender asientos fuera de cupo (§3.3)');
});

describe('src/sync/reconcile.ts — checksum y clases de conflicto', () => {
  it.todo('detecta una fila presente en el nodo y ausente en la nube, y la nombra en soloEnLocal');
  it.todo('detecta la divergencia que deja un respaldo restaurado 6 h atrás (§8)');
  it.todo('distingue divergencia de EXISTENCIA de divergencia de CONTENIDO (versionDistinta)');
  it.todo('el re-push dirigido reencola exactamente las filas divergentes, no el día entero');
  it.todo('abre una excepción `divergencia_checksum` con el bloque exacto');
  it.todo('no reporta divergencia cuando ambos lados están vacíos');

  // El corazón de F0 y de F4. Sin pureza esto no se puede afirmar.
  it.todo('ARBITRAJE · dos nodos con los mismos datos calculan el MISMO ganador');
  it.todo('ARBITRAJE · gana el boleto pagado e impreso sobre el pagado sin imprimir');
  it.todo('ARBITRAJE · gana el pagado sobre el abono parcial, y el abono sobre la reservación');
  it.todo('ARBITRAJE · a igual prioridad gana el `emitido_en` más antiguo');
  it.todo('ARBITRAJE · a igual emisión desempata por sucursal y luego por boleto, de forma estable');
  it.todo('ARBITRAJE · el resultado NO cambia si se invierte el orden de llegada a la nube');
  it.todo('ARBITRAJE · es total: nunca devuelve empate para dos ocupaciones distintas');
  it.todo('el perdedor pasa a `estado=conflicto` y su boleto a `conflicto_sobreventa`, sin borrarse');

  it.todo('REASIGNACIÓN · prefiere otro asiento del MISMO bloque');
  it.todo('REASIGNACIÓN · si no lo hay, uno adyacente a los acompañantes de la misma venta');
  it.todo('REASIGNACIÓN · conserva el folio, que es lo que la hace reversible');
  it.todo('REASIGNACIÓN · con la unidad llena devuelve null y abre excepción de severidad alta');
  it.todo('REASIGNACIÓN · deja nota_auditoria(tipo=reasignacion_por_conflicto) y encola reimpresión');
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
  });

  it('separa outbox pendiente de outbox atascado: hoy el operador no puede distinguirlos', async () => {
    await filaOutbox('pendiente', 0);
    await filaOutbox('enviado', 1);
    await filaOutbox('confirmado', 1);      // no cuenta en ninguno
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
