/**
 * Banco de pruebas de caos para el motor de sincronización (F1).
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F1)
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 * Las garantías del motor no viven en TypeScript: viven en `EXCLUDE USING gist`, en
 * `ON CONFLICT ... WHERE`, en el aislamiento MVCC y en los triggers. Una prueba con
 * mocks probaría el mock. Por eso todo aquí levanta PostgreSQL de verdad y aplica
 * EXACTAMENTE las migraciones de producción — un nodo construido por otro camino
 * probaría otro sistema.
 *
 * DOS SABORES DE "NUBE", A PROPÓSITO:
 *
 *   nube REAL (Supabase)   — se usa solo en `f1-criterios.test.ts`, porque los criterios
 *                            de aceptación de F1 dicen literalmente "presentes en nube".
 *                            Es compartida y de plan Free: cada prueba usa identificadores
 *                            propios bajo el prefijo `019caa5f-` y limpia lo que creó.
 *   nube SIMULADA (local)  — una base local desechable con `sync.nodo.es_nube = true`.
 *                            Corre las mismas migraciones y por tanto los mismos
 *                            triggers (`cambio_log`, `ingest_batch`, EXCLUDE), así que
 *                            es fiel para todo lo que no sea "¿llegó a Supabase?".
 *                            Los escenarios de caos la usan: son decenas de ciclos, y
 *                            hacerlos contra una base compartida sería caro y sucio.
 *
 * LIMPIEZA: toda base local se llama `donaji_caos_*` y se destruye al terminar. En la
 * nube se borra solo lo transaccional propio; NUNCA se borra `core.sucursal` ni
 * `core.agencia`, porque `core.folio_secuencia` cuelga de la sucursal por trigger y
 * borrarla en cascada destruiría el contador de folios de esa terminal — que es
 * justamente lo que impide que dos cajas offline emitan el mismo folio.
 */

import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { aplicarEsquema } from '../../src/db/schema.js';
import { pull, type PullResult } from '../../src/sync/pull.js';
import { withDatabase } from '../../src/backup/verify.js';

// ---------------------------------------------------------------------------
// Disponibilidad del entorno
// ---------------------------------------------------------------------------

/** ¿Hay PostgreSQL local? Sin él no se puede probar nada: todo es DDL real. */
export const hayLocal = Boolean(process.env['LOCAL_DATABASE_URL']);

/** ¿Hay nube? Solo la exigen los criterios de F1 redactados contra "la nube". */
export const hayNube = Boolean(process.env['DATABASE_URL']);

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

/**
 * Prefijo reconocible de todo lo que estas pruebas escriben en la nube compartida.
 *
 * Es deliberadamente grepeable: quien abra Supabase y vea `019caa5f-...` sabe que es
 * basura de pruebas de caos y no un dato de operación. Sin esta convención, limpiar
 * exige adivinar, y adivinar sobre datos de producción no es una opción.
 */
export const PREFIJO_CAOS = '019caa5f-0000-7000-8000-';

function uid(ns: string, tipo: string, i = 0): string {
  return PREFIJO_CAOS + ns + tipo + i.toString(16).padStart(8, '0');
}

export interface Ids {
  ns: string;
  agencia: string;
  /** Una por sucursal declarada. F1 exige verificar las 4 terminales. */
  sucursales: readonly string[];
  codigos: readonly string[];
  usuario: string;
  ruta: string;
  horario: string;
  salida: string;
}

/**
 * Construye el juego de identificadores de un archivo de pruebas.
 *
 * Cada archivo usa su propio `ns` porque vitest corre los archivos en paralelo y no
 * hay configuración de vitest en el repositorio que lo impida. Dos archivos que
 * compartieran identificadores se pisarían de forma intermitente — el peor tipo de
 * prueba inestable, la que falla una de cada diez corridas en la máquina de otro.
 */
export function construirIds(ns: string, codigos: readonly string[]): Ids {
  // El namespace se incrusta literal dentro de un UUID. Si no es hexadecimal, el error
  // aparecería como un `invalid input syntax for type uuid` en la primera consulta, a
  // varios archivos de distancia de la causa.
  if (!/^[0-9a-f]{2}$/.test(ns)) {
    throw new Error(`El namespace "${ns}" debe ser dos dígitos hexadecimales.`);
  }
  return {
    ns,
    agencia: uid(ns, '01'),
    sucursales: codigos.map((_, i) => uid(ns, '02', i)),
    codigos,
    usuario: uid(ns, '03'),
    ruta: uid(ns, '04'),
    horario: uid(ns, '05'),
    salida: uid(ns, '06'),
  };
}

// ---------------------------------------------------------------------------
// Conexiones y nodos desechables
// ---------------------------------------------------------------------------

/** Conexión de mantenimiento a la base `postgres` local: crea y destruye nodos. */
export async function abrirAdmin(): Promise<Client> {
  const c = new Client({ connectionString: withDatabase(resolveConnection('local').url, 'postgres') });
  await c.connect();
  return c;
}

/** Otra conexión a una base local ya existente. Necesaria para simular concurrencia. */
export async function abrirLocal(dbName: string): Promise<Client> {
  const c = new Client({ connectionString: withDatabase(resolveConnection('local').url, dbName) });
  await c.connect();
  return c;
}

export async function abrirNube(): Promise<Client> {
  const c = new Client(resolveConnection('nube').config);
  await c.connect();
  return c;
}

export interface NodoOptions {
  /** Sucursal que representa esta terminal. `null` en la nube. */
  sucursalId?: string | null;
  /** Marca la base como nube simulada: activa `cambio_log` y desactiva el outbox. */
  esNube?: boolean;
  versionBinario?: string;
  /**
   * Aplica los seeds (`src/db/seed/`).
   *
   * Por omisión: SÍ en la nube, NO en un nodo — el catálogo clase A baja por bootstrap.
   * Desde 0039 sembrar un nodo tampoco rompe nada: el `id` de `tipo_unidad` es
   * determinista por `clave` (`md5('core.tipo_unidad:' || clave)`), así que nodo y nube
   * convergen a la misma identidad. Ver "una terminal instalada CON seeds hace
   * bootstrap" en `caos-perdida.test.ts`.
   */
  conSeeds?: boolean;
}

/**
 * Crea una base local desechable con el esquema de producción, como una terminal
 * recién instalada por TeamViewer en la madrugada.
 */
export async function crearNodo(admin: Client, dbName: string, opts: NodoOptions = {}): Promise<Client> {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);

  const node = await abrirLocal(dbName);
  await aplicarEsquema(node, {
    withSeeds: opts.conSeeds ?? (opts.esNube ?? false),
    silencioso: true,
  });
  await node.query(
    `UPDATE sync.nodo
        SET sucursal_id = $1, es_nube = $2, version_binario = $3
      WHERE singleton`,
    [opts.sucursalId ?? null, opts.esNube ?? false, opts.versionBinario ?? 'caos'],
  );
  return node;
}

export async function soltarNodo(admin: Client, dbName: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {
    /* mejor esfuerzo: la base desechable no debe hacer fallar la suite */
  });
}

// ---------------------------------------------------------------------------
// Siembra de datos maestros (clase A: los captura el administrador en la nube)
// ---------------------------------------------------------------------------

/**
 * Deja en la nube el catálogo mínimo para poder vender: agencia, sucursales, usuario,
 * ruta, horario y una salida materializada.
 *
 * Se usa UPSERT en vez de DELETE + INSERT por la razón del comentario de cabecera:
 * borrar una sucursal arrastra su secuencia de folios. Reescribir es idempotente y
 * no destruye nada.
 */
export async function sembrarMaestros(cloud: Client, ids: Ids): Promise<void> {
  // "Agencia Donaji" y no un nombre de fixture: un `seed:qa` viejo reutilizó
  // esta fila (id `019caa5f-…a10100000000`, ns 'a1') como agencia principal, y la
  // carga inicial real la renombró (migración 0044). Que la suite escriba el
  // mismo nombre evita que un `npm test` lo revierta. La señal de "esto es de la
  // suite de caos" es el prefijo del id (`PREFIJO_CAOS`), no el nombre.
  await cloud.query(
    `INSERT INTO core.agencia (id, nombre) VALUES ($1, 'Agencia Donaji')
     ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [ids.agencia],
  );

  for (const [i, id] of ids.sucursales.entries()) {
    await cloud.query(
      `INSERT INTO core.sucursal (id, agencia_id, nombre, direccion_completa, telefono_principal, codigo)
       VALUES ($1, $2, $3, 'Av. Caos 1', '953 000 0000', $4)
       ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre,
                                      telefono_principal = EXCLUDED.telefono_principal`,
      [id, ids.agencia, `Terminal ${i + 1}`, ids.codigos[i]],
    );
  }

  await cloud.query(
    `INSERT INTO core.usuario (id, nombre, email, rol)
     VALUES ($1, 'Vendedor Caos', $2, 'vendedor')
     ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [ids.usuario, `caos-${ids.ns}@donaji.test`],
  );

  await cloud.query(
    `INSERT INTO core.ruta (id, nombre, sucursal_origen_id, sucursal_destino_id)
     VALUES ($1, 'Caos S1 - S4', $2, $3)
     ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [ids.ruta, ids.sucursales[0], ids.sucursales[ids.sucursales.length - 1]],
  );

  await cloud.query(
    `INSERT INTO core.horario (id, ruta_id, hora_salida, dias_semana)
     VALUES ($1, $2, '07:00', ARRAY[1,2,3,4,5,6,7])
     ON CONFLICT (id) DO UPDATE SET hora_salida = EXCLUDED.hora_salida`,
    [ids.horario, ids.ruta],
  );

  await cloud.query(
    `INSERT INTO core.salida (id, horario_id, fecha_operacion, tipo_unidad_id, mapa_snapshot)
     SELECT $1, $2, current_date + 7, id, mapa FROM core.tipo_unidad ORDER BY creado_en LIMIT 1
     ON CONFLICT (id) DO UPDATE SET fecha_operacion = EXCLUDED.fecha_operacion`,
    [ids.salida, ids.horario],
  );
}

/**
 * Borra de la nube SOLO lo que estas pruebas crearon, en orden inverso de dependencia.
 *
 * `core.sucursal` y `core.agencia` se dejan a propósito (ver cabecera). Son 4 filas
 * con prefijo `019caa5f-`, reutilizables entre corridas y sin costo.
 */
export async function limpiarNube(cloud: Client, ids: Ids): Promise<void> {
  const sucursales = [...ids.sucursales];
  const pasos: [string, unknown[]][] = [
    [`DELETE FROM core.asiento_ocupacion WHERE salida_id = $1`, [ids.salida]],
    [`DELETE FROM core.asiento_lease     WHERE salida_id = $1`, [ids.salida]],
    [`DELETE FROM core.boleto            WHERE salida_id = $1`, [ids.salida]],
    [`DELETE FROM core.venta             WHERE salida_id = $1`, [ids.salida]],
    [`DELETE FROM core.cupo_offline      WHERE salida_id = $1`, [ids.salida]],
    [`DELETE FROM core.salida_parada     WHERE salida_id = $1`, [ids.salida]],
    [`DELETE FROM core.salida            WHERE id = $1`, [ids.salida]],
    [`DELETE FROM core.horario_parada    WHERE horario_id = $1`, [ids.horario]],
    [`DELETE FROM core.horario           WHERE id = $1`, [ids.horario]],
    [`DELETE FROM core.tarifa            WHERE ruta_id = $1`, [ids.ruta]],
    [`DELETE FROM core.ruta_parada       WHERE ruta_id = $1`, [ids.ruta]],
    [`DELETE FROM core.ruta              WHERE id = $1`, [ids.ruta]],
    [`DELETE FROM core.usuario_sucursal  WHERE usuario_id = $1`, [ids.usuario]],
    [`DELETE FROM core.usuario           WHERE id = $1`, [ids.usuario]],
    [`DELETE FROM sync.excepcion         WHERE sucursal_id = ANY($1::uuid[])`, [sucursales]],
    [`DELETE FROM sync.lote_recibido     WHERE sucursal_id = ANY($1::uuid[])`, [sucursales]],
    [`DELETE FROM sync.checksum_bloque   WHERE sucursal_id = ANY($1::uuid[])`, [sucursales]],
    [`DELETE FROM sync.salud             WHERE sucursal_id = ANY($1::uuid[])`, [sucursales]],
    // Y el `cambio_log` que TODO esto publicó. Sin esto, cada corrida deja
    // huérfanos (los `core.*` se borran arriba pero el log no), y `repartir_cupo_offline`
    // genera ids nuevos cada vez: un nodo con cursor viejo se atasca en ellos.
    // Se barre por prefijo de id Y por el payload, que referencia la salida y las
    // sucursales de caos aunque su propio id sea aleatorio (cupo_offline, salida_parada).
    [`DELETE FROM sync.cambio_log
        WHERE fila_id::text LIKE '${PREFIJO_CAOS}%'
           OR payload::text LIKE '%${PREFIJO_CAOS}%'`, []],
  ];

  for (const [sql, params] of pasos) {
    // Mejor esfuerzo: si una prueba dejó una referencia inesperada, prefiero un residuo
    // identificable por prefijo antes que reventar el teardown y perder el diagnóstico.
    await cloud.query(sql, params).catch(() => { /* se reporta por el prefijo */ });
  }
}

// ---------------------------------------------------------------------------
// Operación de caja
// ---------------------------------------------------------------------------

export interface VentaArgs {
  ids: Ids;
  sucursalId: string;
  asiento: number;
  /** Rango de tramos, p. ej. `[0,3)`. */
  tramos: string;
  pasajero?: string;
  /** Antedata la escritura para simular días de operación acumulada sin red. */
  creadoEn?: Date;
  /** Omite la ocupación: sirve para volumen, donde 500 asientos no caben en 18 plazas. */
  sinOcupacion?: boolean;
}

export interface VentaResultado {
  ok: boolean;
  ventaId: string | null;
  boletoId: string | null;
  folio: string | null;
  motivo: string | null;
}

/**
 * Vende un asiento en un nodo: venta + boleto + ocupación, que es la cadena real.
 *
 * La ocupación no se puede fabricar suelta — `boleto_id` tiene clave foránea — y eso
 * es correcto: una ocupación sin boleto sería un asiento bloqueado sin dueño.
 */
export async function vender(node: Client, a: VentaArgs): Promise<VentaResultado> {
  const creado = a.creadoEn ?? null;
  try {
    await node.query('BEGIN');

    const { rows: v } = await node.query<{ id: string }>(
      `INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, contacto_telefono, salida_id,
                               parada_origen_orden, parada_destino_orden, importe_total, creado_en)
       VALUES (core.uuid_v7(), $1, $2, '953 111 2222', $3, 0, 3, 450, coalesce($4::timestamptz, now()))
       RETURNING id`,
      [a.sucursalId, a.ids.usuario, a.ids.salida, creado],
    );
    const ventaId = v[0]!.id;

    const { rows: b } = await node.query<{ id: string; folio: string }>(
      `INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos,
                                pasajero_nombre, importe, creado_en)
       VALUES (core.uuid_v7(), $1, core.siguiente_folio($2), $3, $4, $5::int4range, $6, 450,
               coalesce($7::timestamptz, now()))
       RETURNING id, folio`,
      [ventaId, a.sucursalId, a.ids.salida, a.asiento, a.tramos, a.pasajero ?? 'PASAJERO CAOS', creado],
    );
    const boleto = b[0]!;

    if (a.sinOcupacion !== true) {
      await node.query(
        `INSERT INTO core.asiento_ocupacion
           (id, salida_id, asiento_num, tramos, boleto_id, estado, sucursal_id, emitido_en, creado_en)
         VALUES (core.uuid_v7(), $1, $2, $3::int4range, $4, 'firme', $5,
                 coalesce($6::timestamptz, now()), coalesce($6::timestamptz, now()))`,
        [a.ids.salida, a.asiento, a.tramos, boleto.id, a.sucursalId, creado],
      );
    }

    await node.query('COMMIT');
    return { ok: true, ventaId, boletoId: boleto.id, folio: boleto.folio, motivo: null };
  } catch (err) {
    await node.query('ROLLBACK').catch(() => { /* la conexión pudo morir */ });
    const motivo = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
    return { ok: false, ventaId: null, boletoId: null, folio: null, motivo };
  }
}

// ---------------------------------------------------------------------------
// Utilidades de aserción
// ---------------------------------------------------------------------------

export async function contar(c: Client, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await c.query<{ n: string }>(sql, params);
  return Number(rows[0]!.n);
}

/**
 * Marca como confirmado el outbox que el bootstrap dejó atrás, SIN enviarlo.
 *
 * Hace falta por un defecto del motor, no por comodidad: `bootstrap` y `pull` escriben
 * la configuración con `sync.ingest_fila`, y eso dispara `sync.trg_outbox` en el nodo.
 * El resultado es que la terminal encola para SUBIR exactamente la configuración que
 * acaba de BAJAR — cuando el blueprint §4 dice que "el nodo nunca escribe estas tablas".
 *
 * Sin esta compensación, cualquier prueba que cuente el outbox mediría el eco además de
 * lo que vendió, y contra la nube real el eco reescribiría filas compartidas que estas
 * pruebas no crearon. El defecto en sí está reproducido en `caos-perdida.test.ts`.
 */
export async function silenciarEcoDeConfiguracion(node: Client): Promise<number> {
  // La lista de tablas de clase A se deriva de quién lleva el trigger `trg_cambio_log`,
  // no de una lista escrita a mano: así no puede desincronizarse del esquema, y así
  // esta función NUNCA puede tragarse una venta por descuido.
  const { rowCount } = await node.query(
    `UPDATE sync.outbox SET estado = 'confirmado'
      WHERE estado <> 'confirmado'
        AND tabla IN (
          SELECT n.nspname || '.' || c.relname
            FROM pg_trigger t
            JOIN pg_class c     ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE t.tgname = 'trg_cambio_log' AND NOT t.tgisinternal)`,
  );
  return rowCount ?? 0;
}

/** Estado del outbox agrupado. Un outbox que no drena es el síntoma de todo. */
export async function outboxPorEstado(node: Client): Promise<Record<string, number>> {
  const { rows } = await node.query<{ estado: string; n: string }>(
    `SELECT estado, count(*) AS n FROM sync.outbox GROUP BY estado`,
  );
  return Object.fromEntries(rows.map((r) => [r.estado, Number(r.n)]));
}

/**
 * Llama a `pull` hasta que avance, o se rinde tras `intentos`.
 *
 * NO es una comodidad de prueba: compensa un hallazgo. El filtro de `pull.ts` compara
 * contra `pg_snapshot_xmin(pg_current_snapshot())`, y los identificadores de
 * transacción son de TODO el servidor, no de la base. Cualquier transacción larga
 * abierta en cualquier otra base del mismo PostgreSQL —o, en Supabase, cualquier otra
 * carga sobre el mismo proyecto— hace que el filtro descarte todo y que `pull` devuelva
 * cero filas sin error.
 *
 * Sin este reintento, estas pruebas fallarían de forma intermitente según qué otro
 * archivo de vitest corriera en paralelo. El defecto tiene su propia prueba en
 * `caos-perdida.test.ts`.
 */
export async function pullHasta(
  node: Client,
  cloud: Client,
  condicion?: () => Promise<boolean>,
  opts: { intentos?: number; esperaMs?: number; descripcion?: string } = {},
): Promise<Pick<PullResult, 'aplicadas' | 'ignoradas' | 'rechazadas'>> {
  const intentos = opts.intentos ?? 120;
  const esperaMs = opts.esperaMs ?? 500;

  // Los totales se ACUMULAN entre intentos. Si el pull se desbloquea a medias, la fila
  // que interesa puede haberse aplicado en una vuelta anterior a la que cumple la
  // condición; devolver solo la última haría que la prueba afirmara cosas falsas sobre
  // cuántas filas se aplicaron o rechazaron.
  const total = { aplicadas: 0, ignoradas: 0, rechazadas: 0 };

  for (let i = 0; i < intentos; i++) {
    const r = await pull(node, cloud);
    total.aplicadas += r.aplicadas;
    total.ignoradas += r.ignoradas;
    total.rechazadas += r.rechazadas;

    const listo = condicion
      ? await condicion()
      : total.aplicadas + total.ignoradas + total.rechazadas > 0;
    if (listo) return total;

    await new Promise((res) => setTimeout(res, esperaMs));
  }

  // Rendirse en silencio devolvería ceros y la prueba fallaría con un
  // "esperaba 1, recibí 0" que no dice nada de la causa. Este mensaje sí.
  throw new Error(
    `El pull no alcanzó ${opts.descripcion ?? 'la condición esperada'} en ` +
      `${(intentos * esperaMs) / 1000} s (aplicadas=${total.aplicadas}, ` +
      `rechazadas=${total.rechazadas}). Si el motor está bien, casi siempre significa que ` +
      'hay una transacción larga abierta en ALGUNA base de este PostgreSQL: el filtro por ' +
      '`pg_snapshot_xmin` de pull.ts es de todo el servidor, no de la base. Ver la prueba ' +
      '"una transacción abierta en OTRA base detiene el pull" en caos-perdida.test.ts.',
  );
}

/** Cursor global de pull del nodo. */
export async function cursorDe(node: Client): Promise<number> {
  const { rows } = await node.query<{ seq: string }>(
    `SELECT coalesce(max(ultimo_seq), 0)::text AS seq FROM sync.cursor`,
  );
  return Number(rows[0]!.seq);
}

export interface Checksum {
  filas: number;
  hash: string;
}

/**
 * Checksum de bloque tal como lo define el blueprint §6.1: `md5` sobre `id || version`
 * de las filas de las que la sucursal es dueña, por tabla y día operativo.
 *
 * Se llama a la MISMA función SQL en los dos lados, no a dos implementaciones: si el
 * cálculo difiere entre extremos, el checksum deja de detectar pérdida y se vuelve
 * decorativo.
 */
export async function checksum(
  c: Client, tabla: string, sucursalId: string, dia: string,
  opts: { zonaHoraria?: string } = {},
): Promise<Checksum> {
  // `calcular_checksum` acota el bloque con `creado_en >= dia AND < dia + 1`, y esos
  // literales se interpretan en la ZONA HORARIA DE LA SESIÓN. El nodo corre en
  // America/Mexico_City y Supabase en UTC, así que sin fijarla los dos lados comparan
  // ventanas distintas. Ver la prueba "3b" en `f1-criterios.test.ts`.
  if (opts.zonaHoraria !== undefined) {
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL TimeZone = '${opts.zonaHoraria}'`);
      const { rows } = await c.query<{ filas: number; hash: string }>(
        `SELECT filas, hash FROM sync.calcular_checksum($1::regclass, $2::uuid, $3::date)`,
        [tabla, sucursalId, dia],
      );
      return { filas: rows[0]!.filas, hash: rows[0]!.hash };
    } finally {
      await c.query('COMMIT').catch(() => { /* la sesión pudo morir */ });
    }
  }

  const { rows } = await c.query<{ filas: number; hash: string }>(
    `SELECT filas, hash FROM sync.calcular_checksum($1::regclass, $2::uuid, $3::date)`,
    [tabla, sucursalId, dia],
  );
  return { filas: rows[0]!.filas, hash: rows[0]!.hash };
}

/** Fecha operativa de hoy en formato `YYYY-MM-DD`, que es el bloque del checksum. */
export function hoy(): string {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/**
 * Lo mismo, pero en UTC.
 *
 * Se necesita para comparar bloques entre un nodo en America/Mexico_City y una nube en
 * UTC: mientras el motor no fije la zona, la única forma de que ambos lados recorten el
 * mismo día es acordar UTC explícitamente. Ver la prueba 3b de `f1-criterios.test.ts`.
 */
export function hoyUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Adelanta o atrasa el reloj híbrido del nodo sin tocar el reloj del sistema operativo.
 *
 * El HLC es lo único que el motor usa para ordenar, así que mover `sync.hlc_estado`
 * simula fielmente una terminal con NTP roto — que es el riesgo R5 — sin exigir
 * privilegios de administrador ni ensuciar la máquina de quien corre las pruebas.
 */
export async function desviarReloj(node: Client, segundos: number): Promise<void> {
  await node.query(
    `UPDATE sync.hlc_estado SET ultimo_ts = now() + make_interval(secs => $1) WHERE singleton`,
    [segundos],
  );
}
