/**
 * Caos de reintentos: ACK perdido, muerte a media operación, lote parcialmente
 * rechazado, orden causal y reinstalación de una terminal.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.1, §5, §6
 *                  docs/architecture/04-riesgos-roadmap.md §2 (R2, R13)
 *
 * El motor está diseñado para at-least-once: el nodo reenvía siempre que dude. Eso
 * traslada toda la carga a lo que pasa DESPUÉS del reenvío, que es donde viven los
 * modos de falla caros. Aquí se ejercita cada punto en el que el proceso puede morir.
 *
 * Nube simulada local, por la misma razón que en `caos-perdida.test.ts`: son decenas
 * de ciclos y no aportaría nada hacerlos contra una base compartida.
 *
 * Los bloques `DEFECTO VIGENTE` fijan el comportamiento de HOY para que sea regresivo
 * mientras se corrige; cada uno dice cómo invertirlo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import type { Client } from 'pg';
import { bootstrap } from '../../src/sync/bootstrap.js';
import { outboxPendiente, push } from '../../src/sync/push.js';
import {
  abrirAdmin, abrirLocal, construirIds, contar, crearNodo, hayLocal, outboxPorEstado, sembrarMaestros,
  silenciarEcoDeConfiguracion, soltarNodo, vender, type Ids,
} from './harness.js';

const IDS: Ids = construirIds('c3', ['R', 'S']);
const DB_NUBE = 'donaji_caos_reint_nube';
const DB_S1 = 'donaji_caos_reint_s1';

const run = hayLocal ? describe : describe.skip;

run('caos de reintentos y muerte a media operación', () => {
  let admin: Client;
  let nube: Client;
  let s1: Client;

  beforeAll(async () => {
    admin = await abrirAdmin();
    nube = await crearNodo(admin, DB_NUBE, { esNube: true, sucursalId: null });
    await sembrarMaestros(nube, IDS);
    s1 = await crearNodo(admin, DB_S1, { sucursalId: IDS.sucursales[0]!, versionBinario: 'N' });
    await bootstrap(s1, nube);
    // El bootstrap deja encolada hacia arriba la configuración que acaba de bajar; se
    // neutraliza para que cada prueba mida solo lo que ella misma escribió. Ver harness.
    await silenciarEcoDeConfiguracion(s1);
  }, 180_000);

  afterAll(async () => {
    await s1?.end().catch(() => { /* ya cerrado */ });
    await nube?.end().catch(() => { /* ya cerrado */ });
    await soltarNodo(admin, DB_S1);
    await soltarNodo(admin, DB_NUBE);
    await admin?.end().catch(() => { /* ya cerrado */ });
  }, 120_000);

  // =========================================================================
  // Muerte del proceso entre `enviado` y `confirmado`
  // =========================================================================
  it('una fila que quedó en `enviado` sin ACK se reintenta, no se queda huérfana', async () => {
    // Es el corte de luz del §3.1: `push` marca `enviado` ANTES de llamar, precisamente
    // para que el estado signifique "salió de aquí" y no "llegó allá". Si el proceso
    // muere ahí, la fila debe volver a intentarse en el siguiente ciclo.
    //
    // Con UPS obligatorio (D-3) esto es raro; sin UPS es cotidiano. La prueba fija que
    // ninguna venta se quede varada en un estado intermedio.
    const v = await vender(s1, { ids: IDS, sucursalId: IDS.sucursales[0]!, asiento: 5, tramos: '[0,3)' });
    expect(v.ok, v.motivo ?? '').toBe(true);

    // El proceso murió justo después de marcar el lote como enviado.
    await s1.query(
      `UPDATE sync.outbox SET estado = 'enviado', lote_id = core.uuid_v7(), intentos = 1
        WHERE estado = 'pendiente'`,
    );
    const varadas = await outboxPorEstado(s1);
    expect(varadas['enviado']).toBeGreaterThan(0);

    const r = await push(s1, nube, { versionNodo: 'N' });
    expect(r.enviadas).toBeGreaterThan(0);
    expect(r.rechazadas).toBe(0);
    expect(await outboxPendiente(s1), 'el reintento debe drenar lo varado').toBe(0);

    const firmes = await contar(
      nube,
      `SELECT count(*) AS n FROM core.asiento_ocupacion
        WHERE salida_id = $1 AND asiento_num = 5 AND estado = 'firme'`,
      [IDS.salida],
    );
    expect(firmes, 'y sin duplicar la ocupación').toBe(1);
  }, 180_000);

  it('un bootstrap interrumpido no deja cursor: la terminal no se cree convergida', async () => {
    // `bootstrap` envuelve todo en una transacción y escribe el cursor al final. Si se
    // corta a la mitad, el nodo queda vacío pero HONESTO: sin cursor, el siguiente
    // intento vuelve a copiar todo. Lo contrario —cursor escrito y datos a medias—
    // sería una terminal que cree estar al día con medio catálogo.
    const DB_MEDIO = 'donaji_caos_reint_medio';
    const medio = await crearNodo(admin, DB_MEDIO, { sucursalId: IDS.sucursales[1]! });
    try {
      const { rows } = await medio.query<{ n: string }>(
        `SELECT count(*) AS n FROM sync.cursor`,
      );
      expect(Number(rows[0]!.n), 'una terminal recién instalada no tiene cursor').toBe(0);

      // Se inyecta un fallo a media copia: una restricción que rechaza una de las filas
      // que vienen de la nube. Es la forma determinista de reproducir "se cayó la luz a
      // media instalación" sin depender del azar.
      await medio.query(
        `ALTER TABLE core.sucursal ADD CONSTRAINT tmp_corte_de_luz CHECK (nombre <> 'Terminal 2')`,
      );
      await expect(bootstrap(medio, nube)).rejects.toThrow(/Bootstrap falló/i);
      await medio.query(`ALTER TABLE core.sucursal DROP CONSTRAINT tmp_corte_de_luz`);

      expect(
        await contar(medio, `SELECT count(*) AS n FROM sync.cursor`),
        'un bootstrap fallido no puede dejar cursor',
      ).toBe(0);
      expect(
        await contar(medio, `SELECT count(*) AS n FROM core.sucursal`),
        'ni filas a medias: la transacción se revierte entera',
      ).toBe(0);

      // Y repetirlo es idempotente: es lo que hace segura la reinstalación remota.
      const a = await bootstrap(medio, nube);
      const b = await bootstrap(medio, nube);
      expect(b.total).toBe(a.total);
      expect(
        await contar(medio, `SELECT count(*) AS n FROM core.sucursal`),
        'dos bootstraps no duplican filas',
      ).toBe(IDS.sucursales.length);
    } finally {
      await medio.end().catch(() => { /* ya cerrado */ });
      await soltarNodo(admin, DB_MEDIO);
    }
  }, 240_000);

  // =========================================================================
  // Lote parcialmente rechazado
  // =========================================================================
  describe('lote parcialmente rechazado', () => {
    it('las filas buenas se aplican y solo la mala queda para reintento', async () => {
      // Blueprint §3.1: las rechazadas "no se pierden ni se reintentan ciegamente".
      // `ingest_fila` atrapa la excepción por fila —cada bloque EXCEPTION es una
      // subtransacción— así que una clave foránea faltante no tumba el lote entero.
      const { rows: ids } = await nube.query<{ venta: string; boleto: string; fantasma: string }>(
        `SELECT core.uuid_v7() AS venta, core.uuid_v7() AS boleto, core.uuid_v7() AS fantasma`,
      );

      const ack = await ingest(nube, IDS.sucursales[0]!, [
        {
          tabla: 'core.venta',
          fila_id: ids[0]!.venta,
          payload: {
            id: ids[0]!.venta, sucursal_venta_id: IDS.sucursales[0], usuario_id: IDS.usuario,
            contacto_telefono: '953 111 2222', salida_id: IDS.salida,
            parada_origen_orden: 0, parada_destino_orden: 3, importe_total: 450,
          },
        },
        {
          // Boleto huérfano: su venta no existe ni existirá.
          tabla: 'core.boleto',
          fila_id: ids[0]!.boleto,
          payload: {
            id: ids[0]!.boleto, venta_id: ids[0]!.fantasma, folio: 'RZZZZ1',
            salida_id: IDS.salida, asiento_num: 6, tramos: '[0,3)',
            pasajero_nombre: 'HUERFANO', importe: 450,
          },
        },
      ]);

      expect(ack.aceptadas).toBe(1);
      expect(ack.rechazadas).toBe(1);
      expect(ack.filas[1]!.motivo).toMatch(/falta la fila referenciada/i);

      expect(
        await contar(nube, `SELECT count(*) AS n FROM core.venta WHERE id = $1`, [ids[0]!.venta]),
        'la fila buena del mismo lote sí entró',
      ).toBe(1);
      expect(
        await contar(nube, `SELECT count(*) AS n FROM core.boleto WHERE id = $1`, [ids[0]!.boleto]),
      ).toBe(0);

      await nube.query(`DELETE FROM core.venta WHERE id = $1`, [ids[0]!.venta]);
    }, 120_000);

    it('DEFECTO VIGENTE · cada reintento de la MISMA fila mala crea una excepción nueva', async () => {
      // La cola de excepciones es lo que el gerente ve en la caja y el administrador en
      // el tablero. Una fila que nunca va a poder aplicarse —un boleto cuya venta se
      // perdió al restaurar un respaldo— se reintenta en cada ciclo de push. A 5 s de
      // cadencia, eso son ~17 000 excepciones al día por una sola fila.
      //
      // El daño no es el espacio: es que la excepción CRÍTICA de sobreventa queda
      // sepultada bajo miles de repeticiones de la misma tontería, y el badge no
      // ocultable de la caja deja de significar algo.
      //
      // AL CORREGIR: deduplicar por (tipo, entidad, entidad_id) con un contador de
      // ocurrencias, o marcar la fila de outbox como muerta tras N intentos. Esta
      // prueba debe pasar a exigir UNA sola excepción.
      const sucursal = IDS.sucursales[0]!;
      const antes = await contar(
        nube, `SELECT count(*) AS n FROM sync.excepcion WHERE sucursal_id = $1`, [sucursal],
      );

      const { rows: ids } = await nube.query<{ boleto: string; fantasma: string }>(
        `SELECT core.uuid_v7() AS boleto, core.uuid_v7() AS fantasma`,
      );
      const fila = {
        tabla: 'core.boleto',
        fila_id: ids[0]!.boleto,
        payload: {
          id: ids[0]!.boleto, venta_id: ids[0]!.fantasma, folio: 'RZZZZ2',
          salida_id: IDS.salida, asiento_num: 6, tramos: '[0,3)',
          pasajero_nombre: 'REINTENTO', importe: 450,
        },
      };

      const CICLOS = 5;
      for (let i = 0; i < CICLOS; i++) await ingest(nube, sucursal, [fila]);

      const despues = await contar(
        nube, `SELECT count(*) AS n FROM sync.excepcion WHERE sucursal_id = $1`, [sucursal],
      );
      expect(
        despues - antes,
        'si ya hay deduplicación de excepciones, invertir la prueba a 1',
      ).toBe(CICLOS);

      const distintas = await contar(
        nube,
        `SELECT count(DISTINCT entidad_id) AS n FROM sync.excepcion
          WHERE sucursal_id = $1 AND entidad_id = $2`,
        [sucursal, ids[0]!.boleto],
      );
      expect(distintas, 'y todas son de la MISMA fila').toBe(1);

      await nube.query(`DELETE FROM sync.excepcion WHERE entidad_id = $1`, [ids[0]!.boleto]);
    }, 180_000);

    it('DEFECTO VIGENTE · una fila irreparable deja el outbox pendiente para siempre, sin señal distinta', async () => {
      // `outboxPendiente` cuenta todo lo que no está confirmado, y `push` vuelve a
      // seleccionar los rechazados en cada ciclo. Una fila irreparable hace que el
      // indicador de la caja marque "1 pendiente" indefinidamente.
      //
      // Para el operador, "1 pendiente" durante días es indistinguible de "todavía
      // subiendo": exactamente la ambigüedad que el punto 3 de la mitigación de R2
      // pretendía eliminar ("que el operador sepa cuánto está en riesgo").
      //
      // AL CORREGIR: `salud.ts` debe distinguir `pendientes` de `atascadas`
      // (rechazadas con intentos > N) y el tablero mostrarlas por separado.
      const DB_ATASCO = 'donaji_caos_reint_atasco';
      const nodo = await crearNodo(admin, DB_ATASCO, { sucursalId: IDS.sucursales[1]! });
      try {
        await bootstrap(nodo, nube);
        await silenciarEcoDeConfiguracion(nodo);

        // Una venta cuya salida no existe en la nube: no hay forma de que se aplique.
        const { rows: falsa } = await nodo.query<{ id: string }>(`SELECT core.uuid_v7() AS id`);
        await nodo.query(
          `INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt)
           VALUES ('core.venta', $1, $2::jsonb, now(), 0)`,
          [falsa[0]!.id, JSON.stringify({
            id: falsa[0]!.id, sucursal_venta_id: IDS.sucursales[1], usuario_id: IDS.usuario,
            contacto_telefono: '953 000 0000', salida_id: falsa[0]!.id,
            parada_origen_orden: 0, parada_destino_orden: 3, importe_total: 100,
          })],
        );

        for (let i = 0; i < 3; i++) await push(nodo, nube, { versionNodo: 'N' });

        const estados = await outboxPorEstado(nodo);
        expect(estados['rechazado'], 'la fila irreparable sigue ahí').toBe(1);
        expect(
          await outboxPendiente(nodo),
          'y el indicador de la caja la cuenta como si todavía fuera a subir',
        ).toBe(1);

        // Hoy no hay ninguna forma de distinguir esto de un drenaje en curso salvo
        // leyendo `estado` a mano. Se fija la ausencia para que la corrección la borre.
        const { rows: intentos } = await nodo.query<{ intentos: number }>(
          `SELECT max(intentos) AS intentos FROM sync.outbox WHERE estado = 'rechazado'`,
        );
        expect(intentos[0]!.intentos).toBeGreaterThanOrEqual(3);
      } finally {
        await nodo.end().catch(() => { /* ya cerrado */ });
        await soltarNodo(admin, DB_ATASCO);
      }
    }, 240_000);
  });

  // =========================================================================
  // Contención: el sello HLC ya no serializa toda la base (D2, cerrado por 0041)
  // =========================================================================
  it(
    'una transacción abierta sobre `core` NO bloquea las escrituras de otras filas',
    async () => {
      // Antes `core.trg_columnas_estandar` -> `sync.hlc_siguiente()` hacía
      // `UPDATE sync.hlc_estado ... WHERE singleton` en CADA escritura de `core`: una
      // sola fila en toda la base, con el lock retenido hasta el COMMIT del llamador.
      // Cualquier transacción abierta que hubiera tocado `core` bloqueaba TODA otra
      // escritura — en la nube, mientras una sucursal drenaba 72 h de outbox, las otras
      // tres esperaban.
      //
      // 0041: `hlc_siguiente` solo LEE `sync.hlc_estado` (sin lock) y saca el contador
      // de la secuencia `sync.hlc_seq` (`nextval` no toma lock). Una transacción abierta
      // sobre `core` ya no serializa nada más que su propia fila.
      const a = await abrirLocal(DB_NUBE);
      const b = await abrirLocal(DB_NUBE);
      try {
        await a.query('BEGIN');
        await a.query(
          `UPDATE core.sucursal SET telefono_principal = '953 555 0001' WHERE id = $1`,
          [IDS.sucursales[0]],
        );

        // Otra tabla, otra fila, ninguna relación con lo anterior: NO debe bloquearse.
        await b.query(`SET lock_timeout = '3000ms'`);
        const { rows } = await b.query<{ id: string }>(
          `INSERT INTO core.agencia (id, nombre) VALUES (core.uuid_v7(), 'sin relación') RETURNING id`,
        );
        expect(rows[0]!.id, 'la escritura de B pasó sin esperar a A').toBeTruthy();
        await b.query(`DELETE FROM core.agencia WHERE id = $1`, [rows[0]!.id]);

        await a.query('ROLLBACK');
      } finally {
        await a.query('ROLLBACK').catch(() => { /* ya revertida */ });
        await a.end().catch(() => { /* ya cerrada */ });
        await b.end().catch(() => { /* ya cerrada */ });
      }
    },
    120_000,
  );

  // =========================================================================
  // Orden causal
  // =========================================================================
  describe('orden causal', () => {
    it('el outbox se envía por `seq`, de modo que la venta va antes que su boleto', async () => {
      // Es lo que hace que la ingesta no dependa de la suerte. Se fija el orden porque
      // un `ORDER BY creado_en` o un `ORDER BY id` parecerían equivalentes y no lo son.
      const v = await vender(s1, { ids: IDS, sucursalId: IDS.sucursales[0]!, asiento: 7, tramos: '[0,3)' });
      expect(v.ok, v.motivo ?? '').toBe(true);

      const { rows } = await s1.query<{ tabla: string }>(
        `SELECT tabla FROM sync.outbox WHERE estado = 'pendiente' ORDER BY seq`,
      );
      expect(rows.map((r) => r.tabla)).toEqual(['core.venta', 'core.boleto', 'core.asiento_ocupacion']);
      await push(s1, nube, { versionNodo: 'N' });
    }, 120_000);

    it('un hijo que llega antes que su padre se recupera solo en el siguiente ciclo', async () => {
      // No es hipotético: dos transacciones concurrentes en el nodo pueden confirmar
      // fuera del orden en que tomaron su `seq`, así que un push puede llevarse al hijo
      // mientras el padre sigue invisible. El motor debe sanar sin intervención.
      const sucursal = IDS.sucursales[0]!;
      const { rows: ids } = await nube.query<{ venta: string; boleto: string }>(
        `SELECT core.uuid_v7() AS venta, core.uuid_v7() AS boleto`,
      );
      const venta = {
        id: ids[0]!.venta, sucursal_venta_id: sucursal, usuario_id: IDS.usuario,
        contacto_telefono: '953 111 2222', salida_id: IDS.salida,
        parada_origen_orden: 0, parada_destino_orden: 3, importe_total: 450,
      };
      const boleto = {
        id: ids[0]!.boleto, venta_id: ids[0]!.venta, folio: 'RZZZY1',
        salida_id: IDS.salida, asiento_num: 13, tramos: '[0,3)',
        pasajero_nombre: 'FUERA DE ORDEN', importe: 450,
      };

      // Ciclo 1: llega solo el hijo.
      const a = await ingest(nube, sucursal, [{ tabla: 'core.boleto', fila_id: boleto.id, payload: boleto }]);
      expect(a.rechazadas).toBe(1);

      // Ciclo 2: el padre confirma y el hijo se reintenta. El nodo no hizo nada especial.
      const b = await ingest(nube, sucursal, [
        { tabla: 'core.venta', fila_id: venta.id, payload: venta },
        { tabla: 'core.boleto', fila_id: boleto.id, payload: boleto },
      ]);
      expect(b.aceptadas).toBe(2);
      expect(b.rechazadas).toBe(0);

      await nube.query(`DELETE FROM core.boleto WHERE id = $1`, [boleto.id]);
      await nube.query(`DELETE FROM core.venta  WHERE id = $1`, [venta.id]);
      await nube.query(`DELETE FROM sync.excepcion WHERE entidad_id = $1`, [boleto.id]);
    }, 180_000);
  });

  // =========================================================================
  // Lo mismo, sobre dinero: el corte de caja
  // =========================================================================
  it(
    'un reenvío tardío del corte ABIERTO no reabre un corte de caja ya cerrado',
    async () => {
      // El requerimiento exige "solo puede existir uno activo" y el esquema lo garantiza
      // con `corte_unico_abierto_idx`. Antes, con la guarda de HLC inerte, un reenvío del
      // payload ORIGINAL de un corte —el que decía `estado='abierto'`— se aplicaba igual
      // aunque ese corte ya se hubiera cerrado horas antes; el índice parcial rebotaba la
      // reapertura como `unique_violation`, que `ingest_fila` traducía a `conflicto` y
      // `ingest_batch` archivaba como `tipo='sobreventa'`, `severidad='critica'` — una
      // alerta crítica de sobreventa de asiento por un reenvío de caja.
      //
      // Con la guarda de HLC funcionando (0014), el reenvío del payload viejo se ignora
      // antes de tocar nada: `ignorada_hlc`, sin excepción y sin ruido.
      const sucursal = IDS.sucursales[0]!;
      const { rows: ids } = await nube.query<{ a: string; b: string }>(
        `SELECT core.uuid_v7() AS a, core.uuid_v7() AS b`,
      );
      // El reloj híbrido va incrustado en el payload, como en un lote real: cada
      // transición del corte trae un `hlc_cnt` mayor.
      const hlcBase = '2026-08-01T12:00:00Z';
      const corte = (id: string, estado: string, hlc: number): Record<string, unknown> => ({
        id, sucursal_id: sucursal, usuario_apertura_id: IDS.usuario,
        saldo_inicial: 1000, estado, activo: true,
        hlc_ts: hlcBase, hlc_cnt: hlc,
        ...(estado === 'cerrado' ? { cerrado_en: new Date().toISOString() } : {}),
      });

      const abiertoOriginal = corte(ids[0]!.a, 'abierto', 1);

      // Turno 1: se abre y se cierra.
      expect((await ingest(nube, sucursal, [
        { tabla: 'core.corte_caja', fila_id: ids[0]!.a, payload: abiertoOriginal },
      ])).aceptadas).toBe(1);
      expect((await ingest(nube, sucursal, [
        { tabla: 'core.corte_caja', fila_id: ids[0]!.a, payload: corte(ids[0]!.a, 'cerrado', 2) },
      ])).aceptadas).toBe(1);

      // Turno 2: el siguiente corte del día.
      expect((await ingest(nube, sucursal, [
        { tabla: 'core.corte_caja', fila_id: ids[0]!.b, payload: corte(ids[0]!.b, 'abierto', 1) },
      ])).aceptadas).toBe(1);

      // Llega, tarde, el reenvío del turno 1 por un ACK que se había perdido: trae el
      // `hlc_cnt = 1` de cuando se abrió, ya superado por el cierre (`hlc_cnt = 2`).
      const ack = await ingest(nube, sucursal, [
        { tabla: 'core.corte_caja', fila_id: ids[0]!.a, payload: abiertoOriginal },
      ]);

      expect(
        ack.filas[0]!.estado,
        'la guarda de HLC ignora el payload viejo antes de tocar el índice',
      ).toBe('ignorada_hlc');
      expect(ack.conflictos, 'sin conflicto').toBe(0);
      expect(ack.rechazadas, 'sin rechazo').toBe(0);

      // El corte del turno 1 sigue cerrado; el único abierto es el del turno 2.
      expect(
        await contar(
          nube,
          `SELECT count(*) AS n FROM core.corte_caja
            WHERE sucursal_id = $1 AND estado = 'abierto' AND activo`,
          [sucursal],
        ),
      ).toBe(1);
      const { rows: turno1 } = await nube.query<{ estado: string }>(
        `SELECT estado FROM core.corte_caja WHERE id = $1`, [ids[0]!.a],
      );
      expect(turno1[0]!.estado, 'el corte cerrado no se reabrió').toBe('cerrado');

      // Y ninguna excepción: el reenvío ignorado no genera ruido en la caja.
      const exc = await contar(
        nube,
        `SELECT count(*) AS n FROM sync.excepcion WHERE entidad_id = ANY($1::uuid[])`,
        [[ids[0]!.a, ids[0]!.b]],
      );
      expect(exc, 'un reenvío ignorado por HLC no abre excepción').toBe(0);

      await nube.query(`DELETE FROM sync.excepcion  WHERE entidad_id = ANY($1::uuid[])`, [[ids[0]!.a, ids[0]!.b]]);
      await nube.query(`DELETE FROM core.corte_caja WHERE id = ANY($1::uuid[])`, [[ids[0]!.a, ids[0]!.b]]);
    },
    180_000,
  );

  // =========================================================================
  // Reinstalación de una terminal (R2) y folios (R13) — D5, cerrado en bootstrap.ts
  // =========================================================================
  it(
    'una terminal reinstalada rehidrata su contador de folios y no colisiona con la nube',
    async () => {
      // R2 es el riesgo crítico del proyecto: una sola PC por sucursal. Cuando el disco
      // muere se reinstala y se hace bootstrap. `core.folio_secuencia` NO se replica (y
      // es correcto: dos nodos con el mismo contador emitirían el mismo folio — 0012).
      //
      // Antes el trigger de alta de sucursal creaba la secuencia en CERO y la terminal
      // reinstalada re-emitía R00000, R00001... que la nube ya tenía; `core.boleto.folio`
      // es UNIQUE, así que la nube devolvía `conflicto` y el boleto impreso no subía.
      //
      // `bootstrap.ts` ahora rehidrata `core.folio_secuencia` desde `max(folio)` de la
      // nube por sucursal, más un margen para folios en vuelo. R13 vuelve a ser cierto:
      // no hay colisión ni entre sucursales ni entre una sucursal y su propio pasado.
      const DB_ANTES = 'donaji_caos_reint_disco1';
      const DB_DESPUES = 'donaji_caos_reint_disco2';
      const sucursal = IDS.sucursales[1]!;

      const original = await crearNodo(admin, DB_ANTES, { sucursalId: sucursal });
      let reinstalado: Client | null = null;
      try {
        await bootstrap(original, nube);
        await silenciarEcoDeConfiguracion(original);
        const v1 = await vender(original, {
          ids: IDS, sucursalId: sucursal, asiento: 10, tramos: '[0,3)', sinOcupacion: true,
        });
        expect(v1.ok, v1.motivo ?? '').toBe(true);
        const r1 = await push(original, nube, { versionNodo: 'N' });
        expect(r1.rechazadas + r1.conflictos).toBe(0);

        // Muere el disco. Máquina limpia, esquema limpio, bootstrap desde la nube.
        reinstalado = await crearNodo(admin, DB_DESPUES, { sucursalId: sucursal });
        await bootstrap(reinstalado, nube);
        await silenciarEcoDeConfiguracion(reinstalado);

        const { rows: sec } = await reinstalado.query<{ siguiente: string }>(
          `SELECT siguiente::text FROM core.folio_secuencia WHERE sucursal_id = $1`, [sucursal],
        );
        expect(
          Number(sec[0]!.siguiente),
          'el bootstrap rehidrató el contador por encima de lo que la nube ya conoce',
        ).toBeGreaterThan(0);

        const v2 = await vender(reinstalado, {
          ids: IDS, sucursalId: sucursal, asiento: 10, tramos: '[0,3)', sinOcupacion: true,
        });
        expect(v2.ok, v2.motivo ?? '').toBe(true);
        expect(v2.folio, 'el folio nuevo no repite el anterior').not.toBe(v1.folio);

        const r2 = await push(reinstalado, nube, { versionNodo: 'N' });
        expect(r2.conflictos + r2.rechazadas, 'la nube acepta el folio sin conflicto').toBe(0);

        // Y el boleto que el pasajero tiene en la mano SÍ llegó a la nube.
        expect(
          await contar(nube, `SELECT count(*) AS n FROM core.boleto WHERE id = $1`, [v2.boletoId]),
          'la venta cobrada subió',
        ).toBe(1);
      } finally {
        await original.end().catch(() => { /* ya cerrado */ });
        await reinstalado?.end().catch(() => { /* ya cerrado */ });
        await soltarNodo(admin, DB_ANTES);
        await soltarNodo(admin, DB_DESPUES);
      }
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------

interface AckLote {
  aceptadas: number;
  ignoradas: number;
  conflictos: number;
  rechazadas: number;
  filas: { estado: string; motivo: string | null }[];
}

/** Ingesta un lote armado a mano: la única forma de controlar el orden fila por fila. */
async function ingest(
  cloud: Client,
  sucursalId: string,
  filas: { tabla: string; fila_id: string; payload: unknown }[],
): Promise<AckLote> {
  const { rows: idRows } = await cloud.query<{ id: string }>('SELECT core.uuid_v7() AS id');
  const { rows } = await cloud.query<{ ack: AckLote }>(
    'SELECT sync.ingest_batch($1::jsonb) AS ack',
    [JSON.stringify({
      lote_id: idRows[0]!.id,
      sucursal_id: sucursalId,
      version_nodo: 'N',
      filas: filas.map((f, i) => ({ seq: i + 1, ...f })),
    })],
  );
  return rows[0]!.ack;
}
