/**
 * Pull: nube -> sucursal.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.2
 *
 * El cursor avanza por `seq` de `sync.cambio_log`, NUNCA por `modificado_en`. Una fila
 * escrita dentro de una transacción larga se hace visible después de otras con timestamp
 * mayor; un cursor por tiempo la saltaría y nadie se enteraría. La pérdida silenciosa es
 * el peor modo de falla de un motor de sincronización, y el más difícil de detectar:
 * todo "funciona" hasta el cierre de mes.
 */

import type { Client } from 'pg';

export interface PullResult {
  aplicadas: number;
  ignoradas: number;
  rechazadas: number;
  porTabla: Record<string, number>;
  cursorFinal: number;
  /**
   * Dónde se detuvo el cursor por una fila que no pudo aplicarse.
   *
   * Presente = el pull está atascado y no avanzará hasta que esa fila entre. Es una
   * condición que el tablero de salud debe mostrar: una terminal bloqueada deja de
   * recibir configuración aunque el resto del sistema se vea sano.
   */
  bloqueadoEn?: { seq: number; tabla: string; motivo: string | null };
}

export interface PullOptions {
  /** Filas por ciclo. */
  batchSize?: number;
  maxBatches?: number;
}

/**
 * Trae los cambios de configuración pendientes y los aplica localmente.
 *
 * Clase A (configuración): la nube gana siempre y el nodo nunca escribe estas tablas, así
 * que no hay conflicto posible — hay un solo escritor por definición.
 */
export async function pull(node: Client, cloud: Client, opts: PullOptions = {}): Promise<PullResult> {
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatches ?? 20;

  const result: PullResult = { aplicadas: 0, ignoradas: 0, rechazadas: 0, porTabla: {}, cursorFinal: 0 };

  // Un solo cursor global sobre `seq`. El esquema lo permite por tabla, pero avanzar
  // uno global mantiene el orden entre tablas, que es lo que hace que una `salida`
  // llegue después de su `horario` y no rebote por clave foránea.
  const { rows: cur } = await node.query<{ seq: string }>(
    `SELECT coalesce(max(ultimo_seq), 0)::text AS seq FROM sync.cursor`,
  );
  let cursor = Number(cur[0]!.seq);

  for (let i = 0; i < maxBatches; i++) {
    // Solo se leen filas cuya transacción escritora ya no está en vuelo.
    //
    // El peligro que esto evita: `seq` se asigna al INSERTAR, no al confirmar. Una
    // transacción lenta reserva el seq 100 y confirma después que otra que reservó el
    // 101. Si el cursor pasara al 101, el 100 quedaría por debajo y nadie volvería a
    // pedirlo jamás.
    //
    // La versión anterior usaba `pg_snapshot_xmin(pg_current_snapshot())`, que es un
    // horizonte de TODO EL SERVIDOR. Con varias bases en la misma instancia —el caso
    // real: la nube y las bases de prueba conviven— una transacción abierta en una base
    // ajena congelaba ese horizonte y el pull dejaba de avanzar indefinidamente, sin
    // error y sin señal. El horizonte se acota ahora a `current_database()`.
    // `seq` sin `::text`: con el cast, la columna de salida se llamaría `seq` y
    // `ORDER BY seq` ordenaría por ese texto ("10" < "2") en vez de por la columna.
    // Aquí eso desordenaría la configuración y haría que `cursor = Number(row.seq)`
    // avanzara al último del lote lexicográfico, no al máximo real.
    const { rows } = await cloud.query<{ seq: string; tabla: string; payload: unknown }>(
      `SELECT seq, tabla, payload
         FROM sync.cambio_log
        WHERE seq > $1
          AND age(xmin) > coalesce(
                (SELECT max(age(backend_xid))
                   FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND backend_xid IS NOT NULL
                    AND pid <> pg_backend_pid()),
                -1)
        ORDER BY seq
        LIMIT $2`,
      [cursor, batchSize],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const { estado, motivo } = await aplicarFila(node, row.tabla, row.payload);

      if (estado === 'aplicada') {
        result.aplicadas++;
        result.porTabla[row.tabla] = (result.porTabla[row.tabla] ?? 0) + 1;
      } else if (estado === 'ignorada') {
        result.ignoradas++;
      } else {
        // PÉRDIDA SILENCIOSA — el modo de falla que este motor no puede permitirse.
        //
        // Antes el cursor avanzaba también sobre las filas rechazadas, así que una
        // `salida` que rebotó por clave foránea (su `horario` aún no había llegado)
        // quedaba descartada PARA SIEMPRE: el siguiente ciclo arrancaba después de
        // ella y nadie la volvía a pedir. La terminal se quedaba sin ese viaje sin un
        // solo error visible, y el síntoma aparecía días después como un horario que
        // "no existe" en una sola sucursal.
        //
        // Ahora el cursor se DETIENE en la primera fila rechazada. El bloqueo es
        // deliberado: casi siempre es un problema de orden que el siguiente ciclo
        // resuelve solo, y prefiero un pull atascado y visible a uno que avanza
        // perdiendo filas.
        result.rechazadas++;
        result.bloqueadoEn = { seq: Number(row.seq), tabla: row.tabla, motivo };

        await registrarBloqueo(node, row.tabla, row.seq, motivo);
        await persistirCursor(node, cursor);
        result.cursorFinal = cursor;
        return result;
      }

      cursor = Number(row.seq);
    }

    // El cursor se persiste DESPUÉS de aplicar el lote. Si el proceso muere a la mitad,
    // el siguiente ciclo reaplica algunas filas — que es inofensivo porque el upsert es
    // idempotente— en vez de saltárselas, que no lo sería.
    await persistirCursor(node, cursor);

    if (rows.length < batchSize) break;
  }

  result.cursorFinal = cursor;
  return result;
}

async function persistirCursor(node: Client, seq: number): Promise<void> {
  await node.query(
    `INSERT INTO sync.cursor (tabla, ultimo_seq, ultimo_pull)
     VALUES ('*', $1, now())
     ON CONFLICT (tabla) DO UPDATE SET ultimo_seq = EXCLUDED.ultimo_seq, ultimo_pull = now()`,
    [seq],
  );
}

/**
 * Deja constancia de que el pull quedó atascado.
 *
 * Se deduplica por `(tabla, seq)`: sin eso, un ciclo cada 30 segundos contra una fila que
 * no se puede aplicar generaría 2 880 excepciones al día y ahogaría la cola justo cuando
 * hay que mirarla.
 */
async function registrarBloqueo(
  node: Client,
  tabla: string,
  seq: string,
  motivo: string | null,
): Promise<void> {
  const { rows } = await node.query<{ n: string }>(
    `SELECT count(*) AS n FROM sync.excepcion
      WHERE tipo = 'rechazo_ingesta' AND estado = 'abierta'
        AND entidad = $1 AND detalle->>'seq' = $2`,
    [tabla, seq],
  );
  if (Number(rows[0]!.n) > 0) return;

  await node.query(
    `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, detalle)
     VALUES ('rechazo_ingesta', 'alta', sync.sucursal_local(), $1, $2::jsonb)`,
    [tabla, JSON.stringify({ seq, motivo, efecto: 'el pull no avanza hasta resolverlo' })],
  );
}

/**
 * Aplica una fila de configuración en el nodo.
 *
 * Reutiliza `sync.ingest_fila`, la MISMA función que usa la nube para la subida. Tener un
 * solo camino de escritura evita que bajada y subida diverjan en su manejo de HLC, que es
 * la clase de diferencia sutil que produce datos distintos en cada extremo.
 */
async function aplicarFila(
  node: Client,
  tabla: string,
  payload: unknown,
): Promise<{ estado: 'aplicada' | 'ignorada' | 'rechazada'; motivo: string | null }> {
  const { rows } = await node.query<{ estado: string; motivo: string | null }>(
    `SELECT estado, motivo FROM sync.ingest_fila($1, ($2::jsonb->>'id')::uuid, $2::jsonb)`,
    [tabla, JSON.stringify(payload)],
  );
  const estado = rows[0]!.estado;
  const motivo = rows[0]?.motivo ?? null;
  if (estado === 'aceptada') return { estado: 'aplicada', motivo };
  if (estado === 'ignorada_hlc') return { estado: 'ignorada', motivo };
  return { estado: 'rechazada', motivo };
}
