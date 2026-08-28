/**
 * Arbitraje determinista de sobreventa de asiento.
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §6
 *
 * Cuando dos sucursales venden el mismo asiento en tramos que se solapan, la nube
 * detecta el choque en la ingesta y marca la segunda ocupación como `conflicto`.
 * Este módulo decide QUIÉN se queda con el asiento — y lo hace igual en los dos
 * lados: es una FUNCIÓN PURA sobre los datos de las ocupaciones, nunca una
 * consulta a la base ni el orden de llegada a la nube (eso premiaría a la
 * sucursal con mejor internet, justo la que el sistema promete no castigar).
 *
 * `arbitrar` da el mismo ganador con las mismas entradas, sin importar el orden
 * en que se le pasen. `resolverConflictoAsiento` es la capa que lee el estado
 * real, llama a `arbitrar`, y aplica el resultado marcando a los perdedores.
 */

import type { Consultable } from '../db/consulta.js';

export interface Ocupacion {
  /** Id de la fila `core.asiento_ocupacion`. */
  id: string;
  boletoId: string;
  sucursalId: string;
  salidaId: string;
  asientoNum: number;
  /** Rango de tramos, p. ej. `[0,3)`. */
  tramos: string;
  /** Reloj de quien emitió, no de quien recibe. */
  emitidoEn: Date;
  impreso: boolean;
  pagado: boolean;
  abonoParcial: boolean;
}

/**
 * Nivel del cuadro de 01b §6. **1 = más difícil de revertir = gana.**
 * 1 pagado e impreso · 2 pagado · 3 abono parcial · 4 reservación sin pago.
 */
export function prioridadDe(o: Ocupacion): 1 | 2 | 3 | 4 {
  if (o.pagado && o.impreso) return 1;
  if (o.pagado) return 2;
  if (o.abonoParcial) return 3;
  return 4;
}

/**
 * Orden total determinista entre ocupaciones. Devuelve `<0` si `a` gana a `b`,
 * `>0` si pierde. **Nunca devuelve 0 para dos ocupaciones distintas** — de ahí
 * que el último desempate sea el id de la fila.
 *
 * Prioridad → `emitidoEn` más antiguo → `sucursalId` → `boletoId` → `id`.
 * NUNCA mira el orden de llegada a la nube.
 */
export function compararOcupaciones(a: Ocupacion, b: Ocupacion): number {
  const pa = prioridadDe(a);
  const pb = prioridadDe(b);
  if (pa !== pb) return pa - pb;

  const ta = a.emitidoEn.getTime();
  const tb = b.emitidoEn.getTime();
  if (ta !== tb) return ta - tb;

  if (a.sucursalId !== b.sucursalId) return a.sucursalId < b.sucursalId ? -1 : 1;
  if (a.boletoId !== b.boletoId) return a.boletoId < b.boletoId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export interface Arbitraje {
  gana: Ocupacion;
  pierden: Ocupacion[];
}

/** Elige el dueño de un asiento entre las ocupaciones en conflicto. Puro. */
export function arbitrar(candidatas: readonly Ocupacion[]): Arbitraje {
  if (candidatas.length === 0) {
    throw new Error('arbitrar: no hay ocupaciones que arbitrar');
  }
  const ordenadas = [...candidatas].sort(compararOcupaciones);
  return { gana: ordenadas[0]!, pierden: ordenadas.slice(1) };
}

/** ¿Se solapan dos rangos `[lo,hi)` escritos como texto `int4range`? */
function tramosSolapan(x: string, y: string): boolean {
  const p = (s: string): [number, number] => {
    const m = /^[\[(](-?\d+),(-?\d+)[\])]$/.exec(s.replace(/\s/g, ''));
    if (!m) throw new Error(`tramos ilegibles: ${s}`);
    return [Number(m[1]), Number(m[2])];
  };
  const [ax, ay] = p(x);
  const [bx, by] = p(y);
  return ax < by && bx < ay;
}

export interface ResolucionConflicto {
  salidaId: string;
  asientoNum: number;
  /** Id de la ocupación ganadora. */
  ganador: string;
  /** Ids de las ocupaciones que quedaron en conflicto. */
  perdedores: string[];
  /** Boletos de esas ocupaciones (`conflicto_sobreventa`), para reasignar. */
  perdedoresBoletoId: string[];
  excepcionId: string | null;
}

interface FilaOcupacion {
  id: string;
  boleto_id: string;
  sucursal_id: string;
  salida_id: string;
  asiento_num: number;
  tramos: string;
  emitido_en: Date;
  estado: string;
  impreso: boolean;
  pagado: boolean;
  abono_parcial: boolean;
}

/**
 * Re-arbitra un asiento cuya venta chocó y aplica el resultado:
 * el ganador queda `firme`, los perdedores `conflicto` y sus boletos
 * `conflicto_sobreventa` (nunca se borran, 01b §6), y se abre —o reutiliza— una
 * excepción `sobreventa` de severidad crítica.
 *
 * Devuelve `null` si el asiento no tiene un conflicto real (menos de dos
 * ocupaciones que se solapen).
 */
export async function resolverConflictoAsiento(
  db: Consultable,
  salidaId: string,
  asientoNum: number,
  opts: { ahora?: Date } = {},
): Promise<ResolucionConflicto | null> {
  const ahora = opts.ahora ?? new Date();

  const { rows } = await db.query<FilaOcupacion>(
    `SELECT o.id, o.boleto_id, o.sucursal_id, o.salida_id, o.asiento_num,
            o.tramos::text AS tramos, o.emitido_en, o.estado,
            (b.impreso_en IS NOT NULL) AS impreso,
            COALESCE(vs.saldo_pendiente <= 0, false) AS pagado,
            COALESCE(vs.pagado > 0 AND vs.saldo_pendiente > 0, false) AS abono_parcial
       FROM core.asiento_ocupacion o
       JOIN core.boleto b ON b.id = o.boleto_id
       LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = b.venta_id
      WHERE o.salida_id = $1::uuid
        AND o.asiento_num = $2::smallint
        AND o.estado IN ('firme', 'conflicto')`,
    [salidaId, asientoNum],
  );

  if (rows.length < 2) return null;

  const ocupaciones: Ocupacion[] = rows.map((r) => ({
    id: r.id,
    boletoId: r.boleto_id,
    sucursalId: r.sucursal_id,
    salidaId: r.salida_id,
    asientoNum: Number(r.asiento_num),
    tramos: r.tramos,
    emitidoEn: r.emitido_en,
    impreso: r.impreso,
    pagado: r.pagado,
    abonoParcial: r.abono_parcial,
  }));

  // Solo entran al arbitraje las que se solapan entre sí. Si ninguna se solapa
  // con otra, no hay sobreventa: dos boletos del mismo asiento en tramos
  // disjuntos son legítimos.
  const enConflicto = ocupaciones.filter((o) =>
    ocupaciones.some((otra) => otra.id !== o.id && tramosSolapan(o.tramos, otra.tramos)),
  );
  if (enConflicto.length < 2) return null;

  const { gana, pierden } = arbitrar(enConflicto);
  const idsPerdedores = pierden.map((o) => o.id);
  const boletosPerdedores = pierden.map((o) => o.boletoId);

  // Primero los perdedores a conflicto, luego el ganador a firme: así la
  // constraint de exclusión nunca ve dos firmes solapados a la vez.
  await db.query(
    `UPDATE core.asiento_ocupacion SET estado = 'conflicto'
      WHERE id = ANY($1::uuid[]) AND estado <> 'conflicto'`,
    [idsPerdedores],
  );
  await db.query(
    `UPDATE core.boleto SET estado = 'conflicto_sobreventa'
      WHERE id = ANY($1::uuid[]) AND estado NOT IN ('cancelado', 'reasignado')`,
    [boletosPerdedores],
  );
  await db.query(
    `UPDATE core.asiento_ocupacion SET estado = 'firme'
      WHERE id = $1::uuid AND estado <> 'firme'`,
    [gana.id],
  );
  await db.query(
    `UPDATE core.boleto SET estado = 'emitido'
      WHERE id = $1::uuid AND estado = 'conflicto_sobreventa'`,
    [gana.boletoId],
  );

  // Excepción crítica, deduplicada por salida + asiento.
  const { rows: existente } = await db.query<{ id: string }>(
    `SELECT id FROM sync.excepcion
      WHERE tipo = 'sobreventa' AND estado = 'abierta'
        AND detalle->>'salida_id' = $1 AND detalle->>'asiento_num' = $2`,
    [salidaId, String(asientoNum)],
  );

  let excepcionId: string | null = existente[0]?.id ?? null;
  if (!excepcionId) {
    const { rows: nueva } = await db.query<{ id: string }>(
      `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, entidad_id, detalle)
       VALUES ('sobreventa', 'critica', $1::uuid, 'core.asiento_ocupacion', $2::uuid, $3::jsonb)
       RETURNING id`,
      [
        gana.sucursalId,
        gana.id,
        JSON.stringify({
          salida_id: salidaId,
          asiento_num: asientoNum,
          ganador: gana.id,
          perdedores: idsPerdedores,
          resuelto_en: ahora.toISOString(),
        }),
      ],
    );
    excepcionId = nueva[0]!.id;
  }

  return {
    salidaId, asientoNum,
    ganador: gana.id,
    perdedores: idsPerdedores,
    perdedoresBoletoId: boletosPerdedores,
    excepcionId,
  };
}
