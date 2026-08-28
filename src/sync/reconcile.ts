/**
 * Reconciliación por checksum: la defensa contra pérdida silenciosa.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §6.1
 *
 * POR QUÉ ESTO EXISTE:
 * El push confirma filas contra un ACK, y eso cubre los fallos ruidosos. Pero un motor de
 * sincronización puede perder datos **sin que nadie reciba un error**: un cursor que
 * avanza de más, un lote marcado confirmado tras un ACK parcial, una fila que se escribió
 * mientras alguien restauraba un respaldo. Nadie lo nota hasta el cierre de mes — y para
 * entonces la evidencia física, los tickets en papel, ya no existe.
 *
 * La reconciliación compara, por tabla y por día operativo, un hash de las filas que la
 * sucursal cree haber creado contra el de las que la nube cree haber recibido. Si
 * difieren, baja al detalle fila a fila (`sync.filas_bloque`) para nombrar exactamente
 * qué falta de cada lado, y reencola SOLO esas filas — no el día entero.
 */

import type { Client } from 'pg';
import { tablasReconciliables } from './clases.js';

export interface BloqueChecksum {
  tabla: string;
  dia: string;
  filasLocal: number;
  filasNube: number;
  hashLocal: string;
  hashNube: string;
  coincide: boolean;
  /** Ids que el nodo tiene y la nube no: se pueden reenviar. */
  soloEnLocal: string[];
  /** Ids que la nube tiene y el nodo no: pérdida local, atención humana. */
  soloEnNube: string[];
  /** Ids presentes en ambos con `version` distinta: divergencia de contenido. */
  versionDistinta: string[];
}

export interface ReconcileResult {
  sucursalId: string;
  bloques: BloqueChecksum[];
  divergentes: BloqueChecksum[];
  /** Filas reencoladas para volver a subir por una divergencia detectada. */
  reencoladas: number;
}

export interface ReconcileOptions {
  /** Días hacia atrás a comparar. Blueprint: job diario; por defecto una semana. */
  dias?: number;
  /** Reencolar automáticamente las filas de los bloques divergentes. */
  repararAutomaticamente?: boolean;
  tablas?: string[];
}

interface FilaChecksum {
  filas: number;
  hash: string;
}

type DiffBloque = Pick<BloqueChecksum, 'soloEnLocal' | 'soloEnNube' | 'versionDistinta'>;
const DIFF_VACIO: DiffBloque = { soloEnLocal: [], soloEnNube: [], versionDistinta: [] };

/**
 * Calcula el checksum de un bloque usando la función que ya vive en la base.
 *
 * Se ejecuta la MISMA función SQL en los dos lados (`sync.calcular_checksum`). Calcularlo
 * en TypeScript de un lado y en SQL del otro introduciría diferencias de ordenamiento,
 * de representación de nulos o de `collation` que se verían como divergencia de datos
 * cuando en realidad son divergencia de implementación — el peor tipo de falsa alarma,
 * porque erosiona la confianza en la herramienta que debe detectar pérdidas reales.
 */
async function checksumDe(
  client: Client,
  tabla: string,
  sucursalId: string,
  dia: string,
): Promise<FilaChecksum> {
  const { rows } = await client.query<{ filas: number; hash: string | null }>(
    `SELECT filas, hash FROM sync.calcular_checksum($1::regclass, $2::uuid, $3::date)`,
    [tabla, sucursalId, dia],
  );
  return { filas: rows[0]?.filas ?? 0, hash: rows[0]?.hash ?? '' };
}

/** `id -> version` de todas las filas de un bloque, para diferenciarlas. */
async function filasDe(
  client: Client,
  tabla: string,
  sucursalId: string,
  dia: string,
): Promise<Map<string, number>> {
  const { rows } = await client.query<{ id: string; version: number }>(
    `SELECT id, version FROM sync.filas_bloque($1::regclass, $2::uuid, $3::date)`,
    [tabla, sucursalId, dia],
  );
  return new Map(rows.map((r) => [r.id, r.version]));
}

/**
 * Diferencia de conjuntos de un bloque divergente.
 *
 * `sync.calcular_checksum` ya dijo que el bloque no coincide; aquí se baja a las filas
 * para saber QUÉ reenviar. Distinguir "falta en la nube" de "falta en el nodo" importa:
 * lo primero se repara con un re-push, lo segundo es una pérdida local que exige
 * restaurar un respaldo y no puede repararse sola.
 */
async function diffBloque(
  node: Client,
  cloud: Client,
  tabla: string,
  sucursalId: string,
  dia: string,
): Promise<DiffBloque> {
  const [locales, remotas] = await Promise.all([
    filasDe(node, tabla, sucursalId, dia),
    filasDe(cloud, tabla, sucursalId, dia),
  ]);

  const soloEnLocal: string[] = [];
  const versionDistinta: string[] = [];
  for (const [id, version] of locales) {
    const enNube = remotas.get(id);
    if (enNube === undefined) soloEnLocal.push(id);
    else if (enNube !== version) versionDistinta.push(id);
  }
  const soloEnNube = [...remotas.keys()].filter((id) => !locales.has(id));

  return { soloEnLocal, soloEnNube, versionDistinta };
}

/** Días operativos a comparar, del más reciente hacia atrás. */
function diasARevisar(dias: number, hoy = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < dias; i++) {
    const d = new Date(hoy);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export async function reconciliar(
  node: Client,
  cloud: Client,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const dias = opts.dias ?? 7;
  const tablas = opts.tablas ?? tablasReconciliables();

  const { rows: nodoRows } = await node.query<{ sucursal_id: string | null }>(
    'SELECT sucursal_id FROM sync.nodo WHERE singleton',
  );
  const sucursalId = nodoRows[0]?.sucursal_id;
  if (!sucursalId) throw new Error('El nodo no tiene sucursal_id configurado en sync.nodo');

  const bloques: BloqueChecksum[] = [];

  for (const tabla of tablas) {
    for (const dia of diasARevisar(dias)) {
      const local = await checksumDe(node, tabla, sucursalId, dia);
      const nube = await checksumDe(cloud, tabla, sucursalId, dia);

      // Un bloque vacío en los dos lados no aporta nada y multiplicaría el ruido:
      // 11 tablas x 7 días son 77 comparaciones, casi todas vacías en una sucursal nueva.
      if (local.filas === 0 && nube.filas === 0) continue;

      const coincide = local.hash === nube.hash && local.filas === nube.filas;

      // El diff fila a fila solo se paga cuando el bloque ya se sabe divergente.
      const diff = coincide
        ? DIFF_VACIO
        : await diffBloque(node, cloud, tabla, sucursalId, dia);

      bloques.push({
        tabla, dia,
        filasLocal: local.filas, filasNube: nube.filas,
        hashLocal: local.hash, hashNube: nube.hash,
        coincide,
        soloEnLocal: [...diff.soloEnLocal],
        soloEnNube: [...diff.soloEnNube],
        versionDistinta: [...diff.versionDistinta],
      });
    }
  }

  const divergentes = bloques.filter((b) => !b.coincide);

  await registrarBloques(node, sucursalId, bloques);
  await levantarExcepciones(node, sucursalId, divergentes);

  let reencoladas = 0;
  if (opts.repararAutomaticamente !== false && divergentes.length > 0) {
    reencoladas = await reencolarDivergentes(node, divergentes);
  }

  return { sucursalId, bloques, divergentes, reencoladas };
}

/** Deja constancia de cada comparación, coincida o no. */
async function registrarBloques(
  node: Client,
  sucursalId: string,
  bloques: BloqueChecksum[],
): Promise<void> {
  for (const b of bloques) {
    await node.query(
      `INSERT INTO sync.checksum_bloque (sucursal_id, tabla, dia, filas, hash_local, hash_nube)
       VALUES ($1, $2, $3::date, $4, $5, $6)
       ON CONFLICT (sucursal_id, tabla, dia) DO UPDATE
          SET filas = EXCLUDED.filas,
              hash_local = EXCLUDED.hash_local,
              hash_nube = EXCLUDED.hash_nube,
              calculado_en = now()`,
      [sucursalId, b.tabla, b.dia, b.filasLocal, b.hashLocal, b.hashNube],
    );
  }
}

/**
 * Una divergencia SIEMPRE genera excepción, aunque se repare sola.
 *
 * Si la reparación fuera silenciosa, un motor que pierde una fila de cada mil se vería
 * perfectamente sano para siempre: el checksum la detecta, el re-push la repone, nadie se
 * entera y el bug de fondo nunca se corrige.
 *
 * La severidad distingue el caso reparable (falta en la nube: `alta`) del irreparable
 * sin intervención (falta en el nodo: `critica`).
 */
async function levantarExcepciones(
  node: Client,
  sucursalId: string,
  divergentes: BloqueChecksum[],
): Promise<void> {
  const MUESTRA = 50;
  for (const d of divergentes) {
    await node.query(
      `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, detalle)
       VALUES ('divergencia_checksum', $1, $2, $3, $4::jsonb)`,
      [
        d.soloEnNube.length > 0 ? 'critica' : 'alta',
        sucursalId,
        d.tabla,
        JSON.stringify({
          dia: d.dia,
          filas_local: d.filasLocal,
          filas_nube: d.filasNube,
          solo_en_local: d.soloEnLocal.slice(0, MUESTRA),
          solo_en_nube: d.soloEnNube.slice(0, MUESTRA),
          version_distinta: d.versionDistinta.slice(0, MUESTRA),
          faltan_en_nube: d.soloEnLocal.length + d.versionDistinta.length,
          faltan_en_local: d.soloEnNube.length,
        }),
      ],
    );
  }
}

/**
 * Re-push dirigido: devuelve al outbox EXACTAMENTE las filas divergentes.
 *
 * No el día entero, no la tabla: solo los ids que el nodo tiene y la nube necesita
 * (`soloEnLocal`) más los que existen en ambos lados con contenido distinto
 * (`versionDistinta`). La ingesta en la nube es idempotente y ordena por HLC, así que
 * reenviar una fila más nueva la actualiza y una ya igual se ignora.
 *
 * `soloEnNube` no se toca: son filas que el nodo perdió y no puede reponer desde aquí.
 * Por eso la excepción queda abierta para atención humana (restaurar respaldo o bajar
 * de la nube).
 */
async function reencolarDivergentes(
  node: Client,
  divergentes: BloqueChecksum[],
): Promise<number> {
  let total = 0;

  for (const d of divergentes) {
    const ids = [...d.soloEnLocal, ...d.versionDistinta];
    if (ids.length === 0) continue;

    const { rowCount } = await node.query(
      `INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt, estado)
       SELECT $1, t.id, to_jsonb(t), t.hlc_ts, t.hlc_cnt, 'pendiente'
         FROM ${d.tabla} t
        WHERE t.id = ANY($2::uuid[])`,
      [d.tabla, ids],
    );
    total += rowCount ?? 0;
  }

  return total;
}
