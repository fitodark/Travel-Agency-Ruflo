/**
 * Bootstrap: carga inicial completa de una terminal nueva.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §5
 *
 * POR QUÉ NO BASTA EL PULL INCREMENTAL:
 * `sync.cambio_log` solo registra escrituras posteriores a que la base fuera marcada
 * como nube. Todo lo que ya existía —el catálogo de unidades sembrado en la instalación,
 * las sucursales dadas de alta antes— nunca entra al log y por tanto NUNCA llegaría a un
 * nodo nuevo por pull. Una terminal recién instalada se quedaría esperando para siempre
 * una fila que no va a venir, y el síntoma sería una venta rechazada por clave foránea
 * en el mostrador.
 *
 * El bootstrap copia el estado completo en orden topológico y deja el cursor en el `seq`
 * actual de la nube, para que el pull incremental continúe exactamente desde ahí.
 */

import type { Client } from 'pg';

/**
 * Orden topológico de las tablas de configuración (clase A).
 *
 * Blueprint §5. El orden importa: `salida` referencia `horario`, que referencia `ruta`.
 * Copiarlas alfabéticamente produciría rechazos por clave foránea intermitentes según
 * qué datos existan, que es la clase de fallo que aparece en la cuarta sucursal y no en
 * las tres primeras.
 */
export const ORDEN_TOPOLOGICO: readonly string[] = [
  // Nivel 0 — sin dependencias
  'core.agencia',
  'core.tipo_unidad',
  'core.parametro',
  'core.rol_permiso',
  // Nivel 1
  'core.sucursal',
  // Nivel 2
  'core.usuario',
  'core.usuario_sucursal',
  // Sin FK a core.usuario (auth_local se desacopla a propósito), pero es su
  // credencial: va justo después. Añadida por 0034 (F2b slice 1).
  'auth_local.credencial',
  'core.unidad',
  'core.config_impresora',
  'core.config_ticket',
  // Nivel 3
  'core.conductor',
  // Nivel 4
  'core.ruta',
  'core.ruta_parada',
  'core.horario',
  'core.horario_parada',
  'core.tarifa',
  // Nivel 5 — a partir de aquí la sucursal ya puede vender
  'core.salida',
  'core.salida_parada',
  'core.cupo_offline',
];

/** Última tabla del nivel 5: hasta aquí hay que converger antes de poder vender. */
export const NIVEL_MINIMO_PARA_VENDER = 'core.cupo_offline';

export interface BootstrapResult {
  filasPorTabla: Record<string, number>;
  total: number;
  cursorInicial: number;
  puedeVender: boolean;
}

export interface BootstrapOptions {
  /** Filas por página al traer de la nube. */
  pageSize?: number;
  /** Limita a las sucursales relevantes cuando la tabla lo permite. */
  sucursalId?: string;
}

export async function bootstrap(
  node: Client,
  cloud: Client,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const pageSize = opts.pageSize ?? 1000;
  const filasPorTabla: Record<string, number> = {};
  let total = 0;

  // Se toma el `seq` ANTES de copiar. Si durante la copia entran cambios nuevos, el pull
  // incremental los volverá a aplicar: reaplicar es inofensivo (el upsert es idempotente),
  // saltárselos no lo sería. Ante la duda, siempre repetir en vez de perder.
  const { rows: seqRows } = await cloud.query<{ seq: string }>(
    `SELECT coalesce(max(seq), 0)::text AS seq FROM sync.cambio_log`,
  );
  const cursorInicial = Number(seqRows[0]!.seq);

  await node.query('BEGIN');
  try {
    // Difiere las FK dentro de la transacción: tolera desorden parcial dentro de un
    // nivel sin tener que resolver el grafo de dependencias fila por fila.
    await node.query('SET CONSTRAINTS ALL DEFERRED');

    for (const tabla of ORDEN_TOPOLOGICO) {
      let copiadas = 0;
      let offset = 0;

      for (;;) {
        const { rows } = await cloud.query<{ fila: Record<string, unknown> }>(
          `SELECT to_jsonb(t) AS fila FROM ${tabla} t ORDER BY t.id LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );
        if (rows.length === 0) break;

        for (const { fila } of rows) {
          const { rows: res } = await node.query<{ estado: string; motivo: string | null }>(
            `SELECT estado, motivo FROM sync.ingest_fila($1, ($2::jsonb->>'id')::uuid, $2::jsonb)`,
            [tabla, JSON.stringify(fila)],
          );
          const estado = res[0]!.estado;
          if (estado === 'rechazada') {
            throw new Error(`Bootstrap falló en ${tabla}: ${res[0]!.motivo}`);
          }
          copiadas++;
        }

        offset += rows.length;
        if (rows.length < pageSize) break;
      }

      if (copiadas > 0) filasPorTabla[tabla] = copiadas;
      total += copiadas;
    }

    await node.query(
      `INSERT INTO sync.cursor (tabla, ultimo_seq, ultimo_pull)
       VALUES ('*', $1, now())
       ON CONFLICT (tabla) DO UPDATE SET ultimo_seq = EXCLUDED.ultimo_seq, ultimo_pull = now()`,
      [cursorInicial],
    );

    await node.query('COMMIT');
  } catch (err) {
    await node.query('ROLLBACK');
    throw err;
  }

  // Sin salidas materializadas ni cupos, la terminal no tiene qué vender. Es una
  // condición operativa que la caja debe poder mostrar, no un detalle interno.
  const { rows: salidas } = await node.query<{ n: string }>(
    `SELECT count(*) AS n FROM core.salida`,
  );

  return {
    filasPorTabla,
    total,
    cursorInicial,
    puedeVender: Number(salidas[0]!.n) > 0,
  };
}
