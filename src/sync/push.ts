/**
 * Push: outbox de la sucursal -> nube.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.1
 *
 * El nodo NUNCA marca una fila como confirmada antes del ACK. Si el ACK se pierde en
 * una red intermitente —el caso normal aquí, no el excepcional— la fila se reenvía y la
 * idempotencia de `sync.ingest_batch` absorbe el duplicado.
 *
 * At-least-once + idempotente = efectivamente-una-vez.
 */

import type { Client } from 'pg';

export interface OutboxRow {
  seq: string;
  tabla: string;
  fila_id: string;
  payload: unknown;
}

export interface BatchAck {
  lote_id: string;
  idempotente: boolean;
  aceptadas: number;
  ignoradas: number;
  conflictos: number;
  rechazadas: number;
  filas: { seq: number; fila_id: string; estado: string; motivo: string | null }[];
}

export interface PushResult {
  lotes: number;
  enviadas: number;
  aceptadas: number;
  ignoradas: number;
  conflictos: number;
  rechazadas: number;
  acks: BatchAck[];
}

export interface PushOptions {
  /** Filas por lote. Blueprint: 500 en drenaje tras un corte largo. */
  batchSize?: number;
  /** Tope de lotes por corrida, para no monopolizar la máquina de la caja. */
  maxBatches?: number;
  versionNodo?: string;
}

const VACIO: PushResult = {
  lotes: 0, enviadas: 0, aceptadas: 0, ignoradas: 0, conflictos: 0, rechazadas: 0, acks: [],
};

/** Cuántas filas esperan subir. Alimenta el indicador de la caja y `sync.salud`. */
export async function outboxPendiente(node: Client): Promise<number> {
  const { rows } = await node.query<{ n: string }>(
    `SELECT count(*) AS n FROM sync.outbox WHERE estado <> 'confirmado'`,
  );
  return Number(rows[0]!.n);
}

export async function push(node: Client, cloud: Client, opts: PushOptions = {}): Promise<PushResult> {
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatches ?? 20;

  const { rows: nodoRows } = await node.query<{ sucursal_id: string | null }>(
    'SELECT sucursal_id FROM sync.nodo WHERE singleton',
  );
  const sucursalId = nodoRows[0]?.sucursal_id;
  if (!sucursalId) throw new Error('El nodo no tiene sucursal_id configurado en sync.nodo');

  const result: PushResult = { ...VACIO, acks: [] };

  for (let i = 0; i < maxBatches; i++) {
    // Orden por `seq`: preserva la causalidad intra-sucursal. El corte de caja sube
    // antes que sus movimientos; la venta antes que sus boletos. Sin esto, la nube
    // rechazaría hijos por clave foránea faltante de forma intermitente.
    // `seq` sin `::text`: el driver ya devuelve int8 como string, y un `seq::text` en
    // el SELECT crearía una columna de salida llamada `seq` que `ORDER BY seq` tomaría
    // por delante de la columna real — ordenando lexicográficamente ("10" < "2") y
    // partiendo un lote entre la venta y su boleto. La causalidad por `seq` es el
    // contrato de §3.1; tiene que ser numérica.
    const { rows } = await node.query<OutboxRow>(
      `SELECT seq, tabla, fila_id, payload
         FROM sync.outbox
        WHERE estado <> 'confirmado'
        ORDER BY seq
        LIMIT $1`,
      [batchSize],
    );
    if (rows.length === 0) break;

    const { rows: loteRows } = await node.query<{ id: string }>('SELECT core.uuid_v7() AS id');
    const loteId = loteRows[0]!.id;

    // Se marca `enviado` ANTES de mandar. Si el proceso muere a media llamada, la fila
    // queda como enviada-sin-confirmar y el siguiente ciclo la reintenta: el estado
    // refleja "salió de aquí", no "llegó allá".
    const seqs = rows.map((r) => r.seq);
    await node.query(
      `UPDATE sync.outbox
          SET estado = 'enviado', lote_id = $1, intentos = intentos + 1
        WHERE seq = ANY($2::bigint[])`,
      [loteId, seqs],
    );

    const lote = {
      lote_id: loteId,
      sucursal_id: sucursalId,
      version_nodo: opts.versionNodo ?? null,
      filas: rows.map((r) => ({
        seq: Number(r.seq),
        tabla: r.tabla,
        fila_id: r.fila_id,
        payload: r.payload,
      })),
    };

    let ack: BatchAck;
    try {
      const { rows: ackRows } = await cloud.query<{ ack: BatchAck }>(
        'SELECT sync.ingest_batch($1::jsonb) AS ack',
        [JSON.stringify(lote)],
      );
      ack = ackRows[0]!.ack;
    } catch (err) {
      // El lote no llegó o la nube lo rechazó entero: se devuelve a pendiente para
      // que el siguiente ciclo lo reintente. Nada se da por confirmado.
      await node.query(
        `UPDATE sync.outbox
            SET estado = 'pendiente', ultimo_error = $2
          WHERE seq = ANY($1::bigint[])`,
        [seqs, err instanceof Error ? err.message.slice(0, 500) : String(err)],
      );
      throw err;
    }

    await aplicarAck(node, ack);

    result.lotes++;
    result.enviadas += rows.length;
    result.aceptadas += ack.aceptadas;
    result.ignoradas += ack.ignoradas;
    result.conflictos += ack.conflictos;
    result.rechazadas += ack.rechazadas;
    result.acks.push(ack);

    if (rows.length < batchSize) break;
  }

  return result;
}

/**
 * Aplica el ACK fila por fila.
 *
 * `ignorada_hlc` cuenta como confirmada: la nube ya tiene una versión más nueva, así que
 * no hay nada que reenviar. Tratarla como pendiente dejaría el outbox creciendo para
 * siempre con filas que jamás van a "avanzar".
 */
async function aplicarAck(node: Client, ack: BatchAck): Promise<void> {
  const confirmadas: number[] = [];
  const rechazadas: { seq: number; motivo: string | null }[] = [];

  for (const f of ack.filas) {
    if (f.estado === 'aceptada' || f.estado === 'ignorada_hlc') confirmadas.push(f.seq);
    else rechazadas.push({ seq: f.seq, motivo: f.motivo });
  }

  if (confirmadas.length > 0) {
    await node.query(
      `UPDATE sync.outbox SET estado = 'confirmado' WHERE seq = ANY($1::bigint[])`,
      [confirmadas],
    );
  }

  for (const r of rechazadas) {
    await node.query(
      `UPDATE sync.outbox SET estado = 'rechazado', ultimo_error = $2 WHERE seq = $1`,
      [r.seq, r.motivo],
    );
  }
}
