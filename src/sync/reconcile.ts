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
 * difieren, algo se perdió, y se sabe exactamente qué bloque revisar.
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

      // Un bloque vacío en los dos lados no aporta nada y multiplicaría el ruido:
      // 11 tablas x 7 días son 77 comparaciones, casi todas vacías en una sucursal nueva.
      if (local.filas === 0) {
        const nubeVacia = await checksumDe(cloud, tabla, sucursalId, dia);
        if (nubeVacia.filas === 0) continue;

        // Local vacío y nube con filas: la sucursal PERDIÓ datos que ya había subido.
        // Es el caso más grave y el que un checksum ingenuo se saltaría por optimizar.
        bloques.push({
          tabla, dia,
          filasLocal: 0, filasNube: nubeVacia.filas,
          hashLocal: local.hash, hashNube: nubeVacia.hash,
          coincide: false,
        });
        continue;
      }

      const nube = await checksumDe(cloud, tabla, sucursalId, dia);
      bloques.push({
        tabla, dia,
        filasLocal: local.filas, filasNube: nube.filas,
        hashLocal: local.hash, hashNube: nube.hash,
        coincide: local.hash === nube.hash && local.filas === nube.filas,
      });
    }
  }

  const divergentes = bloques.filter((b) => !b.coincide);

  await registrarBloques(node, sucursalId, bloques);
  await levantarExcepciones(node, sucursalId, divergentes);

  let reencoladas = 0;
  if (opts.repararAutomaticamente !== false && divergentes.length > 0) {
    reencoladas = await reencolarDivergentes(node, sucursalId, divergentes);
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
 */
async function levantarExcepciones(
  node: Client,
  sucursalId: string,
  divergentes: BloqueChecksum[],
): Promise<void> {
  for (const d of divergentes) {
    await node.query(
      `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, detalle)
       VALUES ('divergencia_checksum', $1, $2, $3, $4::jsonb)`,
      [
        d.filasLocal !== d.filasNube ? 'critica' : 'alta',
        sucursalId,
        d.tabla,
        JSON.stringify({
          dia: d.dia,
          filas_local: d.filasLocal,
          filas_nube: d.filasNube,
          faltan_en_nube: Math.max(d.filasLocal - d.filasNube, 0),
          sobran_en_nube: Math.max(d.filasNube - d.filasLocal, 0),
        }),
      ],
    );
  }
}

/**
 * Re-push dirigido: devuelve al outbox las filas del bloque divergente.
 *
 * No se reenvía el outbox entero ni se reconstruye la tabla: solo las filas del bloque
 * exacto que discrepa. La ingesta en la nube es idempotente, así que reenviar filas que
 * ya llegaron es inofensivo — se ignoran por HLC.
 *
 * Solo se reponen filas que el nodo TIENE. Si la divergencia es que la nube tiene filas
 * que el nodo perdió, esto no las recupera; eso se resuelve restaurando el respaldo local
 * o bajando de la nube, y por eso la excepción queda abierta para atención humana.
 */
async function reencolarDivergentes(
  node: Client,
  sucursalId: string,
  divergentes: BloqueChecksum[],
): Promise<number> {
  let total = 0;

  for (const d of divergentes) {
    if (d.filasLocal === 0) continue;

    const { rowCount } = await node.query(
      `INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt, estado)
       SELECT $1, t.id, to_jsonb(t), t.hlc_ts, t.hlc_cnt, 'pendiente'
         FROM ${d.tabla} t
        WHERE t.sync_sucursal_id = $2
          AND t.creado_en >= $3::date
          AND t.creado_en <  $3::date + 1`,
      [d.tabla, sucursalId, d.dia],
    );
    total += rowCount ?? 0;
  }

  return total;
}
