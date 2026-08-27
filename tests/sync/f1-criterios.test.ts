/**
 * Criterios de aceptación de F1, literales, contra la nube REAL.
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F1)
 *
 *   1. 500 escrituras locales con red caída 72 h -> 100% presentes en nube.
 *   2. Reenvío del mismo lote 3 veces -> cero duplicados.
 *   3. Checksum idéntico local/nube tras convergencia.
 *   4. Un cambio de configuración en la nube aparece en las 4 sucursales.
 *   5. Un nodo simulado en versión N-1 opera contra la nube N sin errores.
 *
 * Y los dos de F0 que deben seguir cumpliéndose bajo estrés (§3 F0, 01b §10):
 *
 *   6. Dos sucursales offline no pueden colisionar (cupos disjuntos).
 *   7. Cuando colisionan por override, la nube conserva un solo dueño firme.
 *
 * Estos escenarios usan Supabase de verdad porque el criterio dice "en nube" y una
 * nube simulada no probaría el pooler, el TLS ni la latencia. Los escenarios de caos
 * —que son decenas de ciclos— viven en los otros archivos y usan nube local.
 *
 * Las 72 h se SIMULAN: se antedatan las escrituras y se acumula el outbox sin
 * conectar. Esperar tres días no probaría nada que esto no pruebe.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import type { Client } from 'pg';
import { bootstrap } from '../../src/sync/bootstrap.js';
import { outboxPendiente, push } from '../../src/sync/push.js';
import {
  abrirAdmin, abrirNube, checksum, construirIds, contar, crearNodo, hayLocal, hayNube, hoyUtc,
  limpiarNube, pullHasta, sembrarMaestros, silenciarEcoDeConfiguracion, soltarNodo, vender,
  type Ids,
} from './harness.js';

// Namespace `a1` y códigos V/W/X/Y: propios de este archivo, para que pueda correr en
// paralelo con los demás sin pisarlos. Ver `construirIds`.
const IDS: Ids = construirIds('a1', ['V', 'W', 'X', 'Y']);
const BASES = ['donaji_caos_f1_s1', 'donaji_caos_f1_s2', 'donaji_caos_f1_s3', 'donaji_caos_f1_s4'];

const run = hayLocal && hayNube ? describe : describe.skip;

run('F1 — criterios de aceptación contra la nube real', () => {
  let admin: Client;
  let cloud: Client;
  const nodos: Client[] = [];

  beforeAll(async () => {
    admin = await abrirAdmin();
    cloud = await abrirNube();

    await limpiarNube(cloud, IDS);
    await sembrarMaestros(cloud, IDS);

    for (const [i, db] of BASES.entries()) {
      const nodo = await crearNodo(admin, db, { sucursalId: IDS.sucursales[i]!, versionBinario: 'N' });
      const b = await bootstrap(nodo, cloud);
      // Sin nivel 5 (salidas y cupos) la terminal no tiene qué vender: el blueprint §5
      // lo declara condición para abrir la caja, no un detalle interno.
      expect(b.puedeVender, `${db} no convergió hasta nivel 5`).toBe(true);

      // El bootstrap deja encolada para SUBIR la configuración que acaba de BAJAR.
      // Se neutraliza aquí para no reescribir en Supabase filas compartidas que estas
      // pruebas no crearon; el defecto se reproduce en `caos-perdida.test.ts`.
      await silenciarEcoDeConfiguracion(nodo);

      // Los folios se reparten por sucursal, pero el contador vive SOLO en la base
      // local y no se replica. Una base recién creada arranca en cero y reemitiría
      // folios ya usados en la nube. Aquí se desplaza el contador para que la prueba
      // sea reejecutable; el defecto que eso revela se prueba aparte, en
      // `caos-reintentos.test.ts`.
      await nodo.query(
        `UPDATE core.folio_secuencia
            SET siguiente = (extract(epoch FROM now())::bigint % 30000000)
          WHERE sucursal_id = $1`,
        [IDS.sucursales[i]],
      );
      nodos.push(nodo);
    }
  }, 180_000);

  afterAll(async () => {
    for (const n of nodos) await n.end().catch(() => { /* ya cerrado */ });
    await limpiarNube(cloud, IDS);
    await cloud.end().catch(() => { /* ya cerrado */ });
    for (const db of BASES) await soltarNodo(admin, db);
    await admin.end().catch(() => { /* ya cerrado */ });
  }, 120_000);

  // -------------------------------------------------------------------------
  // Criterio 1
  // -------------------------------------------------------------------------
  it(
    '1 · 500 escrituras con 72 h de red caída llegan al 100% a la nube tras reconectar',
    async () => {
      const s1 = nodos[0]!;
      const sucursal = IDS.sucursales[0]!;

      // Se antedata `creado_en` repartido en 72 h. Importa porque el checksum del
      // blueprint agrupa por DÍA OPERATIVO: si todo cayera en el mismo día, la prueba
      // no ejercitaría el hecho de que un drenaje largo cruza varios bloques.
      //
      // El CTE que modifica datos se ejecuta completo antes que el INSERT externo, así
      // que las 500 ventas entran al outbox ANTES que sus boletos. Ese orden es la
      // causalidad intra-sucursal del §3.1: al revés, la nube rechazaría cada boleto
      // por clave foránea.
      await s1.query(
        `WITH nuevas AS (
           INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, contacto_telefono,
                                   salida_id, parada_origen_orden, parada_destino_orden,
                                   importe_total, creado_en)
           SELECT core.uuid_v7(), $1, $2, '953 111 2222', $3, 0, 3, 450,
                  now() - interval '72 hours' + make_interval(mins => g * 8)
             FROM generate_series(1, 500) g
           RETURNING id, creado_en
         )
         INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos,
                                  pasajero_nombre, importe, creado_en)
         SELECT core.uuid_v7(), n.id, core.siguiente_folio($1), $3,
                1 + (row_number() OVER (ORDER BY n.id) % 18)::smallint, '[0,3)'::int4range,
                'PASAJERO OFFLINE', 450, n.creado_en
           FROM nuevas n`,
        [sucursal, IDS.usuario, IDS.salida],
      );

      // No se crean ocupaciones a propósito: 500 boletos no caben en 18 asientos y el
      // criterio mide supervivencia de ESCRITURAS, no capacidad de la unidad.
      const enOutbox = await outboxPendiente(s1);
      expect(enOutbox, 'cada venta y cada boleto debe dejar una fila de outbox').toBe(1000);

      const antes = await contar(
        cloud, `SELECT count(*) AS n FROM core.boleto WHERE salida_id = $1`, [IDS.salida],
      );
      expect(antes, 'la nube no debe saber nada todavía').toBe(0);

      const r = await push(s1, cloud, { versionNodo: 'N' });

      expect(r.rechazadas, `filas rechazadas: ${JSON.stringify(r.acks.at(-1)?.filas.slice(0, 3))}`).toBe(0);
      expect(r.conflictos).toBe(0);
      expect(r.enviadas).toBe(1000);

      const boletos = await contar(
        cloud, `SELECT count(*) AS n FROM core.boleto WHERE salida_id = $1`, [IDS.salida],
      );
      const ventas = await contar(
        cloud, `SELECT count(*) AS n FROM core.venta WHERE salida_id = $1`, [IDS.salida],
      );
      expect(boletos, '100% de los boletos deben estar en la nube').toBe(500);
      expect(ventas).toBe(500);

      // El outbox drenado es la señal que ve el operador en la caja. Si quedara algo,
      // el indicador de "pendientes de subir" mentiría sobre cuánto está en riesgo.
      expect(await outboxPendiente(s1), 'el outbox debe quedar en cero').toBe(0);
    },
    300_000,
  );

  // -------------------------------------------------------------------------
  // Criterio 2 — en sus DOS formas. La segunda es la que ocurre en producción.
  // -------------------------------------------------------------------------
  it('2a · reenviar el MISMO lote_id 3 veces no reprocesa ni duplica', async () => {
    const s1 = nodos[0]!;
    const v = await vender(s1, { ids: IDS, sucursalId: IDS.sucursales[0]!, asiento: 1, tramos: '[0,3)' });
    expect(v.ok, v.motivo ?? '').toBe(true);

    const r = await push(s1, cloud, { versionNodo: 'N' });
    const ack = r.acks[0]!;
    const antes = await contar(
      cloud, `SELECT count(*) AS n FROM core.asiento_ocupacion WHERE salida_id = $1`, [IDS.salida],
    );

    for (let i = 1; i <= 3; i++) {
      const { rows } = await cloud.query<{ ack: { idempotente: boolean } }>(
        'SELECT sync.ingest_batch($1::jsonb) AS ack',
        [JSON.stringify({
          lote_id: ack.lote_id,
          sucursal_id: IDS.sucursales[0],
          version_nodo: 'N',
          filas: ack.filas.map((f) => ({ seq: f.seq, tabla: 'core.boleto', fila_id: f.fila_id, payload: {} })),
        })],
      );
      expect(rows[0]!.ack.idempotente, `reenvío ${i} debió reconocerse como duplicado`).toBe(true);
    }

    const despues = await contar(
      cloud, `SELECT count(*) AS n FROM core.asiento_ocupacion WHERE salida_id = $1`, [IDS.salida],
    );
    expect(despues).toBe(antes);
  }, 120_000);

  it('2b · ACK perdido: el reenvío bajo un lote_id NUEVO tampoco duplica filas', async () => {
    // Este es el caso real y el que el criterio literal NO cubre. Cuando la respuesta
    // se pierde en la red, `push` devuelve el outbox a `pendiente` y el siguiente ciclo
    // arma un lote NUEVO — con otro `lote_id`. La idempotencia por lote no aplica: lo
    // único que protege es el upsert por `id`.
    const s1 = nodos[0]!;
    const v = await vender(s1, { ids: IDS, sucursalId: IDS.sucursales[0]!, asiento: 2, tramos: '[0,3)' });
    expect(v.ok, v.motivo ?? '').toBe(true);

    await push(s1, cloud, { versionNodo: 'N' });
    const antes = await contar(
      cloud, `SELECT count(*) AS n FROM core.boleto WHERE salida_id = $1`, [IDS.salida],
    );

    // Se simula el ACK perdido: la nube ya aplicó, pero el nodo nunca se enteró.
    await s1.query(
      `UPDATE sync.outbox SET estado = 'pendiente', lote_id = NULL WHERE fila_id = $1`,
      [v.boletoId],
    );
    const r2 = await push(s1, cloud, { versionNodo: 'N' });
    expect(r2.acks[0]!.idempotente, 'debe ser un lote nuevo, no el mismo').toBe(false);

    const despues = await contar(
      cloud, `SELECT count(*) AS n FROM core.boleto WHERE salida_id = $1`, [IDS.salida],
    );
    expect(despues, 'el reenvío no debe crear una segunda fila').toBe(antes);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Criterio 3
  // -------------------------------------------------------------------------
  it('3 · el checksum de bloque coincide local y nube tras converger', async () => {
    // ALCANCE DE ESTA PRUEBA: convergencia limpia de clase B, sin reintentos. El
    // criterio se cumple en ese camino. NO se cumple en cuanto hay un reenvío por ACK
    // perdido (la nube recalcula `version` y el bloque diverge) ni para las tablas de
    // clase A (el nodo se marca dueño de lo que baja). Ambos casos están reproducidos
    // en `caos-perdida.test.ts`; no se repiten aquí para no mezclar el criterio con sus
    // excepciones.
    const s2 = nodos[1]!;
    const sucursal = IDS.sucursales[1]!;

    for (let i = 0; i < 5; i++) {
      const v = await vender(s2, { ids: IDS, sucursalId: sucursal, asiento: 8, tramos: '[0,3)', sinOcupacion: true });
      expect(v.ok, v.motivo ?? '').toBe(true);
    }
    const r = await push(s2, cloud, { versionNodo: 'N' });
    expect(r.rechazadas).toBe(0);

    // Se fija UTC en AMBOS lados. Sin eso el criterio no se puede ni medir: el nodo
    // corre en America/Mexico_City y Supabase en UTC, así que cada lado recortaría un
    // día distinto. Eso es un defecto del motor, no de la prueba, y se demuestra en 3b.
    const dia = hoyUtc();
    for (const tabla of ['core.venta', 'core.boleto']) {
      const local = await checksum(s2, tabla, sucursal, dia, { zonaHoraria: 'UTC' });
      const nube = await checksum(cloud, tabla, sucursal, dia, { zonaHoraria: 'UTC' });
      expect(local.filas, `${tabla}: conteo de filas`).toBe(nube.filas);
      expect(local.filas, `${tabla}: el bloque no debería estar vacío`).toBeGreaterThan(0);
      expect(local.hash, `${tabla}: hash del bloque ${dia}`).toBe(nube.hash);
    }
  }, 120_000);

  it('3b · el "día operativo" del checksum se fija en UTC, sin importar la zona de la sesión', async () => {
    // Antes, `sync.calcular_checksum` acotaba el bloque con `creado_en >= dia::date`, y
    // ese literal `date` se interpretaba en la zona horaria de la SESIÓN. El nodo corre
    // en America/Mexico_City y Supabase en UTC, así que toda venta hecha entre las 18:00
    // y medianoche hora local caía en el día D para la terminal y en D+1 para la nube: el
    // job de reconciliación comparaba bloques distintos y levantaba `divergencia_checksum`
    // sin que faltara un dato. Como es el único detector de pérdida silenciosa (R3), una
    // falsa alarma cada noche desde el primer día es peor que no tenerla.
    //
    // La `0014` cambió la función a `(creado_en AT TIME ZONE 'UTC')::date = p_dia`: el
    // día se corta en UTC en los DOS lados, sin depender de la sesión. Que el día
    // operativo deba ser el LOCAL de cada sucursal (`core.sucursal.zona_horaria`) es una
    // decisión aparte, ligada a P12, y cuando se tome se aplica aquí una sola vez.
    const sucursal = IDS.sucursales[1]!;

    // 2026-06-15 02:00 UTC es 2026-06-14 20:00 en Mexico City: la venta de las ocho de
    // la noche, que es justo la que antes caía en días distintos según quién mirara.
    const { rows: v } = await cloud.query<{ id: string }>(
      `INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, contacto_telefono, salida_id,
                               parada_origen_orden, parada_destino_orden, importe_total,
                               creado_en, sync_sucursal_id)
       VALUES (core.uuid_v7(), $1, $2, '953 111 2222', $3, 0, 3, 450,
               '2026-06-15T02:00:00Z'::timestamptz, $1)
       RETURNING id`,
      [sucursal, IDS.usuario, IDS.salida],
    );

    try {
      const enUtc = await checksum(cloud, 'core.venta', sucursal, '2026-06-15', { zonaHoraria: 'UTC' });
      const enLocal = await checksum(
        cloud, 'core.venta', sucursal, '2026-06-15', { zonaHoraria: 'America/Mexico_City' },
      );

      expect(enUtc.filas, 'la venta es del día 15 en UTC').toBe(1);
      expect(
        enLocal.filas,
        'y sigue siendo del día 15 aunque la sesión esté en Mexico City: la zona ya no la mueve',
      ).toBe(enUtc.filas);
      expect(enLocal.hash, 'mismo bloque, mismo hash, sin importar la sesión').toBe(enUtc.hash);

      // La fila NO cuenta en el día anterior: el corte es en UTC, no en hora local.
      const diaAnterior = await checksum(
        cloud, 'core.venta', sucursal, '2026-06-14', { zonaHoraria: 'America/Mexico_City' },
      );
      expect(diaAnterior.filas, 'el día 14 en UTC no la contiene').toBe(0);
    } finally {
      await cloud.query(`DELETE FROM core.venta WHERE id = $1`, [v[0]!.id]);
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Criterio 4
  // -------------------------------------------------------------------------
  it('4 · un cambio de configuración en la nube aparece en las 4 sucursales', async () => {
    const nuevo = `953 ${String(Date.now() % 1000).padStart(3, '0')} 4444`;
    await cloud.query(
      `UPDATE core.sucursal SET telefono_principal = $2 WHERE id = $1`,
      [IDS.sucursales[0], nuevo],
    );

    for (const [i, nodo] of nodos.entries()) {
      // Se espera a que llegue ESTA fila, no a que el pull "haga algo": el filtro por
      // snapshot puede retenerla varios ciclos sin dar ninguna señal de error.
      await pullHasta(
        nodo, cloud,
        async () => (await contar(
          nodo,
          `SELECT count(*) AS n FROM core.sucursal WHERE id = $1 AND telefono_principal = $2`,
          [IDS.sucursales[0], nuevo],
        )) === 1,
        { descripcion: `el cambio de teléfono en la terminal ${i + 1}` },
      );
      const { rows } = await nodo.query<{ tel: string }>(
        `SELECT telefono_principal AS tel FROM core.sucursal WHERE id = $1`, [IDS.sucursales[0]],
      );
      expect(rows[0]?.tel, `la terminal ${i + 1} no recibió el cambio`).toBe(nuevo);
      // El pull vuelve a encolar hacia arriba lo que acaba de bajar. Ver `harness.ts`.
      await silenciarEcoDeConfiguracion(nodo);
    }
  }, 120_000);

  it('4b · la configuración baja por `seq`, nunca por `modificado_en`', async () => {
    // No es un detalle de implementación: es la diferencia entre converger y perder en
    // silencio. Una fila escrita dentro de una transacción larga se hace visible
    // DESPUÉS de otras con timestamp mayor, y un cursor por tiempo la saltaría para
    // siempre. Se fija aquí para que ningún refactor "optimice" el cursor a un
    // timestamp sin que salte una prueba.
    const { rows } = await cloud.query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema = 'sync' AND table_name = 'cursor' AND column_name = 'ultimo_seq'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // Y el filtro anti-transacciones-abiertas debe seguir siendo efectivo: si el
    // `xid8` del snapshot rebasara 2^32 (tras un wraparound con epoch > 0), la
    // comparación de `pull.ts` contra un `xmin` de 32 bits sería siempre verdadera y
    // el filtro se volvería inerte SIN dar ninguna señal. Ver informe.
    const { rows: xs } = await cloud.query<{ xmin8: string }>(
      `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin8`,
    );
    expect(
      Number(xs[0]!.xmin8),
      'el epoch de xid rebasó 2^32: el filtro de transacciones abiertas de pull.ts quedó inerte',
    ).toBeLessThan(2 ** 32);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Criterio 5 — convivencia N / N-1 (D-8)
  // -------------------------------------------------------------------------
  describe('5 · un nodo en versión N-1 opera contra la nube N', () => {
    it('acepta un lote al que le FALTAN columnas que la nube sí conoce', async () => {
      // Es el nodo viejo: su binario no sabe que existe `reimpresiones` ni `impreso_en`,
      // así que su payload no las trae. Si esto fallara, la terminal que se saltó la
      // ventana de madrugada dejaría de subir ventas — a 6 h de distancia y sin nadie
      // que sepa revertir.
      const s3 = nodos[2]!;
      const sucursal = IDS.sucursales[2]!;
      const v = await vender(s3, { ids: IDS, sucursalId: sucursal, asiento: 11, tramos: '[0,3)', sinOcupacion: true });
      expect(v.ok, v.motivo ?? '').toBe(true);

      // Primero sube la venta por el camino normal: un boleto sin su venta se
      // rechazaría por clave foránea y la prueba estaría midiendo otra cosa.
      expect((await push(s3, cloud, { versionNodo: 'N' })).rechazadas).toBe(0);

      const completo = await payloadDeBoleto(s3, v.boletoId!);
      const viejo = await conNuevaIdentidad(s3, completo, sucursal);
      // El binario viejo no sabe que estas columnas existen, así que no las manda.
      for (const col of ['reimpresiones', 'impreso_en', 'desactivado_motivo']) delete viejo[col];

      const ack = await ingest(cloud, sucursal, 'N-1', [
        { tabla: 'core.boleto', fila_id: String(viejo['id']), payload: viejo },
      ]);
      expect(ack.rechazadas, JSON.stringify(ack.filas)).toBe(0);
      expect(ack.aceptadas).toBe(1);
    }, 120_000);

    it('acepta un lote con columnas que la nube TODAVÍA no conoce', async () => {
      // La dirección contraria: la nube se despliega primero, pero durante una release
      // parcial un nodo puede mandar un campo que esta nube aún no tiene. Debe
      // ignorarse, no tumbar el lote entero.
      const s3 = nodos[2]!;
      const sucursal = IDS.sucursales[2]!;
      const v = await vender(s3, { ids: IDS, sucursalId: sucursal, asiento: 12, tramos: '[0,3)', sinOcupacion: true });
      expect(v.ok, v.motivo ?? '').toBe(true);

      expect((await push(s3, cloud, { versionNodo: 'N' })).rechazadas).toBe(0);

      const completo = await payloadDeBoleto(s3, v.boletoId!);
      const futuro = await conNuevaIdentidad(s3, completo, sucursal);
      futuro['columna_de_la_siguiente_release'] = 'valor';
      futuro['otra_mas'] = 42;

      const ack = await ingest(cloud, sucursal, 'N+1', [
        { tabla: 'core.boleto', fila_id: String(futuro['id']), payload: futuro },
      ]);
      expect(ack.rechazadas, JSON.stringify(ack.filas)).toBe(0);
      expect(ack.aceptadas).toBe(1);
    }, 120_000);

    it('registra la versión del nodo en cada lote, para que el tablero sepa quién quedó atrás', async () => {
      // D-8: un humano actualiza 4 terminales a mano y una puede saltarse la noche.
      // Sin este dato, saber cuál se quedó en N-1 exige entrar por TeamViewer a las
      // cuatro; con él, se ve desde el tablero.
      const sucursal = IDS.sucursales[2]!;
      const { rows } = await cloud.query<{ version_nodo: string | null }>(
        `SELECT version_nodo FROM sync.lote_recibido
          WHERE sucursal_id = $1 ORDER BY recibido_en DESC LIMIT 5`,
        [sucursal],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.version_nodo)).toContain('N-1');
    }, 60_000);

    it('un nodo N-1 aplica una fila de configuración con columnas que él no tiene', async () => {
      // El pull también cruza versiones: la nube ya está en N y publica filas con
      // columnas nuevas. `ingest_fila` en el NODO filtra contra su propio catálogo, así
      // que la fila entra sin las columnas que el nodo desconoce en vez de rebotar.
      const s4 = nodos[3]!;
      const { rows: fila } = await cloud.query<{ p: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS p FROM core.sucursal t WHERE id = $1`, [IDS.sucursales[0]],
      );

      // El nodo ya bajó esta fila en el criterio 4, con su HLC. Para ejercitar el camino
      // de APLICACIÓN —no el de "ya la tengo"— se avanza el reloj del payload como lo
      // haría la nube al publicar un cambio real, y se toca un campo observable.
      const telefonoNuevo = `953 ${String(Date.now() % 1000).padStart(3, '0')} 5551`;
      const conFuturo = {
        ...fila[0]!.p,
        telefono_principal: telefonoNuevo,
        hlc_cnt: Number(fila[0]!.p['hlc_cnt']) + 1,
        version: Number(fila[0]!.p['version']) + 1,
        campo_que_el_nodo_no_conoce: 'x',
      };

      const { rows: res } = await s4.query<{ estado: string; motivo: string | null }>(
        `SELECT estado, motivo FROM sync.ingest_fila('core.sucursal', ($1::jsonb->>'id')::uuid, $1::jsonb)`,
        [JSON.stringify(conFuturo)],
      );
      expect(res[0]!.estado, res[0]!.motivo ?? '').toBe('aceptada');

      // La columna desconocida se filtró en silencio: si no lo hiciera, el SQL dinámico
      // de `ingest_fila` la nombraría y la fila entera rebotaría como 'rechazada'.
      const { rows: aplicada } = await s4.query<{ tel: string; existe_col: boolean }>(
        `SELECT telefono_principal AS tel,
                to_jsonb(t) ? 'campo_que_el_nodo_no_conoce' AS existe_col
           FROM core.sucursal t WHERE id = $1`,
        [IDS.sucursales[0]],
      );
      expect(aplicada[0]!.tel, 'el cambio de la nube N debió aplicarse').toBe(telefonoNuevo);
      expect(aplicada[0]!.existe_col, 'la columna que el nodo no conoce no debe haberse colado').toBe(false);

      await silenciarEcoDeConfiguracion(s4);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // F0 · 6 — cupos disjuntos
  // -------------------------------------------------------------------------
  describe('6 · dos sucursales offline no pueden colisionar (cupos disjuntos)', () => {
    // Reparto por bloques contiguos del blueprint 01b §3.3 para la ruta S1->S2->S3->S4
    // sobre la Sprinter de 18 plazas. Se declara aquí porque el job que lo genera es de
    // F3: la prueba fija la propiedad, no la implementación que la producirá.
    const REPARTO = [
      { i: 0, bloques: ['B0', 'B1', 'B2', 'B5'], asientos: [18, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17], tramos: '[0,3)' },
      { i: 1, bloques: ['B3'], asientos: [8, 9, 10], tramos: '[1,3)' },
      { i: 2, bloques: ['B4'], asientos: [11, 12, 13], tramos: '[2,3)' },
    ] as const;

    beforeAll(async () => {
      for (const r of REPARTO) {
        await cloud.query(
          `INSERT INTO core.cupo_offline (id, salida_id, sucursal_id, asientos, bloques, tramos,
                                          vigente_desde, vigente_hasta)
           VALUES (core.uuid_v7(), $1, $2, $3::smallint[], $4::text[], $5::int4range,
                   now(), now() + interval '3 days')
           ON CONFLICT (salida_id, sucursal_id) DO UPDATE
             SET asientos = EXCLUDED.asientos, bloques = EXCLUDED.bloques`,
          [IDS.salida, IDS.sucursales[r.i], r.asientos, r.bloques, r.tramos],
        );
      }
    }, 120_000);

    it('los cupos son disjuntos y cubren exactamente las 18 plazas', async () => {
      // Esta es la propiedad que hace la sobreventa offline IMPOSIBLE, no improbable.
      // Si algún día el reparto dejara un asiento en dos cupos, la garantía del §3.4
      // dejaría de ser cierta en silencio y solo se notaría con el pasajero enfrente.
      const { rows } = await cloud.query<{ sucursal_id: string; asientos: number[] }>(
        `SELECT sucursal_id, asientos FROM core.cupo_offline WHERE salida_id = $1`, [IDS.salida],
      );
      expect(rows.length).toBe(3);

      const todos = rows.flatMap((r) => r.asientos);
      expect(new Set(todos).size, 'un asiento aparece en dos cupos: sobreventa posible offline').toBe(todos.length);
      expect(todos.length, 'los cupos deben sumar las 18 plazas vendibles').toBe(18);
      expect([...new Set(todos)].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 18 }, (_, i) => i + 1),
      );
    }, 60_000);

    it('cada sucursal intermedia recibe una fila COMPLETA, para que una pareja no quede separada', async () => {
      // Motivo operativo, no estético: con asientos sueltos de filas distintas, una
      // pareja que compra en la intermedia quedaría separada aunque la unidad vaya
      // vacía, y el cliente no tendría forma de entender por qué (01b §3.2).
      const filas: Record<string, number[]> = {
        B3: [8, 9, 10],
        B4: [11, 12, 13],
      };
      for (const [i, bloque] of [[1, 'B3'], [2, 'B4']] as const) {
        const { rows } = await cloud.query<{ asientos: number[]; bloques: string[] }>(
          `SELECT asientos, bloques FROM core.cupo_offline WHERE salida_id = $1 AND sucursal_id = $2`,
          [IDS.salida, IDS.sucursales[i]],
        );
        expect(rows[0]!.bloques).toEqual([bloque]);
        expect([...rows[0]!.asientos].sort((a, b) => a - b)).toEqual(filas[bloque]);
      }
    }, 60_000);

    it('dos nodos offline venden a la vez dentro de su cupo y convergen sin un solo conflicto', async () => {
      const [s1, s2] = [nodos[0]!, nodos[1]!];
      // Cada uno toma un asiento de SU bloque. Sin red, ninguno puede ver al otro —
      // y no le hace falta: los conjuntos son disjuntos por construcción.
      const a = await vender(s1, { ids: IDS, sucursalId: IDS.sucursales[0]!, asiento: 16, tramos: '[0,3)' });
      const b = await vender(s2, { ids: IDS, sucursalId: IDS.sucursales[1]!, asiento: 9, tramos: '[1,3)' });
      expect(a.ok, a.motivo ?? '').toBe(true);
      expect(b.ok, b.motivo ?? '').toBe(true);

      const r1 = await push(s1, cloud, { versionNodo: 'N' });
      const r2 = await push(s2, cloud, { versionNodo: 'N' });
      expect(r1.conflictos + r2.conflictos, 'un cupo disjunto no puede producir conflicto').toBe(0);
      expect(r1.rechazadas + r2.rechazadas).toBe(0);

      const firmes = await contar(
        cloud,
        `SELECT count(*) AS n FROM core.asiento_ocupacion
          WHERE salida_id = $1 AND asiento_num = ANY($2::smallint[]) AND estado = 'firme'`,
        [IDS.salida, [16, 9]],
      );
      expect(firmes).toBe(2);
    }, 180_000);
  });

  // -------------------------------------------------------------------------
  // F0 · 7 — override que sí colisiona
  // -------------------------------------------------------------------------
  it('7 · cuando dos nodos fuerzan el mismo asiento, la nube conserva UN solo dueño firme', async () => {
    // Simula el override de gerente del 01b §6: S3 vende un asiento que no es de su
    // cupo. Localmente puede, porque su base no sabe de la venta ajena; la nube lo
    // detecta con la restricción de exclusión y NO pierde la fila: la marca conflicto.
    const [s1, s3] = [nodos[0]!, nodos[2]!];
    const asiento = 17;

    const a = await vender(s1, { ids: IDS, sucursalId: IDS.sucursales[0]!, asiento, tramos: '[0,3)' });
    expect(a.ok, a.motivo ?? '').toBe(true);
    await push(s1, cloud, { versionNodo: 'N' });

    const b = await vender(s3, { ids: IDS, sucursalId: IDS.sucursales[2]!, asiento, tramos: '[0,3)' });
    expect(b.ok, 'el segundo nodo SÍ puede venderlo localmente: no sabe de la otra venta').toBe(true);

    const r = await push(s3, cloud, { versionNodo: 'N' });
    expect(r.conflictos, 'la nube debió detectar el traslape').toBeGreaterThanOrEqual(1);

    const firmes = await contar(
      cloud,
      `SELECT count(*) AS n FROM core.asiento_ocupacion
        WHERE salida_id = $1 AND asiento_num = $2 AND estado = 'firme'`,
      [IDS.salida, asiento],
    );
    expect(firmes, 'el asiento no puede tener dos dueños firmes').toBe(1);

    // El perdedor NUNCA se borra: entra a la cola de excepciones, visible en la caja de
    // la sucursal afectada y en el tablero del administrador.
    const excepciones = await contar(
      cloud,
      `SELECT count(*) AS n FROM sync.excepcion
        WHERE sucursal_id = $1 AND tipo = 'sobreventa' AND severidad = 'critica' AND estado = 'abierta'`,
      [IDS.sucursales[2]],
    );
    expect(excepciones).toBeGreaterThanOrEqual(1);
  }, 240_000);
});

// ---------------------------------------------------------------------------

interface AckLote {
  aceptadas: number;
  ignoradas: number;
  conflictos: number;
  rechazadas: number;
  filas: { estado: string; motivo: string | null }[];
}

/** El payload que el nodo dejó en el outbox para ese boleto: lo que un nodo manda de verdad. */
async function payloadDeBoleto(node: Client, boletoId: string): Promise<Record<string, unknown>> {
  const { rows } = await node.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM sync.outbox WHERE fila_id = $1 AND tabla = 'core.boleto' ORDER BY seq LIMIT 1`,
    [boletoId],
  );
  return rows[0]!.payload;
}

/**
 * Clona un payload con `id` y `folio` nuevos, conservando el resto.
 *
 * Los escenarios de N-1 tienen que probar el camino de INSERCIÓN, que es donde una
 * columna faltante duele. Reingerir el mismo `id` solo probaría el UPDATE, que ya tiene
 * todas las columnas puestas y no diría nada.
 */
async function conNuevaIdentidad(
  node: Client, payload: Record<string, unknown>, sucursalId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await node.query<{ id: string; folio: string }>(
    `SELECT core.uuid_v7() AS id, core.siguiente_folio($1) AS folio`, [sucursalId],
  );
  return { ...payload, id: rows[0]!.id, folio: rows[0]!.folio };
}

/** Arma e ingesta un lote a mano. Es la única forma de simular un binario de otra versión. */
async function ingest(
  cloud: Client,
  sucursalId: string,
  versionNodo: string,
  filas: { tabla: string; fila_id: string; payload: unknown }[],
): Promise<AckLote> {
  const { rows: idRows } = await cloud.query<{ id: string }>('SELECT core.uuid_v7() AS id');
  const { rows } = await cloud.query<{ ack: AckLote }>(
    'SELECT sync.ingest_batch($1::jsonb) AS ack',
    [JSON.stringify({
      lote_id: idRows[0]!.id,
      sucursal_id: sucursalId,
      version_nodo: versionNodo,
      filas: filas.map((f, i) => ({ seq: i + 1, ...f })),
    })],
  );
  return rows[0]!.ack;
}
