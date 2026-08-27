/**
 * PoC de sincronización — criterio de aceptación de F0.
 *
 * docs/architecture/04-riesgos-roadmap.md §3 (F0):
 *   "dos instancias PostgreSQL locales + un Supabase de prueba; outbox, pull y una
 *    EXCLUDE USING gist funcionando end-to-end con 2 escritores"
 *   "una escritura que viaja de local a nube y vuelve a otra réplica"
 *
 * Levanta dos bases locales desechables (S1 y S2) que hacen de terminales, las
 * sincroniza contra el Supabase real, y ejecuta siete escenarios que corresponden a las
 * afirmaciones del blueprint. Cada escenario imprime lo que verifica y por qué importa.
 *
 *   npm run sync:poc              ejecuta todo
 *   npm run sync:poc -- --keep    conserva las bases de S1 y S2 para inspeccionarlas
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../db/connection.js';
import { aplicarEsquema } from '../db/schema.js';
import { withDatabase } from '../backup/verify.js';
import { bootstrap } from './bootstrap.js';
import { push, outboxPendiente } from './push.js';
import { pull } from './pull.js';

const KEEP = process.argv.includes('--keep');
const DB_S1 = 'donaji_poc_s1';
const DB_S2 = 'donaji_poc_s2';

// Identificadores fijos para que la PoC sea reejecutable y legible en la nube.
const ID = {
  agencia: '01900000-0000-7000-8000-000000000001',
  s1: '01900000-0000-7000-8000-0000000000a1',
  s2: '01900000-0000-7000-8000-0000000000a2',
  usuarioS1: '01900000-0000-7000-8000-0000000000b1',
  usuarioS2: '01900000-0000-7000-8000-0000000000b2',
  ruta: '01900000-0000-7000-8000-0000000000c1',
  horario: '01900000-0000-7000-8000-0000000000d1',
  salida: '01900000-0000-7000-8000-0000000000e1',
};

let fallos = 0;

function check(ok: boolean, texto: string, detalle = ''): void {
  if (!ok) fallos++;
  console.log(`   ${ok ? 'OK   ' : 'FALLA'} ${texto}${detalle ? ` — ${detalle}` : ''}`);
}

function titulo(n: number, texto: string): void {
  console.log(`\n${'-'.repeat(70)}\n${n}. ${texto}\n${'-'.repeat(70)}`);
}

async function conectar(url: string, ssl: boolean): Promise<Client> {
  const c = new Client(ssl ? { connectionString: url, ssl: { rejectUnauthorized: false } } : { connectionString: url });
  await c.connect();
  return c;
}

/** Crea una base local desechable con el esquema completo, como una terminal recién instalada. */
async function crearNodo(admin: Client, localUrl: string, dbName: string, sucursalId: string): Promise<Client> {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);

  const node = await conectar(withDatabase(localUrl, dbName), false);
  await aplicarEsquema(node, { withSeeds: false, silencioso: true });
  await node.query(
    `UPDATE sync.nodo SET sucursal_id = $1, es_nube = false, version_binario = 'poc' WHERE singleton`,
    [sucursalId],
  );
  return node;
}

/** Datos maestros que el administrador captura en la nube y bajan a las terminales. */
async function sembrarNube(cloud: Client): Promise<void> {
  await cloud.query(`UPDATE sync.nodo SET es_nube = true WHERE singleton`);

  // Limpieza SOLO de lo transaccional de corridas previas. Los datos maestros se
  // reescriben con upsert en vez de borrarse: `sucursal` es referenciada por
  // `folio_secuencia`, que se crea sola por trigger, y borrarla en cascada destruiría
  // el contador de folios de esa sucursal — precisamente lo que garantiza que dos
  // terminales offline nunca generen el mismo folio.
  await cloud.query(`DELETE FROM core.asiento_ocupacion WHERE salida_id = $1`, [ID.salida]);
  await cloud.query(`DELETE FROM core.boleto WHERE salida_id = $1`, [ID.salida]);
  await cloud.query(`DELETE FROM core.venta WHERE salida_id = $1`, [ID.salida]);
  await cloud.query(`DELETE FROM sync.excepcion WHERE sucursal_id = ANY($1::uuid[])`, [[ID.s1, ID.s2]]);

  await cloud.query(
    `INSERT INTO core.agencia (id, nombre) VALUES ($1, 'Donaji PoC')
     ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [ID.agencia],
  );

  const sucursal = (id: string, codigo: string, nombre: string): Promise<unknown> =>
    cloud.query(
      `INSERT INTO core.sucursal (id, agencia_id, nombre, direccion_completa, telefono_principal, codigo)
       VALUES ($1, $2, $3, 'Av. Principal 1', '953 000 0000', $4)
       ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre,
                                      telefono_principal = EXCLUDED.telefono_principal`,
      [id, ID.agencia, nombre, codigo],
    );
  await sucursal(ID.s1, 'A', 'Terminal Origen');
  await sucursal(ID.s2, 'B', 'Terminal Intermedia');

  const usuario = (id: string, nombre: string, email: string): Promise<unknown> =>
    cloud.query(
      `INSERT INTO core.usuario (id, nombre, email, rol) VALUES ($1, $2, $3, 'vendedor')
       ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre`,
      [id, nombre, email],
    );
  await usuario(ID.usuarioS1, 'Vendedor S1', 's1@poc.local');
  await usuario(ID.usuarioS2, 'Vendedor S2', 's2@poc.local');

  await cloud.query(
    `INSERT INTO core.ruta (id, nombre, sucursal_origen_id, sucursal_destino_id)
     VALUES ($1, 'S1 - S2', $2, $3)
     ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [ID.ruta, ID.s1, ID.s2],
  );
  await cloud.query(
    `INSERT INTO core.horario (id, ruta_id, hora_salida, dias_semana)
     VALUES ($1, $2, '07:00', ARRAY[1,2,3,4,5,6,7])
     ON CONFLICT (id) DO UPDATE SET hora_salida = EXCLUDED.hora_salida`,
    [ID.horario, ID.ruta],
  );
  await cloud.query(
    `INSERT INTO core.salida (id, horario_id, fecha_operacion, tipo_unidad_id, mapa_snapshot)
     SELECT $1, $2, current_date + 7, id, mapa FROM core.tipo_unidad ORDER BY creado_en LIMIT 1
     ON CONFLICT (id) DO UPDATE SET fecha_operacion = EXCLUDED.fecha_operacion`,
    [ID.salida, ID.horario],
  );
}

/** Vende un asiento en un nodo. Simula la operación real de una caja. */
async function vender(
  node: Client,
  args: { sucursalId: string; usuarioId: string; asiento: number; tramos: string; pasajero: string },
): Promise<{ ok: boolean; motivo: string | null }> {
  try {
    await node.query('BEGIN');
    const { rows: v } = await node.query<{ id: string }>(
      `INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, contacto_telefono, salida_id,
                               parada_origen_orden, parada_destino_orden, importe_total)
       VALUES (core.uuid_v7(), $1, $2, '953 111 2222', $3, 0, 1, 450) RETURNING id`,
      [args.sucursalId, args.usuarioId, ID.salida],
    );
    const { rows: b } = await node.query<{ id: string }>(
      `INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, pasajero_nombre, importe)
       VALUES (core.uuid_v7(), $1, core.siguiente_folio($2), $3, $4, $5::int4range, $6, 450) RETURNING id`,
      [v[0]!.id, args.sucursalId, ID.salida, args.asiento, args.tramos, args.pasajero],
    );
    await node.query(
      `INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, boleto_id, estado, sucursal_id, emitido_en)
       VALUES (core.uuid_v7(), $1, $2, $3::int4range, $4, 'firme', $5, now())`,
      [ID.salida, args.asiento, args.tramos, b[0]!.id, args.sucursalId],
    );
    await node.query('COMMIT');
    return { ok: true, motivo: null };
  } catch (err) {
    await node.query('ROLLBACK');
    const motivo = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
    return { ok: false, motivo };
  }
}

async function main(): Promise<void> {
  const localConn = resolveConnection('local');
  const cloudConn = resolveConnection('nube');

  console.log(`Local : ${localConn.describe}`);
  console.log(`Nube  : ${cloudConn.describe}`);

  const admin = await conectar(withDatabase(localConn.url, 'postgres'), false);
  const cloud = await conectar(cloudConn.url, true);

  let s1: Client | null = null;
  let s2: Client | null = null;

  try {
    titulo(1, 'Instalación de dos terminales y siembra de datos maestros en la nube');
    s1 = await crearNodo(admin, localConn.url, DB_S1, ID.s1);
    s2 = await crearNodo(admin, localConn.url, DB_S2, ID.s2);
    check(true, 'dos nodos creados con el esquema de producción', `${DB_S1}, ${DB_S2}`);

    await sembrarNube(cloud);
    const { rows: log } = await cloud.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.cambio_log WHERE fila_id = $1`, [ID.salida],
    );
    check(Number(log[0]!.n) > 0, 'la escritura en la nube generó cambio_log por trigger');

    titulo(2, 'Bootstrap: carga inicial completa de las dos terminales');
    console.log('   El log incremental NO basta: no contiene lo que existía antes de que');
    console.log('   la base fuera marcada como nube (p. ej. el catálogo de unidades).');

    for (const [nombre, node] of [['S1', s1], ['S2', s2]] as const) {
      const b = await bootstrap(node, cloud);
      console.log(`   ${nombre}: ${b.total} filas en ${Object.keys(b.filasPorTabla).length} tablas, cursor=${b.cursorInicial}`);
      check(b.puedeVender, `${nombre} convergió hasta nivel 5 y ya puede vender`);
      const { rows } = await node.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.tipo_unidad`,
      );
      check(Number(rows[0]!.n) === 1, `${nombre} recibió el catálogo de unidades (Sprinter 18)`);
    }

    titulo(3, 'Pull incremental: un cambio posterior del administrador baja a las terminales');
    await cloud.query(`UPDATE core.sucursal SET telefono_principal = '953 999 8888' WHERE id = $1`, [ID.s2]);

    const p1 = await pull(s1, cloud);
    const p2 = await pull(s2, cloud);
    console.log(`   S1 aplicó ${p1.aplicadas} filas, S2 aplicó ${p2.aplicadas}`);

    for (const [nombre, node] of [['S1', s1], ['S2', s2]] as const) {
      const { rows } = await node.query<{ tel: string }>(
        `SELECT telefono_principal AS tel FROM core.sucursal WHERE id = $1`, [ID.s2],
      );
      check(rows[0]?.tel === '953 999 8888', `${nombre} recibió el cambio de teléfono`, rows[0]?.tel ?? 'sin fila');
    }

    titulo(4, 'Venta OFFLINE en S1: se acumula en el outbox sin tocar la nube');
    const venta = await vender(s1, {
      sucursalId: ID.s1, usuarioId: ID.usuarioS1, asiento: 9, tramos: '[0,2)', pasajero: 'ANA MUÑOZ',
    });
    check(venta.ok, 'S1 vendió el asiento 9 sin conexión', venta.motivo ?? '');

    const pendientes = await outboxPendiente(s1);
    check(pendientes > 0, 'la venta quedó en el outbox esperando conexión', `${pendientes} filas`);

    const { rows: antes } = await cloud.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.asiento_ocupacion WHERE salida_id = $1`, [ID.salida],
    );
    check(Number(antes[0]!.n) === 0, 'la nube todavía NO sabe de esa venta');

    titulo(5, 'Push: la venta sube a la nube al reconectar');
    const r1 = await push(s1, cloud, { versionNodo: 'poc' });
    console.log(`   ${r1.lotes} lote(s), ${r1.enviadas} filas: ${r1.aceptadas} aceptadas, ` +
      `${r1.ignoradas} ignoradas, ${r1.conflictos} conflictos, ${r1.rechazadas} rechazadas`);
    check(r1.rechazadas === 0 && r1.conflictos === 0, 'la nube aceptó el lote completo');

    const { rows: enNube } = await cloud.query<{ folio: string; asiento: number }>(
      `SELECT b.folio, o.asiento_num AS asiento
         FROM core.asiento_ocupacion o JOIN core.boleto b ON b.id = o.boleto_id
        WHERE o.salida_id = $1`, [ID.salida],
    );
    check(enNube.length === 1 && enNube[0]!.asiento === 9,
      'el asiento vendido en S1 está en la nube', enNube[0] ? `folio ${enNube[0].folio}` : '');
    check(await outboxPendiente(s1) === 0, 'el outbox de S1 quedó drenado');

    titulo(6, 'Idempotencia: reenviar el mismo lote no duplica nada');
    const loteId = r1.acks[0]!.lote_id;
    const original = r1.acks[0]!;
    for (let i = 1; i <= 3; i++) {
      const { rows } = await cloud.query<{ ack: { idempotente: boolean; aceptadas: number } }>(
        'SELECT sync.ingest_batch($1::jsonb) AS ack',
        [JSON.stringify({
          lote_id: loteId, sucursal_id: ID.s1, version_nodo: 'poc',
          filas: original.filas.map((f) => ({ seq: f.seq, tabla: 'core.boleto', fila_id: f.fila_id, payload: {} })),
        })],
      );
      check(rows[0]!.ack.idempotente === true, `reenvío ${i} reconocido como duplicado, no reprocesado`);
    }
    const { rows: sigue } = await cloud.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.asiento_ocupacion WHERE salida_id = $1`, [ID.salida],
    );
    check(Number(sigue[0]!.n) === 1, 'sigue habiendo exactamente una ocupación tras 3 reenvíos');

    titulo(7, 'Dos escritores en conflicto: S2 vende el MISMO asiento estando offline');
    console.log('   (simula un override de gerente o un cupo mal repartido: el caso que');
    console.log('    el reparto por bloques disjuntos hace imposible en operación normal)');

    const ventaS2 = await vender(s2, {
      sucursalId: ID.s2, usuarioId: ID.usuarioS2, asiento: 9, tramos: '[0,2)', pasajero: 'LUIS PEREZ',
    });
    check(ventaS2.ok, 'S2 pudo venderlo LOCALMENTE: su base no sabe de la venta de S1');

    const r2 = await push(s2, cloud, { versionNodo: 'poc' });
    console.log(`   S2 subió ${r2.enviadas} filas: ${r2.aceptadas} aceptadas, ${r2.conflictos} conflictos`);
    check(r2.conflictos >= 1, 'la NUBE detectó el traslape y marcó conflicto');

    const { rows: ocup } = await cloud.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.asiento_ocupacion
        WHERE salida_id = $1 AND asiento_num = 9 AND estado = 'firme'`, [ID.salida],
    );
    check(Number(ocup[0]!.n) === 1, 'en la nube el asiento 9 sigue teniendo UN solo dueño');

    const { rows: exc } = await cloud.query<{ tipo: string; severidad: string }>(
      `SELECT tipo, severidad FROM sync.excepcion
        WHERE sucursal_id = $1 AND estado = 'abierta' ORDER BY creado_en DESC LIMIT 1`, [ID.s2],
    );
    check(exc[0]?.tipo === 'sobreventa' && exc[0]?.severidad === 'critica',
      'quedó una excepción crítica visible para la caja y el administrador',
      exc[0] ? `${exc[0].tipo}/${exc[0].severidad}` : 'ninguna');

    console.log(`\n${'='.repeat(70)}`);
    if (fallos === 0) {
      console.log('PoC DE SINCRONIZACIÓN: todos los escenarios pasaron.');
      console.log('Criterio F0 cumplido: escritura local -> nube -> otra réplica, con');
      console.log('idempotencia de lotes y arbitraje de conflicto de asiento en la nube.');
    } else {
      console.log(`PoC DE SINCRONIZACIÓN: ${fallos} verificación(es) FALLARON.`);
      process.exitCode = 1;
    }
    console.log('='.repeat(70));
  } finally {
    await s1?.end();
    await s2?.end();
    await cloud.end();
    if (!KEEP) {
      for (const db of [DB_S1, DB_S2]) {
        await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => { /* mejor esfuerzo */ });
      }
    } else {
      console.log(`\nBases conservadas: ${DB_S1}, ${DB_S2}`);
    }
    await admin.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
