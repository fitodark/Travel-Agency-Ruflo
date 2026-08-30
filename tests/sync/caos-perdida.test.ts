/**
 * Pérdida silenciosa de datos: el peor modo de falla de un motor de sincronización.
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §2 (R3)
 *                  docs/architecture/01-sincronizacion.md §2.2, §3.1, §3.2, §6.1
 *
 * "Nadie lo nota hasta el cierre de mes, y para entonces la evidencia física —los
 * tickets— ya no existe." Todo lo que sigue busca exactamente eso: escrituras que el
 * sistema da por confirmadas y que no están, o que están mal.
 *
 * NUBE SIMULADA: estos escenarios corren contra una base local marcada
 * `sync.nodo.es_nube = true`. Corre las MISMAS migraciones, así que tiene los mismos
 * triggers, la misma `ingest_batch` y la misma restricción de exclusión. Lo único que
 * no prueba es la red hacia Supabase, y eso ya lo cubre `f1-criterios.test.ts`.
 *
 * ---------------------------------------------------------------------------------
 * LEER ANTES DE TOCAR ESTE ARCHIVO
 *
 * Los bloques marcados `DEFECTO VIGENTE` fijan el comportamiento que el motor tiene
 * HOY, no el que debería tener. Existen para que el defecto sea visible, medible y
 * regresivo mientras se corrige, en vez de vivir en un informe que nadie relee.
 * Cuando se arregle el motor, estas pruebas deben INVERTIRSE (cada una dice cómo).
 * Que fallen tras la corrección es la señal esperada, no un problema.
 * ---------------------------------------------------------------------------------
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import type { Client } from 'pg';
import { bootstrap } from '../../src/sync/bootstrap.js';
import { pull } from '../../src/sync/pull.js';
import { outboxPendiente, push } from '../../src/sync/push.js';
import {
  abrirAdmin, abrirLocal, checksum, construirIds, contar, crearNodo, cursorDe, desviarReloj, hayLocal,
  hoy, PREFIJO_CAOS, pullHasta, sembrarMaestros, silenciarEcoDeConfiguracion, soltarNodo, vender, type Ids,
} from './harness.js';

const IDS: Ids = construirIds('b2', ['P', 'Q']);
const DB_NUBE = 'donaji_caos_perdida_nube';
const DB_S1 = 'donaji_caos_perdida_s1';

const run = hayLocal ? describe : describe.skip;

run('pérdida silenciosa de datos', () => {
  let admin: Client;
  let nube: Client;
  let s1: Client;

  beforeAll(async () => {
    admin = await abrirAdmin();
    nube = await crearNodo(admin, DB_NUBE, { esNube: true, sucursalId: null });
    await sembrarMaestros(nube, IDS);
    s1 = await crearNodo(admin, DB_S1, { sucursalId: IDS.sucursales[0]!, versionBinario: 'N' });
    const b = await bootstrap(s1, nube);
    expect(b.puedeVender).toBe(true);
    // Se neutraliza el eco de configuración que deja el bootstrap para que estas
    // pruebas midan solo lo que ellas escriben. El eco tiene su propio bloque más
    // abajo, con su propia nube, precisamente para no mezclarlo con lo demás.
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
  // 1. El reloj híbrido no sobrevive al viaje
  // =========================================================================
  describe('el HLC del nodo se destruye al ingerir', () => {
    it('la nube CONSERVA el hlc_ts del origen al recibir una fila', async () => {
      // El blueprint §2.2 dice que el HLC da "un orden total determinista que todas
      // las réplicas calculan igual, sin depender de que los relojes coincidan". Eso
      // exige que el HLC del origen se CONSERVE.
      //
      // Antes no se conservaba: `core.trg_columnas_estandar` (BEFORE INSERT/UPDATE sobre
      // toda tabla de `core`) corría también al ingerir una fila replicada y pisaba
      // `hlc_ts`, `hlc_cnt` y `version` con los valores de quien recibe. La `0014` lo
      // resolvió: los triggers consultan `sync.replicando()` y no tocan nada cuando la
      // fila viene de otra réplica.
      const v = await vender(s1, { ids: IDS, sucursalId: IDS.sucursales[0]!, asiento: 3, tramos: '[0,3)', sinOcupacion: true });
      expect(v.ok, v.motivo ?? '').toBe(true);

      const { rows: local } = await s1.query<{ hlc_ts: Date; hlc_cnt: number; version: number }>(
        `SELECT hlc_ts, hlc_cnt, version FROM core.boleto WHERE id = $1`, [v.boletoId],
      );
      await push(s1, nube, { versionNodo: 'N' });
      const { rows: remoto } = await nube.query<{ hlc_ts: Date; hlc_cnt: number; version: number }>(
        `SELECT hlc_ts, hlc_cnt, version FROM core.boleto WHERE id = $1`, [v.boletoId],
      );

      expect(remoto.length).toBe(1);
      expect(
        remoto[0]!.hlc_ts.getTime(),
        'el hlc_ts del origen debe llegar intacto a la nube',
      ).toBe(local[0]!.hlc_ts.getTime());
      expect(remoto[0]!.hlc_cnt, 'y también el contador').toBe(local[0]!.hlc_cnt);
      expect(remoto[0]!.version, 'y la versión: la nube no la recalcula').toBe(local[0]!.version);
    }, 120_000);

    it('la guarda `WHERE EXCLUDED.hlc > almacenado` bloquea un payload más viejo', async () => {
      // Es la pieza que sostiene TODO el modelo de reintentos del §3.1. Antes era inerte:
      // `EXCLUDED` en un `ON CONFLICT DO UPDATE` refleja la fila DESPUÉS de los triggers
      // BEFORE, y el trigger le ponía `hlc_ts = clock_timestamp()` de la nube, así que
      // `EXCLUDED.hlc_ts` siempre superaba lo almacenado y la condición se cumplía
      // SIEMPRE — "gana el orden de llegada a la nube", que 01b §6 prohíbe.
      //
      // Con la `0014` el trigger no toca el HLC de una fila replicada, así que la guarda
      // compara el HLC real del payload: uno de hace tres días se ignora.
      const { rows: n } = await nube.query<{ id: string }>(
        `INSERT INTO core.agencia (id, nombre) VALUES (core.uuid_v7(), 'actual') RETURNING id`,
      );
      const id = n[0]!.id;

      const payloadViejo = JSON.stringify({
        id, nombre: 'payload de hace tres días', activo: true,
        hlc_ts: '2000-01-01T00:00:00Z', hlc_cnt: 0, version: 1,
        creado_en: '2000-01-01T00:00:00Z', modificado_en: '2000-01-01T00:00:00Z',
      });

      const { rows: res } = await nube.query<{ estado: string }>(
        `SELECT estado FROM sync.ingest_fila('core.agencia', $1::uuid, $2::jsonb)`, [id, payloadViejo],
      );
      const { rows: post } = await nube.query<{ nombre: string; version: number }>(
        `SELECT nombre, version FROM core.agencia WHERE id = $1`, [id],
      );

      expect(res[0]!.estado, 'el payload viejo debe ignorarse por HLC').toBe('ignorada_hlc');
      expect(post[0]!.nombre, 'el nombre actual no debe cambiar').toBe('actual');
      expect(post[0]!.version, 'y no debe consumir una versión').toBe(1);

      await nube.query(`DELETE FROM core.agencia WHERE id = $1`, [id]);
    }, 120_000);
  });

  // =========================================================================
  // 2. La consecuencia cara: un ACK perdido corrompe y desalinea el checksum
  // =========================================================================
  it(
    'un ACK perdido: el reenvío de un payload VIEJO se ignora y el checksum no se rompe',
    async () => {
      // Este es el escenario de producción, no uno de laboratorio:
      //
      //   1. La caja vende un boleto.                        -> nube: version 1
      //   2. El pasajero corrige su nombre; la caja lo edita. -> nube: version 2
      //   3. El ACK del PASO 1 se había perdido en la red, así que el nodo lo reenvía.
      //
      // Antes, con la guarda de HLC inerte, el payload del paso 1 sobrescribía al del
      // paso 2: volvía el nombre viejo y `version` subía a 3 mientras el nodo seguía en
      // 2. Como `sync.calcular_checksum` hashea `id || version`, el bloque divergía para
      // siempre y el único detector de pérdida silenciosa del sistema daba falsos
      // positivos.
      //
      // Con la guarda funcionando, el paso 3 es un no-op: `ignorada_hlc`. El nombre
      // corregido se mantiene, `version` es 2 en ambos lados y los hashes coinciden.
      const sucursal = IDS.sucursales[0]!;
      const v = await vender(s1, {
        ids: IDS, sucursalId: sucursal, asiento: 4, tramos: '[0,3)',
        pasajero: 'ANA MUNOZ', sinOcupacion: true,
      });
      expect(v.ok, v.motivo ?? '').toBe(true);

      await push(s1, nube, { versionNodo: 'N' });

      // La fila de outbox del PRIMER envío, con el payload original.
      const { rows: primera } = await s1.query<{ seq: string }>(
        `SELECT seq::text FROM sync.outbox
          WHERE fila_id = $1 AND tabla = 'core.boleto' ORDER BY seq LIMIT 1`,
        [v.boletoId],
      );
      const seqOriginal = primera[0]!.seq;

      // Paso 2: la caja corrige el nombre y lo sube.
      await s1.query(`UPDATE core.boleto SET pasajero_nombre = 'ANA MARIA MUNOZ' WHERE id = $1`, [v.boletoId]);
      await push(s1, nube, { versionNodo: 'N' });

      const dia = hoy();
      const antes = {
        local: await checksum(s1, 'core.boleto', sucursal, dia),
        nube: await checksum(nube, 'core.boleto', sucursal, dia),
      };
      expect(antes.local.hash, 'antes del reenvío los bloques deben coincidir').toBe(antes.nube.hash);

      // Paso 3: el ACK del primer envío se había perdido. El nodo reenvía aquel lote.
      await s1.query(
        `UPDATE sync.outbox SET estado = 'pendiente', lote_id = NULL WHERE seq = $1::bigint`,
        [seqOriginal],
      );
      await push(s1, nube, { versionNodo: 'N' });

      const { rows: enNube } = await nube.query<{ pasajero_nombre: string; version: number }>(
        `SELECT pasajero_nombre, version FROM core.boleto WHERE id = $1`, [v.boletoId],
      );
      const { rows: enNodo } = await s1.query<{ pasajero_nombre: string; version: number }>(
        `SELECT pasajero_nombre, version FROM core.boleto WHERE id = $1`, [v.boletoId],
      );

      expect(enNodo[0]!.pasajero_nombre).toBe('ANA MARIA MUNOZ');
      expect(
        enNube[0]!.pasajero_nombre,
        'la nube conserva el nombre corregido: el reenvío viejo no la pisa',
      ).toBe('ANA MARIA MUNOZ');
      expect(enNube[0]!.version, 'y la versión no se infla: 2 en ambos lados').toBe(enNodo[0]!.version);

      const despues = {
        local: await checksum(s1, 'core.boleto', sucursal, dia),
        nube: await checksum(nube, 'core.boleto', sucursal, dia),
      };
      expect(despues.local.filas, 'no se perdió ni cambió ninguna fila').toBe(despues.nube.filas);
      expect(
        despues.local.hash,
        'los hashes siguen coincidiendo: el reenvío no rompió el bloque',
      ).toBe(despues.nube.hash);

      // Y el outbox drena: `ignorada_hlc` cuenta como confirmada, no queda nada colgado.
      expect(await outboxPendiente(s1), 'el reenvío ignorado no deja el outbox atascado').toBe(0);
    },
    180_000,
  );

  // =========================================================================
  // 3. El cursor de pull y las filas que nadie vuelve a ver
  // =========================================================================
  describe('el cursor de pull', () => {
    it(
      'se DETIENE en una fila rechazada en vez de saltarla y perderla',
      async () => {
        // Antes `pull` contaba la fila como `rechazada` y seguía adelante: el cursor
        // quedaba por delante de ella, sin reintento ni cola. Una `salida` cuyo
        // `horario` no había bajado se perdía para siempre y la terminal seguía
        // operando con el dato viejo sin que nada lo señalara.
        //
        // Ahora el cursor se DETIENE en la primera fila que no puede aplicar, abre una
        // excepción y expone `bloqueadoEn`. Prefiere un pull atascado y visible a uno
        // que avanza perdiendo filas. Cuando la entrada envenenada se resuelve —el
        // origen la corrige o un operador la purga— el pull retoma el atraso que había
        // quedado detrás.
        const cursorAntes = await cursorDe(s1);

        // Una `salida` cuyo `horario_id` no existe en ningún lado: rechazo por FK.
        const { rows: base } = await nube.query<{ p: Record<string, unknown> }>(
          `SELECT to_jsonb(t) AS p FROM core.salida t WHERE id = $1`, [IDS.salida],
        );
        const { rows: nuevos } = await nube.query<{ salida: string; horario: string }>(
          `SELECT core.uuid_v7() AS salida, core.uuid_v7() AS horario`,
        );
        const huerfana = { ...base[0]!.p, id: nuevos[0]!.salida, horario_id: nuevos[0]!.horario };
        const telefono = `953 ${String(Date.now() % 1000).padStart(3, '0')} 7777`;

        try {
          const { rows: pub } = await nube.query<{ seq: string }>(
            `INSERT INTO sync.cambio_log (tabla, fila_id, payload)
             VALUES ('core.salida', $1, $2::jsonb) RETURNING seq`,
            [nuevos[0]!.salida, JSON.stringify(huerfana)],
          );
          const seqHuerfana = Number(pub[0]!.seq);
          // Un cambio legítimo DESPUÉS de la fila huérfana: no debe adelantarla.
          await nube.query(
            `UPDATE core.sucursal SET telefono_principal = $2 WHERE id = $1`,
            [IDS.sucursales[0], telefono],
          );

          // El pull se atasca en la huérfana. Se reintenta unas pocas veces por si el
          // filtro por snapshot la retiene un ciclo.
          let r = await pull(s1, nube);
          for (let i = 0; i < 30 && !r.bloqueadoEn; i++) r = await pull(s1, nube);

          expect(r.bloqueadoEn?.tabla, 'el pull queda bloqueado en la salida huérfana').toBe('core.salida');
          expect(r.bloqueadoEn?.seq, 'bloqueado exactamente en esa fila').toBe(seqHuerfana);
          expect(r.rechazadas, 'la cuenta como rechazada, no la aplica').toBeGreaterThanOrEqual(1);
          expect(
            await cursorDe(s1),
            'el cursor se detiene ANTES de la fila rechazada, no la salta',
          ).toBeLessThan(seqHuerfana);
          expect(
            await contar(
              s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
              [IDS.sucursales[0], telefono],
            ),
            'el cambio que venía detrás tampoco pasa: el cursor está detenido',
          ).toBe(0);

          // El bloqueo es VISIBLE: hay una excepción abierta que el tablero puede mostrar.
          expect(
            await contar(
              s1,
              `SELECT count(*) AS n FROM sync.excepcion
                WHERE tipo = 'rechazo_ingesta' AND estado = 'abierta' AND entidad = 'core.salida'`,
            ),
            'el pull atascado deja rastro en sync.excepcion',
          ).toBeGreaterThanOrEqual(1);

          // El origen corrige el error: la entrada envenenada se retira del log.
          await nube.query(`DELETE FROM sync.cambio_log WHERE seq = $1`, [seqHuerfana]);

          // El pull retoma y entrega lo que había quedado detrás del bloqueo.
          await pullHasta(
            s1, nube,
            async () => (await contar(
              s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
              [IDS.sucursales[0], telefono],
            )) === 1,
            { descripcion: 'el cambio que estaba detrás de la fila envenenada' },
          );

          expect(
            await contar(s1, `SELECT count(*) AS n FROM core.salida WHERE id = $1`, [nuevos[0]!.salida]),
            'la salida huérfana nunca se aplicó, pero tampoco se coló saltándola',
          ).toBe(0);
          expect(await cursorDe(s1), 'resuelto el bloqueo, el cursor avanza').toBeGreaterThan(seqHuerfana);
        } finally {
          await nube.query(`DELETE FROM sync.cambio_log WHERE fila_id = $1`, [nuevos[0]!.salida]).catch(() => { /* limpieza */ });
          await silenciarEcoDeConfiguracion(s1).catch(() => { /* limpieza */ });
        }
      },
      180_000,
    );

    it(
      'un bloqueo por FK que YA lleva rato atascado se omite en vez de quedarse muerto',
      async () => {
        // Un rechazo por FK legítimo se resuelve en uno o dos ciclos (el padre llega
        // o su transacción termina). Si tras la gracia la MISMA fila sigue sin poder
        // aplicarse, es una entrada obsoleta que referencia un id que la nube borró
        // o re-clavó: el pull no puede quedarse muerto ahí para siempre.
        const cursorAntes = await cursorDe(s1);
        const { rows: base } = await nube.query<{ p: Record<string, unknown> }>(
          `SELECT to_jsonb(t) AS p FROM core.salida t WHERE id = $1`, [IDS.salida],
        );
        const { rows: ids } = await nube.query<{ salida: string; horario: string }>(
          `SELECT core.uuid_v7() AS salida, core.uuid_v7() AS horario`,
        );
        const huerfana = { ...base[0]!.p, id: ids[0]!.salida, horario_id: ids[0]!.horario };
        const telefono = `953 ${String((Date.now() + 2) % 1000).padStart(3, '0')} 9999`;
        try {
          const { rows: pub } = await nube.query<{ seq: string }>(
            `INSERT INTO sync.cambio_log (tabla, fila_id, payload)
             VALUES ('core.salida', $1, $2::jsonb) RETURNING seq`,
            [ids[0]!.salida, JSON.stringify(huerfana)],
          );
          const seqHuerfana = Number(pub[0]!.seq);
          await nube.query(
            `UPDATE core.sucursal SET telefono_principal = $2 WHERE id = $1`,
            [IDS.sucursales[0], telefono],
          );

          // Primer encuentro: bloquea (podría ser un problema de orden).
          let r = await pull(s1, nube);
          for (let i = 0; i < 30 && !r.bloqueadoEn; i++) r = await pull(s1, nube);
          expect(r.bloqueadoEn?.seq, 'primero bloquea').toBe(seqHuerfana);

          // "Pasa el tiempo": se envejece la excepción del bloqueo.
          await s1.query(
            `UPDATE sync.excepcion SET creado_en = now() - interval '20 minutes'
              WHERE tipo = 'rechazo_ingesta' AND estado = 'abierta' AND entidad = 'core.salida'`,
          );

          // Ahora el pull la OMITE y sigue con lo que venía detrás.
          const r2 = await pullHasta(
            s1, nube,
            async () => (await contar(
              s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
              [IDS.sucursales[0], telefono],
            )) === 1,
            { descripcion: 'el cambio que venía detrás de la fila envejecida' },
          );
          expect(r2.aplicadas, 'lo de atrás pasó').toBeGreaterThanOrEqual(1);
          expect(await cursorDe(s1), 'el cursor pasó de largo la huérfana')
            .toBeGreaterThan(seqHuerfana);
          expect(
            await contar(s1, `SELECT count(*) AS n FROM core.salida WHERE id = $1`, [ids[0]!.salida]),
            'la salida huérfana nunca se aplicó',
          ).toBe(0);
          expect(
            await contar(s1, `SELECT count(*) AS n FROM sync.excepcion
                              WHERE entidad = 'core.salida' AND estado = 'resuelta'`),
            'el bloqueo previo quedó marcado resuelto',
          ).toBeGreaterThanOrEqual(1);
          expect(cursorAntes).toBeLessThan(seqHuerfana);
        } finally {
          await nube.query(`DELETE FROM sync.cambio_log WHERE fila_id = $1`, [ids[0]!.salida]).catch(() => { /* limpieza */ });
          await nube.query(`UPDATE core.sucursal SET telefono_principal = '953 000 0000' WHERE id = $1`, [IDS.sucursales[0]]).catch(() => { /* limpieza */ });
          await s1.query(`DELETE FROM sync.excepcion WHERE entidad = 'core.salida'`).catch(() => { /* limpieza */ });
          await silenciarEcoDeConfiguracion(s1).catch(() => { /* limpieza */ });
        }
      },
      180_000,
    );

    it(
      'un choque de unicidad en una tabla de clase A NO bloquea: se omite y el pull sigue',
      async () => {
        // Después de una re-clave de identidad (migración 0039), el `sync.cambio_log`
        // puede tener entradas OBSOLETAS que referencian el id viejo. Aplicarlas por id
        // crea un duplicado del `codigo` (UNIQUE) → `conflicto`. Antes eso bloqueaba el
        // pull para siempre: el nodo nunca gana la clase A, así que reintentar no sirve.
        //
        // Ahora una fila de clase A en `conflicto` se OMITE (excepción
        // `divergencia_checksum`, severidad media) y el cursor avanza. La nube es la
        // autoridad y una publicación posterior trae el estado bueno.
        const telefono = `953 ${String((Date.now() + 1) % 1000).padStart(3, '0')} 8888`;
        try {
          // Fila obsoleta: el `codigo` de una sucursal que el nodo ya tiene, con OTRO id.
          const { rows: base } = await nube.query<{ p: Record<string, unknown> }>(
            `SELECT to_jsonb(t) AS p FROM core.sucursal t WHERE id = $1`, [IDS.sucursales[0]],
          );
          const obsoleta = { ...base[0]!.p, id: '019caff0-0000-7000-8000-0000000c0de5' };
          const { rows: pub } = await nube.query<{ seq: string }>(
            `INSERT INTO sync.cambio_log (tabla, fila_id, payload)
             VALUES ('core.sucursal', $1, $2::jsonb) RETURNING seq`,
            [obsoleta['id'], JSON.stringify(obsoleta)],
          );
          const seqObsoleta = Number(pub[0]!.seq);

          // Un cambio legítimo DESPUÉS de la obsoleta.
          await nube.query(
            `UPDATE core.sucursal SET telefono_principal = $2 WHERE id = $1`,
            [IDS.sucursales[1], telefono],
          );

          const r = await pullHasta(
            s1, nube,
            async () => (await contar(
              s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
              [IDS.sucursales[1], telefono],
            )) === 1,
            { descripcion: 'el cambio legítimo que venía detrás de la fila obsoleta' },
          );

          // No se aplicó una segunda sucursal con id fabricado.
          expect(
            await contar(s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1`, [obsoleta['id']]),
            'la fila obsoleta no se aplicó (id fabricado)',
          ).toBe(0);
          // El cursor pasó de largo.
          expect(await cursorDe(s1), 'el cursor avanzó por encima de la fila obsoleta')
            .toBeGreaterThanOrEqual(seqObsoleta);
          expect(r.rechazadas, 'no cuenta como rechazo bloqueante').toBe(0);
          // Queda constancia, con severidad media (no crítica ni bloqueante).
          expect(
            await contar(s1, `SELECT count(*) AS n FROM sync.excepcion
                              WHERE tipo = 'divergencia_checksum' AND estado = 'abierta'
                                AND entidad = 'core.sucursal' AND severidad = 'media'`),
            'la omisión deja una excepción divergencia_checksum media',
          ).toBeGreaterThanOrEqual(1);

          await nube.query(`UPDATE core.sucursal SET telefono_principal = '953 000 0000' WHERE id = $1`, [IDS.sucursales[1]]);
          await silenciarEcoDeConfiguracion(s1);
          await s1.query(`DELETE FROM sync.excepcion WHERE tipo = 'divergencia_checksum'`);
        } finally {
          await nube.query(`DELETE FROM sync.cambio_log WHERE payload->>'id' = '019caff0-0000-7000-8000-0000000c0de5'`).catch(() => { /* limpieza */ });
        }
      },
      180_000,
    );

    it(
      'un choque de unicidad en clase D (cupo_offline) se omite AL TOQUE, sin gracia de 10 min',
      async () => {
        // El caso real: la suite de caos deja cientos de entradas de
        // `core.cupo_offline` en el `cambio_log` de la nube (una por corrida, con
        // id nuevo de `repartir_cupo_offline`) que chocan contra el cupo que el
        // nodo ya tiene por `(salida_id, sucursal_id)`. Antes cada una tardaba 10
        // min en saltarse → el pull no bajaba nada en días. Ahora un choque de
        // unicidad se omite en el primer intento, sea de la clase que sea.
        await pull(s1, nube);
        // El nodo ya tiene un cupo para (IDS.salida, IDS.sucursales[1]).
        await s1.query(
          `INSERT INTO core.cupo_offline (salida_id, sucursal_id, tramos, asientos, bloques, vigente_desde, vigente_hasta)
           VALUES ($1, $2, '[0,3)', ARRAY[1,2], ARRAY['B0'], now(), now() + interval '30 days')
           ON CONFLICT (salida_id, sucursal_id) DO NOTHING`,
          [IDS.salida, IDS.sucursales[1]],
        );

        const telefono = `953 ${String((Date.now() + 3) % 1000).padStart(3, '0')} 7777`;
        try {
          // Entrada obsoleta: mismo (salida, sucursal) que el nodo ya tiene, pero
          // con OTRO id → viola `cupo_offline_salida_id_sucursal_id_key`.
          const huerfana = {
            id: '019caff0-0000-7000-8000-0000000c0fee',
            salida_id: IDS.salida, sucursal_id: IDS.sucursales[1],
            tramos: '[0,3)', asientos: [1], bloques: ['B0'], activo: true,
            vigente_desde: '2026-01-01T00:00:00Z', vigente_hasta: '2026-12-31T00:00:00Z',
            hlc_ts: '2026-01-01T00:00:00Z', hlc_cnt: 1, version: 1,
          };
          const { rows: pub } = await nube.query<{ seq: string }>(
            `INSERT INTO sync.cambio_log (tabla, fila_id, payload)
             VALUES ('core.cupo_offline', $1, $2::jsonb) RETURNING seq`,
            [huerfana.id, JSON.stringify(huerfana)],
          );
          const seqHuerfana = Number(pub[0]!.seq);
          await nube.query(
            `UPDATE core.sucursal SET telefono_principal = $2 WHERE id = $1`,
            [IDS.sucursales[1], telefono],
          );

          // UN solo pull: no debe hacer falta la gracia.
          const r = await pull(s1, nube);
          expect(r.rechazadas, 'no bloquea').toBe(0);
          expect(r.omitidas, 'la omite en el acto').toBeGreaterThanOrEqual(1);
          expect(await cursorDe(s1), 'el cursor pasó de largo la huérfana en el primer intento')
            .toBeGreaterThanOrEqual(seqHuerfana);
          expect(
            await contar(s1, `SELECT count(*) AS n FROM core.cupo_offline WHERE id = $1`, [huerfana.id]),
            'la fila obsoleta no se aplicó',
          ).toBe(0);

          await pullHasta(
            s1, nube,
            async () => (await contar(
              s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
              [IDS.sucursales[1], telefono],
            )) === 1,
            { descripcion: 'el cambio que venía detrás' },
          );

          await nube.query(`UPDATE core.sucursal SET telefono_principal = '953 000 0000' WHERE id = $1`, [IDS.sucursales[1]]);
          await silenciarEcoDeConfiguracion(s1);
          await s1.query(`DELETE FROM sync.excepcion WHERE tipo = 'divergencia_checksum'`);
        } finally {
          await nube.query(`DELETE FROM sync.cambio_log WHERE payload->>'id' = '019caff0-0000-7000-8000-0000000c0fee'`).catch(() => { /* limpieza */ });
        }
      },
      180_000,
    );

    it(
      'un bloqueo que el cursor ya dejó atrás (bootstrap) se marca resuelto solo',
      async () => {
        // Un `bootstrap` salta el cursor al máximo. Si en su momento había un
        // bloqueo abierto en un `seq` intermedio, la excepción `rechazo_ingesta`
        // queda huérfana: `abierta` para siempre, y el tablero de salud muestra
        // una terminal "atascada" que en realidad está al día. El pull, al ver
        // que su `seq` ya quedó por debajo del cursor, la resuelve.
        await pull(s1, nube);
        const cursor = await cursorDe(s1);
        expect(cursor, 'hay algo de historia sincronizada').toBeGreaterThan(0);

        await s1.query(
          `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, detalle)
           VALUES ('rechazo_ingesta', 'alta', sync.sucursal_local(), 'core.cupo_offline',
                   $1::jsonb)`,
          [JSON.stringify({ seq: String(cursor - 1), efecto: 'el pull no avanza hasta resolverlo' })],
        );

        await pull(s1, nube);

        expect(
          await contar(s1, `SELECT count(*) AS n FROM sync.excepcion
                            WHERE tipo = 'rechazo_ingesta' AND estado = 'abierta'
                              AND entidad = 'core.cupo_offline'`),
          'la excepción huérfana quedó resuelta',
        ).toBe(0);
        await s1.query(`DELETE FROM sync.excepcion WHERE entidad = 'core.cupo_offline'`);
      },
      120_000,
    );

    it(
      'NO se salta filas de transacciones todavía abiertas (y sin el filtro, sí se las saltaría)',
      async () => {
        // El escenario que el blueprint §3.2 declara como la razón de no usar
        // `modificado_en`: `seq` se asigna al INSERTAR, no al confirmar. Una transacción
        // lenta reserva un `seq` bajo y confirma después que otra con `seq` mayor.
        //
        // Aquí se demuestra el peligro Y la defensa, en la misma prueba: primero se ve
        // que una consulta ingenua devolvería solo la fila alta —lo que arrastraría el
        // cursor por encima de la baja y la perdería— y luego que `pull` no aplica
        // ninguna de las dos hasta que la transacción lenta confirma.
        const lenta = await abrirLocal(DB_NUBE);
        const rapida = await abrirLocal(DB_NUBE);
        try {
          // Primero se pone al día, para que lo único por encima del cursor sea lo que
          // esta prueba fabrique. Se usa `pull` a secas y no `pullConProgreso` porque
          // aquí "no había nada que bajar" es un resultado válido.
          await pull(s1, nube);
          const cursorAntes = await cursorDe(s1);

          // Las entradas se escriben DIRECTO en `sync.cambio_log` en vez de provocarlas
          // con un UPDATE. No es un atajo: un UPDATE sobre `core` toma el lock de la
          // fila única `sync.hlc_estado`, así que la transacción lenta bloquearía a la
          // rápida y la prueba se colgaría en vez de probar nada. Esa contención es un
          // hallazgo por derecho propio y tiene su prueba en `caos-reintentos.test.ts`.
          //
          // El payload lleva el `hlc_cnt` avanzado a mano, como haría el trigger en un
          // cambio real: sin eso la guarda de HLC lo ignoraría por no ser más nuevo.
          const publicar = async (c: Client, sucursalId: string, telefono: string): Promise<string> => {
            const { rows } = await c.query<{ seq: string }>(
              `INSERT INTO sync.cambio_log (tabla, fila_id, payload)
               SELECT 'core.sucursal', t.id,
                      jsonb_set(
                        jsonb_set(to_jsonb(t), '{telefono_principal}', to_jsonb($2::text)),
                        '{hlc_cnt}', to_jsonb(t.hlc_cnt + 1000))
                 FROM core.sucursal t WHERE t.id = $1
               RETURNING seq`,
              [sucursalId, telefono],
            );
            return rows[0]!.seq;
          };

          await lenta.query('BEGIN');
          const seqBajo = await publicar(lenta, IDS.sucursales[0]!, '953 111 0001');

          const seqAlto = await publicar(rapida, IDS.sucursales[1]!, '953 111 0002');
          const bajo = [{ seq: seqBajo }];
          const alto = [{ seq: seqAlto }];
          expect(Number(alto[0]!.seq)).toBeGreaterThan(Number(bajo[0]!.seq));

          // Lo que vería un cursor ingenuo, sin el filtro por snapshot.
          const { rows: ingenua } = await nube.query<{ seq: string }>(
            `SELECT seq::text FROM sync.cambio_log WHERE seq > $1 ORDER BY seq`, [cursorAntes],
          );
          expect(
            ingenua.map((r) => r.seq),
            'la fila baja es invisible: un cursor ingenuo saltaría a la alta y la perdería',
          ).not.toContain(bajo[0]!.seq);
          expect(ingenua.map((r) => r.seq)).toContain(alto[0]!.seq);

          // Lo que hace `pull`: no toca nada mientras haya una transacción abierta por
          // debajo. Prefiere atrasarse antes que saltarse algo.
          const r = await pull(s1, nube);
          expect(r.aplicadas).toBe(0);
          expect(await cursorDe(s1), 'el cursor no debe moverse').toBe(cursorAntes);

          await lenta.query('COMMIT');

          // Se espera a que lleguen LAS DOS. No basta con contar filas aplicadas: el
          // filtro por snapshot puede soltarlas en ciclos distintos, y lo que importa
          // aquí no es cuántas vinieron juntas sino que ninguna se quedó atrás.
          const r2 = await pullHasta(
            s1, nube,
            async () => (await contar(
              s1,
              `SELECT count(*) AS n FROM core.sucursal
                WHERE (id = $1 AND telefono_principal = $2)
                   OR (id = $3 AND telefono_principal = $4)`,
              [IDS.sucursales[0], '953 111 0001', IDS.sucursales[1], '953 111 0002'],
            )) === 2,
            { descripcion: 'las dos filas, tras confirmar la transacción lenta' },
          );
          expect(r2.aplicadas, 'al confirmar, llegan las DOS').toBeGreaterThanOrEqual(2);
          const { rows: tel } = await s1.query<{ tel: string }>(
            `SELECT telefono_principal AS tel FROM core.sucursal WHERE id = $1`, [IDS.sucursales[0]],
          );
          expect(tel[0]!.tel, 'la fila de seq bajo no se perdió').toBe('953 111 0001');
          await silenciarEcoDeConfiguracion(s1);
        } finally {
          await lenta.query('ROLLBACK').catch(() => { /* ya confirmada */ });
          await lenta.end().catch(() => { /* ya cerrada */ });
          await rapida.end().catch(() => { /* ya cerrada */ });
        }
      },
      180_000,
    );
  });

  // =========================================================================
  // 4. El reloj híbrido avanza al observar lotes remotos (D1, cerrado por 0041)
  // =========================================================================
  it('recibir un lote remoto avanza el piso HLC local, acotado a la deriva máxima', async () => {
    // Blueprint §2.2: "Al recibir un lote remoto se avanza el reloj local al máximo
    // observado". `sync.hlc_observar` existía desde 0001 y no la llamaba nadie; 0041 la
    // cablea en `sync.ingest_fila`, así que el pull ahora sí sube el piso.
    //
    // Pero acotado: un remoto con el reloj disparado no puede empujar el piso más allá
    // de `clock_timestamp() + hlc_deriva_max_seg`. Si no, un solo nodo con la BIOS
    // corrida contaminaría el orden causal de los otros tres.
    const pisoDe = async (): Promise<number> => {
      const { rows } = await s1.query<{ ts: Date }>(
        `SELECT ultimo_ts AS ts FROM sync.hlc_estado WHERE singleton`,
      );
      return rows[0]!.ts.getTime();
    };
    const { rows: base } = await nube.query<{ p: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS p FROM core.sucursal t WHERE id = $1`, [IDS.sucursales[1]],
    );

    // (a) Un skew razonable, dentro de la deriva máxima (300 s): el piso lo absorbe.
    const antes = await pisoDe();
    const skewRazonable = new Date(Date.now() + 90_000).toISOString(); // +90 s
    const TEL_A = '953 333 0001';
    await nube.query(
      `INSERT INTO sync.cambio_log (tabla, fila_id, payload) VALUES ('core.sucursal', $1, $2::jsonb)`,
      [IDS.sucursales[1], JSON.stringify({ ...base[0]!.p, hlc_ts: skewRazonable, hlc_cnt: 99, telefono_principal: TEL_A })],
    );
    await pullHasta(
      s1, nube,
      async () => (await contar(
        s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
        [IDS.sucursales[1], TEL_A],
      )) === 1,
      { descripcion: 'la fila con skew razonable' },
    );
    const pisoTrasA = await pisoDe();
    expect(pisoTrasA, 'el piso subió hacia el máximo observado').toBeGreaterThan(antes);
    expect(pisoTrasA, 'y llegó a ~+90 s del skew observado').toBeGreaterThan(Date.now() + 30_000);

    // (b) Un skew absurdo (+365 días): el piso se ACOTA y se abre `deriva_reloj`.
    const skewAbsurdo = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const TEL_B = '953 333 0002';
    await nube.query(
      `INSERT INTO sync.cambio_log (tabla, fila_id, payload) VALUES ('core.sucursal', $1, $2::jsonb)`,
      [IDS.sucursales[1], JSON.stringify({ ...base[0]!.p, hlc_ts: skewAbsurdo, hlc_cnt: 999, telefono_principal: TEL_B })],
    );
    await pullHasta(
      s1, nube,
      async () => (await contar(
        s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
        [IDS.sucursales[1], TEL_B],
      )) === 1,
      { descripcion: 'la fila con skew absurdo' },
    );
    expect(
      await pisoDe(),
      'el piso quedó acotado, muy lejos de +365 días',
    ).toBeLessThan(Date.now() + 24 * 3600 * 1000);
    expect(
      await contar(
        s1, `SELECT count(*) AS n FROM sync.excepcion WHERE tipo = 'deriva_reloj' AND estado = 'abierta'`,
      ),
      'un remoto con el reloj disparado abre una excepción deriva_reloj',
    ).toBeGreaterThanOrEqual(1);

    // El nodo SÍ conserva el HLC de la fila (0014): no lo pisa con su reloj local.
    const { rows: guardado } = await s1.query<{ hlc_ts: Date }>(
      `SELECT hlc_ts FROM core.sucursal WHERE id = $1`, [IDS.sucursales[1]],
    );
    expect(
      guardado[0]!.hlc_ts.getTime(),
      'el hlc_ts del origen se conserva en la fila',
    ).toBeGreaterThan(Date.now() + 24 * 3600 * 1000);

    // Limpieza: el piso quedó en +max y la fila de sucursales[1] con hlc_ts a un año.
    // Reescribir la fila (con el piso ya en `now()`) le devuelve un hlc_ts real por el
    // trigger, y así no envenena la guarda de HLC de las pruebas siguientes del bloque.
    await s1.query(`DELETE FROM sync.excepcion WHERE tipo = 'deriva_reloj'`);
    await s1.query(`UPDATE sync.hlc_estado SET ultimo_ts = now(), ultimo_cnt = 0 WHERE singleton`);
    await s1.query(`UPDATE core.sucursal SET telefono_principal = '953 000 0000' WHERE id = $1`, [IDS.sucursales[1]]);
    await silenciarEcoDeConfiguracion(s1);
  }, 180_000);

  // =========================================================================
  // 4a. El filtro anti-transacciones-abiertas mira a TODO el servidor
  // =========================================================================
  it(
    'una transacción abierta en OTRA base NO detiene el pull',
    async () => {
      // El filtro de `pull.ts` compara `xmin` contra el horizonte de transacciones en
      // vuelo. Antes lo tomaba de `pg_snapshot_xmin(pg_current_snapshot())`, que es de
      // todo el SERVIDOR: una transacción larga en cualquier otra base del mismo
      // PostgreSQL —el `pg_dump` de continuidad (R11), las consultas del sistema de
      // reportes (R9)— bajaba el umbral y hacía que el filtro descartara filas
      // confirmadas y visibles, dejando la configuración sin bajar a las cuatro
      // terminales sin ninguna señal.
      //
      // Ahora el horizonte se acota a `current_database()`: solo una transacción sobre
      // la propia nube retiene el pull. Una en otra base no lo toca.
      const ajeno = await abrirLocal(DB_S1);
      try {
        // Puesta al día previa; que no haya nada pendiente también es válido.
        await pull(s1, nube);
        const cursorAntes = await cursorDe(s1);

        // Una transacción abierta en OTRA base (la del propio nodo), ajena a la nube.
        await ajeno.query('BEGIN');
        await ajeno.query(
          `INSERT INTO sync.cursor (tabla, ultimo_seq) VALUES ('bloqueo_ajeno', 0)
           ON CONFLICT (tabla) DO UPDATE SET ultimo_seq = sync.cursor.ultimo_seq + 1`,
        );

        // La nube publica un cambio real (el trigger sella HLC nuevo y lo pone en
        // cambio_log) y lo CONFIRMA.
        await nube.query(
          `UPDATE core.sucursal SET telefono_principal = '953 222 0001' WHERE id = $1`,
          [IDS.sucursales[0]],
        );

        const r2 = await pullHasta(
          s1, nube,
          async () => (await contar(
            s1, `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
            [IDS.sucursales[0], '953 222 0001'],
          )) === 1,
          { descripcion: 'la fila publicada mientras hay una transacción abierta en otra base' },
        );
        expect(
          r2.aplicadas,
          'la transacción de otra base no retiene el pull: la fila baja igual',
        ).toBeGreaterThan(0);
        expect(await cursorDe(s1), 'y el cursor avanza').toBeGreaterThan(cursorAntes);

        await ajeno.query('ROLLBACK');
        await silenciarEcoDeConfiguracion(s1);
      } finally {
        await ajeno.query('ROLLBACK').catch(() => { /* ya revertida */ });
        await ajeno.end().catch(() => { /* ya cerrada */ });
      }
    },
    180_000,
  );

  // =========================================================================
  // 4b. Deriva de reloj: el HLC se acota, no se dispara (D3, cerrado por 0041)
  // =========================================================================
  it('una excursión del reloj queda ACOTADA a la deriva máxima y abre una excepción', async () => {
    // R5, y el motivo por el que NTP es requisito de instalación (D-5). Pero NTP
    // corrige el reloj del SO, no el HLC.
    //
    // Antes `sync.hlc_siguiente()` hacía `ultimo_ts = GREATEST(ultimo_ts,
    // clock_timestamp())`: un trinquete que subía y nunca bajaba. Un arranque con la
    // BIOS corrida una hora dejaba TODAS las escrituras una hora adelantadas para
    // siempre, y ese nodo ganaba toda comparación por HLC sin que nada lo señalara.
    //
    // 0041: `hlc_siguiente` solo LEE el piso y lo ACOTA a `hlc_deriva_max_seg` por
    // delante del reloj de pared. Una excursión ya no se dispara sin límite: se queda
    // topada en la deriva máxima (bounded drift, que es la garantía real de un HLC) y
    // abre una excepción `deriva_reloj` para que se vea en el tablero. Un pull posterior
    // la sana hacia el tope (ver "recibir un lote remoto avanza el piso HLC").
    const UNA_HORA = 3600;
    const MAX_SEG = 300; // hlc_deriva_max_seg
    await desviarReloj(s1, UNA_HORA); // envenena el piso: now + 1 h

    const v = await vender(s1, {
      ids: IDS, sucursalId: IDS.sucursales[0]!, asiento: 6, tramos: '[0,3)', sinOcupacion: true,
    });
    expect(v.ok, v.motivo ?? '').toBe(true);
    const { rows: primera } = await s1.query<{ hlc_ts: Date; hlc_cnt: number }>(
      `SELECT hlc_ts, hlc_cnt FROM core.boleto WHERE id = $1`, [v.boletoId],
    );
    const v2 = await vender(s1, {
      ids: IDS, sucursalId: IDS.sucursales[0]!, asiento: 7, tramos: '[0,3)', sinOcupacion: true,
    });
    expect(v2.ok, v2.motivo ?? '').toBe(true);
    const { rows: segunda } = await s1.query<{ hlc_ts: Date; hlc_cnt: number }>(
      `SELECT hlc_ts, hlc_cnt FROM core.boleto WHERE id = $1`, [v2.boletoId],
    );

    const adelanto = (segunda[0]!.hlc_ts.getTime() - Date.now()) / 1000;
    expect(adelanto, 'el sello no se dispara a +1 h: queda topado en la deriva máxima')
      .toBeLessThanOrEqual(MAX_SEG + 30);
    expect(segunda[0]!.hlc_ts.getTime(), 'y no cae por debajo del reloj real')
      .toBeGreaterThanOrEqual(primera[0]!.hlc_ts.getTime());
    expect(segunda[0]!.hlc_cnt, 'el contador (secuencia) sigue avanzando')
      .toBeGreaterThan(primera[0]!.hlc_cnt);
    expect(
      await contar(s1, `SELECT count(*) AS n FROM sync.excepcion WHERE tipo = 'deriva_reloj' AND estado = 'abierta'`),
      'la excursión abre una excepción deriva_reloj',
    ).toBeGreaterThanOrEqual(1);

    // Limpieza para no contaminar las pruebas siguientes del bloque.
    await s1.query(`UPDATE sync.hlc_estado SET ultimo_ts = now(), ultimo_cnt = 0 WHERE singleton`);
    await s1.query(`DELETE FROM sync.excepcion WHERE tipo = 'deriva_reloj'`);
  }, 180_000);

  // =========================================================================
  // 5. La red de seguridad del bootstrap (D6, cerrado por 0040)
  // =========================================================================
  it('todas las FK de `core` son DEFERRABLE: el bootstrap puede tolerar orden parcial', async () => {
    // `bootstrap.ts` y el blueprint §5 dicen que dentro del lote las claves foráneas se
    // difieren "para tolerar orden parcial". PostgreSQL solo difiere las constraints
    // declaradas DEFERRABLE; hasta 0040 ninguna del esquema lo era y `SET CONSTRAINTS
    // ALL DEFERRED` no hacía nada — el bootstrap funcionaba solo porque
    // `ORDEN_TOPOLOGICO` está bien escrito a mano.
    //
    // 0040 declara TODAS las FK de `core` DEFERRABLE INITIALLY IMMEDIATE: el
    // comportamiento por defecto no cambia, pero el `SET CONSTRAINTS ALL DEFERRED` del
    // bootstrap por fin difiere de verdad.
    const { rows } = await s1.query<{ deferrables: string; total: string }>(
      `SELECT count(*) FILTER (WHERE condeferrable)::text AS deferrables,
              count(*)::text AS total
         FROM pg_constraint WHERE contype = 'f' AND connamespace = 'core'::regnamespace`,
    );
    expect(Number(rows[0]!.total)).toBeGreaterThan(0);
    expect(
      Number(rows[0]!.deferrables),
      'todas las FK de core deben ser diferibles tras 0040',
    ).toBe(Number(rows[0]!.total));

    // Y la que importa: con las FK diferidas, insertar un hijo antes que su padre
    // dentro de una transacción NO rebota si el padre llega antes del COMMIT —
    // que es lo que `bootstrap.ts` promete y hasta 0040 no cumplía.
    const rutaId = PREFIJO_CAOS + IDS.ns + 'aa' + '00000001';
    const horarioId = PREFIJO_CAOS + IDS.ns + 'aa' + '00000002';
    await s1.query('BEGIN');
    try {
      await s1.query('SET CONSTRAINTS ALL DEFERRED');
      await s1.query(
        `INSERT INTO core.horario (id, ruta_id, hora_salida, dias_semana)
         VALUES ($1, $2, '07:00', ARRAY[1,2,3,4,5,6,7])`,
        [horarioId, rutaId],
      );
      await s1.query(
        `INSERT INTO core.ruta (id, nombre, sucursal_origen_id, sucursal_destino_id)
         VALUES ($1, 'orden parcial', $2, $3)`,
        [rutaId, IDS.sucursales[0], IDS.sucursales[1]],
      );
      await s1.query('COMMIT');
    } catch (err) {
      await s1.query('ROLLBACK').catch(() => { /* ya revertida */ });
      throw err;
    }
    await s1.query(`DELETE FROM core.horario WHERE id = $1`, [horarioId]);
    await s1.query(`DELETE FROM core.ruta WHERE id = $1`, [rutaId]);
    await silenciarEcoDeConfiguracion(s1);
  }, 60_000);
});

// ===========================================================================
// Bucle de realimentación entre pull y push
// ===========================================================================

run('bucle de realimentación de la configuración', () => {
  let admin: Client;
  let nube: Client;
  let nodo: Client;
  const DB_NUBE_ECO = 'donaji_caos_eco_nube';
  const DB_ECO = 'donaji_caos_eco_s1';

  beforeAll(async () => {
    admin = await abrirAdmin();
    nube = await crearNodo(admin, DB_NUBE_ECO, { esNube: true, sucursalId: null });
    await sembrarMaestros(nube, IDS);
    nodo = await crearNodo(admin, DB_ECO, { sucursalId: IDS.sucursales[0]! });
  }, 180_000);

  afterAll(async () => {
    await nodo?.end().catch(() => { /* ya cerrado */ });
    await nube?.end().catch(() => { /* ya cerrado */ });
    await soltarNodo(admin, DB_ECO);
    await soltarNodo(admin, DB_NUBE_ECO);
    await admin?.end().catch(() => { /* ya cerrado */ });
  }, 120_000);

  it(
    'el nodo NO reencola hacia arriba la configuración que acaba de bajar',
    async () => {
      // Blueprint §4, clase A: "La nube gana siempre. **El nodo nunca escribe estas
      // tablas.**" Antes `bootstrap` y `pull` escribían la configuración con
      // `sync.ingest_fila` y `sync.trg_outbox` —montado sobre esas mismas tablas— no
      // distinguía "escritura del vendedor" de "escritura de la bajada", así que el nodo
      // terminaba con toda la configuración recién bajada encolada para subir.
      //
      // La `0014` puso a `trg_outbox` a consultar `sync.replicando()`: lo que baja no
      // vuelve a encolarse.
      const b = await bootstrap(nodo, nube);
      expect(b.total).toBeGreaterThan(0);

      const eco = await contar(nodo, `SELECT count(*) AS n FROM sync.outbox`);
      expect(eco, 'el bootstrap no debe dejar nada encolado para subir').toBe(0);
    },
    180_000,
  );

  it(
    'el eco NO se realimenta: pull y push convergen y la versión se estabiliza',
    async () => {
      // La consecuencia compuesta, y la más cara que había en este archivo:
      //
      //   pull baja config -> trg_outbox la encola -> push la sube -> la guarda de HLC
      //   inerte la aplica -> trg_cambio_log genera una entrada nueva -> el siguiente
      //   pull la baja -> y otra vez, sin converger. Cada vuelta subía `version`, y como
      //   `sync.calcular_checksum` hashea `id || version`, el checksum de clase A no
      //   podía coincidir. A la cadencia del §3.3 eran decenas de miles de filas de
      //   `cambio_log` por terminal y día contra un Supabase de plan Free.
      //
      // La `0014` mató los dos eslabones: `trg_outbox` no reencola lo replicado y la
      // guarda de HLC ignora un payload que no es más nuevo. El bucle no arranca.
      const sucursal = IDS.sucursales[0]!;
      const versionDe = async (): Promise<number> => contar(
        nube, `SELECT version AS n FROM core.sucursal WHERE id = $1`, [sucursal],
      );
      const logDe = async (): Promise<number> => contar(
        nube, `SELECT count(*) AS n FROM sync.cambio_log`,
      );

      await push(nodo, nube, { versionNodo: 'N' });

      const versiones: number[] = [];
      const logs: number[] = [];
      for (let i = 0; i < 3; i++) {
        // `pull` a secas: "no hay nada que bajar" es el resultado esperado en cuanto el
        // bucle está muerto, y `pullHasta` reventaría esperando actividad que no llega.
        await pull(nodo, nube);
        await push(nodo, nube, { versionNodo: 'N' });
        versiones.push(await versionDe());
        logs.push(await logDe());
      }

      expect(
        versiones[2]!,
        `la versión debe estabilizarse: ${versiones.join(' -> ')}`,
      ).toBe(versiones[0]!);
      expect(
        logs[2]!,
        `cambio_log no debe crecer sin que nadie edite nada: ${logs.join(' -> ')}`,
      ).toBe(logs[0]!);
    },
    240_000,
  );

  it(
    'la configuración que BAJA NO queda marcada como propiedad del nodo que la recibe',
    async () => {
      // Antes, `core.trg_columnas_estandar` hacía al insertar
      //   NEW.sync_sucursal_id := COALESCE(NEW.sync_sucursal_id, sync.sucursal_local())
      // también al ingerir una fila replicada: el payload bajaba con la columna en NULL
      // (la nube no es ninguna sucursal) y el nodo la rellenaba con SU PROPIA sucursal.
      // Cada terminal se creía dueña del catálogo entero, y como `sync.calcular_checksum`
      // filtra por `sync_sucursal_id`, el checksum de clase A no podía cuadrar nunca.
      //
      // La `0014` frenó el trigger al replicar: una fila que llega sin dueño se queda
      // sin dueño, en los dos lados, y el checksum de configuración vuelve a coincidir.
      const sucursal = IDS.sucursales[0]!;

      const { rows: enNube } = await nube.query<{ duenio: string | null }>(
        `SELECT sync_sucursal_id AS duenio FROM core.sucursal WHERE id = $1`, [sucursal],
      );
      const { rows: enNodo } = await nodo.query<{ duenio: string | null }>(
        `SELECT sync_sucursal_id AS duenio FROM core.sucursal WHERE id = $1`, [sucursal],
      );

      expect(enNube[0]!.duenio, 'la nube no es ninguna sucursal').toBeNull();
      expect(
        enNodo[0]!.duenio,
        'el nodo no debe apropiarse de la fila que bajó',
      ).toBeNull();

      // Y el efecto sobre el criterio 3 de F1: el bloque de clase A ahora cuadra.
      const local = await checksum(nodo, 'core.sucursal', sucursal, hoy());
      const remoto = await checksum(nube, 'core.sucursal', sucursal, hoy());
      expect(local.filas, 'ningún lado cuenta la fila como propia de la sucursal').toBe(remoto.filas);
      expect(local.hash, 'y por tanto los hashes coinciden').toBe(remoto.hash);
    },
    180_000,
  );
});

// ===========================================================================
// Instalación de una terminal nueva
// ===========================================================================

run('instalación de una terminal nueva', () => {
  let admin: Client;
  let nube: Client;
  const DB_NUBE_INST = 'donaji_caos_inst_nube';
  const DB_INST = 'donaji_caos_inst_s1';

  beforeAll(async () => {
    admin = await abrirAdmin();
    nube = await crearNodo(admin, DB_NUBE_INST, { esNube: true, sucursalId: null });
    await sembrarMaestros(nube, IDS);
  }, 180_000);

  afterAll(async () => {
    await nube?.end().catch(() => { /* ya cerrado */ });
    await soltarNodo(admin, DB_NUBE_INST);
    await soltarNodo(admin, DB_INST);
    await admin?.end().catch(() => { /* ya cerrado */ });
  }, 120_000);

  it(
    'una terminal instalada CON seeds hace bootstrap sin colisión de identidad (D4)',
    async () => {
      // El camino real del instalador: aplicar migraciones y seeds en la PC de la
      // sucursal y después bajar el catálogo de la nube.
      //
      // Antes fallaba por tres defectos encadenados:
      //  1. el seed de `tipo_unidad` no fijaba `id` -> cada base generaba uno distinto
      //     para la misma `clave` (UNIQUE);
      //  2. `sync.ingest_fila` (ON CONFLICT (id)) no absorbía un choque por otra
      //     constraint: salía `conflicto` y se archivaba como `sobreventa`/`critica`;
      //  3. `bootstrap` solo abortaba ante `rechazada` — `conflicto` lo ignoraba y
      //     seguía, y el fallo afloraba niveles después como una FK rota en
      //     `core.salida`.
      //
      // 0039 fija el `id` de `tipo_unidad` de forma determinista (`md5('core.tipo_unidad:'
      // || clave)`) y clasifica bien la excepción; `bootstrap.ts` ahora aborta también
      // ante `conflicto`. El camino del instalador vuelve a funcionar.
      const nodo = await crearNodo(admin, DB_INST, {
        sucursalId: IDS.sucursales[0]!, conSeeds: true,
      });
      try {
        const { rows: claves } = await nodo.query<{ id: string; det: string }>(
          `SELECT id, md5('core.tipo_unidad:' || clave)::uuid AS det
             FROM core.tipo_unidad WHERE clave = 'SPRINTER-18'`,
        );
        const { rows: clavesNube } = await nube.query<{ id: string }>(
          `SELECT id FROM core.tipo_unidad WHERE clave = 'SPRINTER-18'`,
        );
        expect(claves[0]!.id, 'id determinista por clave').toBe(claves[0]!.det);
        expect(claves[0]!.id, 'nodo y nube convergen al mismo id').toBe(clavesNube[0]!.id);

        const res = await bootstrap(nodo, nube);
        expect(res.total, 'el bootstrap copió el catálogo sin abortar').toBeGreaterThan(0);
        expect(
          await contar(nodo, `SELECT count(*) AS n FROM core.salida WHERE id = $1`, [IDS.salida]),
          'la salida bajó con su tipo_unidad_id apuntando a la fila correcta',
        ).toBe(1);
        await silenciarEcoDeConfiguracion(nodo);
      } finally {
        await nodo.end().catch(() => { /* ya cerrado */ });
      }
    },
    240_000,
  );
});

// ===========================================================================
// Invariantes de esquema que sostienen la convivencia N / N-1 (D-8)
// ===========================================================================

run('D-8 · invariantes de migración que un nodo N-1 necesita', () => {
  let admin: Client;
  let node: Client;
  const DB = 'donaji_caos_d8';

  beforeAll(async () => {
    admin = await abrirAdmin();
    node = await crearNodo(admin, DB, { sucursalId: null });
  }, 120_000);

  afterAll(async () => {
    await node?.end().catch(() => { /* ya cerrado */ });
    await soltarNodo(admin, DB);
    await admin?.end().catch(() => { /* ya cerrado */ });
  }, 120_000);

  // Cada prueba vive en su propia transacción revertida: pueden marcar la base como
  // nube o insertar filas sin ensuciar a la siguiente.
  beforeEach(async () => {
    await node.query('BEGIN');
  });

  afterEach(async () => {
    await node.query('ROLLBACK');
  });

  it('toda tabla de `core` sigue siendo ingerible: sin eso, sus filas no cruzan', async () => {
    // `sync.es_tabla_ingerible` exige las cuatro columnas de sync. Una tabla nueva a la
    // que se le olvide `core.registrar_entidad` queda muda: se escribe local, nunca
    // genera outbox y nunca llega a la nube. Es pérdida silenciosa por omisión, y el
    // único momento barato de detectarla es aquí.
    const { rows } = await node.query<{ tabla: string }>(
      `SELECT c.relname AS tabla
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core' AND c.relkind = 'r'
          AND NOT sync.es_tabla_ingerible('core.' || c.relname)
        ORDER BY 1`,
    );
    // `core.folio_secuencia` es hoy la ÚNICA tabla de `core` que no puede cruzar, y no
    // por descuido de esta prueba: no lleva columnas de sync, así que ni genera outbox
    // ni es ingerible. Es la causa raíz del choque de folios tras reinstalar una
    // terminal que se reproduce en `caos-reintentos.test.ts`.
    //
    // Si aparece OTRA tabla en esta lista, es que alguien agregó una tabla y se le
    // olvidó `core.registrar_entidad`: sus filas se escribirían en la sucursal y no
    // llegarían nunca a la nube, sin un solo error.
    expect(rows.map((r) => r.tabla)).toEqual(['folio_secuencia']);
  }, 60_000);

  it('un payload de nodo N-1 al que le faltan columnas se aplica igual', async () => {
    await node.query(`UPDATE sync.nodo SET es_nube = true WHERE singleton`);
    const { rows: id } = await node.query<{ id: string }>(`SELECT core.uuid_v7() AS id`);
    const minimo = JSON.stringify({ id: id[0]!.id, nombre: 'Agencia N-1' });

    const { rows } = await node.query<{ estado: string; motivo: string | null }>(
      `SELECT estado, motivo FROM sync.ingest_fila('core.agencia', $1::uuid, $2::jsonb)`,
      [id[0]!.id, minimo],
    );
    expect(rows[0]!.estado, rows[0]!.motivo ?? '').toBe('aceptada');
  }, 60_000);

  it('un payload con columnas desconocidas no tumba la fila', async () => {
    await node.query(`UPDATE sync.nodo SET es_nube = true WHERE singleton`);
    const { rows: id } = await node.query<{ id: string }>(`SELECT core.uuid_v7() AS id`);
    const futuro = JSON.stringify({
      id: id[0]!.id, nombre: 'Agencia N+1',
      columna_inventada: 'x', otra: { anidada: true },
    });

    const { rows } = await node.query<{ estado: string; motivo: string | null }>(
      `SELECT estado, motivo FROM sync.ingest_fila('core.agencia', $1::uuid, $2::jsonb)`,
      [id[0]!.id, futuro],
    );
    expect(rows[0]!.estado, rows[0]!.motivo ?? '').toBe('aceptada');
  }, 60_000);

  it('un payload SIN ninguna columna conocida se rechaza en vez de crear una fila vacía', async () => {
    await node.query(`UPDATE sync.nodo SET es_nube = true WHERE singleton`);
    const { rows: id } = await node.query<{ id: string }>(`SELECT core.uuid_v7() AS id`);
    const { rows } = await node.query<{ estado: string }>(
      `SELECT estado FROM sync.ingest_fila('core.agencia', $1::uuid, $2::jsonb)`,
      [id[0]!.id, JSON.stringify({ solo_basura: 1 })],
    );
    expect(rows[0]!.estado).toBe('rechazada');
  }, 60_000);

  it('una tabla fuera de la lista blanca se rechaza: la ingesta interpola nombres de tabla', async () => {
    // `ingest_fila` construye SQL dinámico con el nombre de tabla. La lista blanca
    // derivada del catálogo es lo único que separa eso de una inyección.
    for (const tabla of ['sync.nodo', 'public.schema_migration', 'core.folio_secuencia', 'pg_class']) {
      const { rows } = await node.query<{ estado: string }>(
        `SELECT estado FROM sync.ingest_fila($1, core.uuid_v7(), '{"id":"x"}'::jsonb)`, [tabla],
      );
      expect(rows[0]!.estado, `${tabla} no debería ser ingerible`).toBe('rechazada');
    }
  }, 60_000);
});
