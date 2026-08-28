/**
 * Reasignación automática del boleto que pierde un arbitraje de sobreventa.
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §7
 *
 * El folio identifica la venta, no el asiento: por eso un boleto puede cambiar
 * de asiento conservando folio, importe y QR base, lo que convierte una
 * sobreventa ya impresa en un problema reversible.
 *
 * Preferencia de asiento nuevo, en orden (01b §7):
 *   (a) otro asiento libre del MISMO bloque
 *   (b) uno adyacente a los acompañantes de la misma venta
 *   (c) cualquiera libre
 *
 * Si la unidad va llena: `null` y una excepción de severidad alta para el
 * gerente (mover a otra salida, cancelar con devolución, o escalar).
 */

import type { Consultable } from '../db/consulta.js';

export interface MapaAsiento {
  num: number;
  fila: number;
  col: number;
  vendible?: boolean;
}

export interface MapaBloque {
  clave: string;
  asientos: number[];
}

export interface MapaUnidad {
  asientos: MapaAsiento[];
  bloques: MapaBloque[];
}

export type MotivoReasignacion = 'mismo_bloque' | 'adyacente_a_acompanante' | 'cualquiera';

export interface EleccionAsiento {
  asiento: number;
  motivo: MotivoReasignacion;
}

/**
 * Elige el asiento nuevo para un boleto que perdió su lugar. Puro: sin base.
 * `libres` NO debe incluir `asientoAnterior`. Devuelve `null` si no hay ninguno.
 */
export function elegirAsientoReasignado(
  mapa: MapaUnidad,
  asientoAnterior: number,
  libres: readonly number[],
  acompanantes: readonly number[],
): EleccionAsiento | null {
  const libresSet = new Set(libres);
  libresSet.delete(asientoAnterior);
  if (libresSet.size === 0) return null;

  // (a) mismo bloque
  const bloque = mapa.bloques.find((b) => b.asientos.includes(asientoAnterior));
  if (bloque) {
    const enBloque = bloque.asientos.filter((n) => n !== asientoAnterior && libresSet.has(n));
    if (enBloque.length > 0) {
      return { asiento: Math.min(...enBloque), motivo: 'mismo_bloque' };
    }
  }

  // (b) adyacente a un acompañante: misma fila, columnas contiguas
  const porNum = new Map(mapa.asientos.map((a) => [a.num, a]));
  const adyacentes: number[] = [];
  for (const c of acompanantes) {
    const ca = porNum.get(c);
    if (!ca) continue;
    for (const n of libresSet) {
      const na = porNum.get(n);
      if (na && na.fila === ca.fila && Math.abs(na.col - ca.col) === 1) {
        adyacentes.push(n);
      }
    }
  }
  if (adyacentes.length > 0) {
    return { asiento: Math.min(...adyacentes), motivo: 'adyacente_a_acompanante' };
  }

  // (c) cualquiera libre
  return { asiento: Math.min(...libresSet), motivo: 'cualquiera' };
}

export interface Reasignacion {
  boletoId: string;
  asientoAnterior: number;
  asientoNuevo: number;
  motivo: MotivoReasignacion;
  /** NO cambia: es lo que hace reversible una sobreventa ya impresa. */
  folio: string;
}

interface FilaBoleto {
  folio: string;
  salida_id: string;
  asiento_num: number;
  tramos: string;
  venta_id: string;
  estado: string;
  usuario_id: string;
  sucursal_venta_id: string;
  mapa_snapshot: MapaUnidad;
}

/**
 * Propone y aplica la reasignación de un boleto en `conflicto_sobreventa`.
 * Devuelve la reasignación, o `null` si no cabía (y entonces deja abierta una
 * excepción `sobreventa` de severidad alta).
 */
export async function proponerReasignacion(
  db: Consultable,
  boletoId: string,
  opts: { ahora?: Date } = {},
): Promise<Reasignacion | null> {
  const ahora = opts.ahora ?? new Date();

  const { rows } = await db.query<FilaBoleto>(
    `SELECT b.folio, b.salida_id, b.asiento_num, b.tramos::text AS tramos,
            b.venta_id, b.estado, v.usuario_id, v.sucursal_venta_id,
            s.mapa_snapshot
       FROM core.boleto b
       JOIN core.venta v ON v.id = b.venta_id
       JOIN core.salida s ON s.id = b.salida_id
      WHERE b.id = $1::uuid`,
    [boletoId],
  );
  if (rows.length === 0) return null;
  const b = rows[0]!;
  if (b.estado !== 'conflicto_sobreventa') return null;

  const m = /^\[(-?\d+),(-?\d+)\)$/.exec(b.tramos.replace(/\s/g, ''));
  if (!m) throw new Error(`tramos ilegibles: ${b.tramos}`);
  const desde = Number(m[1]);
  const hasta = Number(m[2]);
  const asientoAnterior = Number(b.asiento_num);

  const { rows: libresRows } = await db.query<{ asientos_libres: number[] }>(
    `SELECT core.asientos_libres($1::uuid, $2::int, $3::int, $4::timestamptz) AS asientos_libres`,
    [b.salida_id, desde, hasta, ahora],
  );
  const libres = (libresRows[0]!.asientos_libres ?? []).map(Number);

  const { rows: compaRows } = await db.query<{ asiento_num: number }>(
    `SELECT asiento_num FROM core.boleto
      WHERE venta_id = $1::uuid AND id <> $2::uuid AND estado NOT IN ('cancelado')`,
    [b.venta_id, boletoId],
  );
  const acompanantes = compaRows.map((r) => Number(r.asiento_num));

  const eleccion = elegirAsientoReasignado(b.mapa_snapshot, asientoAnterior, libres, acompanantes);

  if (!eleccion) {
    await abrirExcepcionUnidadLlena(db, b, asientoAnterior, boletoId);
    return null;
  }

  // Libera la ocupación en conflicto y toma la nueva en firme.
  await db.query(
    `UPDATE core.asiento_ocupacion SET estado = 'liberado'
      WHERE boleto_id = $1::uuid AND asiento_num = $2::smallint AND estado = 'conflicto'`,
    [boletoId, asientoAnterior],
  );

  try {
    await db.query(
      `INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, boleto_id,
                                           estado, sucursal_id, emitido_en, prioridad)
       VALUES (core.uuid_v7(), $1::uuid, $2::smallint, int4range($3, $4), $5::uuid,
               'firme', $6::uuid, $7::timestamptz,
               (SELECT COALESCE(
                  (SELECT 2 FROM core.v_venta_saldo WHERE venta_id = $8::uuid AND saldo_pendiente <= 0),
                  1)))`,
      [b.salida_id, eleccion.asiento, desde, hasta, boletoId, b.sucursal_venta_id, ahora, b.venta_id],
    );
  } catch (err) {
    // El asiento elegido se ocupó entretanto: revierte y trata como unidad llena.
    await db.query(
      `UPDATE core.asiento_ocupacion SET estado = 'conflicto'
        WHERE boleto_id = $1::uuid AND asiento_num = $2::smallint AND estado = 'liberado'`,
      [boletoId, asientoAnterior],
    );
    await abrirExcepcionUnidadLlena(db, b, asientoAnterior, boletoId);
    return null;
  }

  await db.query(
    `UPDATE core.boleto SET asiento_num = $2::smallint, estado = 'reasignado'
      WHERE id = $1::uuid`,
    [boletoId, eleccion.asiento],
  );

  await db.query(
    `INSERT INTO core.nota_auditoria (entidad, entidad_id, tipo, detalle, usuario_id, sucursal_id)
     VALUES ('core.boleto', $1::uuid, 'reasignacion_por_conflicto', $2::jsonb, $3::uuid, $4::uuid)`,
    [
      boletoId,
      JSON.stringify({
        asiento_anterior: asientoAnterior,
        asiento_nuevo: eleccion.asiento,
        motivo: eleccion.motivo,
        folio: b.folio,
      }),
      b.usuario_id,
      b.sucursal_venta_id,
    ],
  );

  await db.query(
    `INSERT INTO core.print_job (id, sucursal_id, template_key, datos, estado,
                                 es_reimpresion, motivo_reimpresion, boleto_id)
     VALUES (core.uuid_v7(), $1::uuid, 'boleto', core.snapshot_boleto($2::uuid), 'pendiente',
             true, 'REIMPRESIÓN — CAMBIO DE ASIENTO', $2::uuid)`,
    [b.sucursal_venta_id, boletoId],
  );

  return {
    boletoId,
    asientoAnterior,
    asientoNuevo: eleccion.asiento,
    motivo: eleccion.motivo,
    folio: b.folio,
  };
}

async function abrirExcepcionUnidadLlena(
  db: Consultable,
  b: FilaBoleto,
  asientoAnterior: number,
  boletoId: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM sync.excepcion
      WHERE tipo = 'sobreventa' AND estado = 'abierta'
        AND detalle->>'boleto_id' = $1 AND detalle->>'motivo' = 'unidad_llena'`,
    [boletoId],
  );
  if (rows.length > 0) return;
  await db.query(
    `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, entidad_id, detalle)
     VALUES ('sobreventa', 'alta', $1::uuid, 'core.boleto', $2::uuid, $3::jsonb)`,
    [
      b.sucursal_venta_id,
      boletoId,
      JSON.stringify({
        motivo: 'unidad_llena',
        boleto_id: boletoId,
        folio: b.folio,
        asiento: asientoAnterior,
        salida_id: b.salida_id,
      }),
    ],
  );
}

export interface ResultadoReasignacion {
  reasignados: Reasignacion[];
  sinCupo: string[];
}

/**
 * El encadenado §6 → §7: arbitra un asiento y reasigna a cada perdedor.
 * `perdedoresBoletoId` viene de resolver el conflicto (los boletos que quedaron
 * en `conflicto_sobreventa`).
 */
export async function reasignarPerdedores(
  db: Consultable,
  perdedoresBoletoId: readonly string[],
  opts: { ahora?: Date } = {},
): Promise<ResultadoReasignacion> {
  const reasignados: Reasignacion[] = [];
  const sinCupo: string[] = [];
  for (const boletoId of perdedoresBoletoId) {
    const r = await proponerReasignacion(db, boletoId, opts);
    if (r) reasignados.push(r);
    else sinCupo.push(boletoId);
  }
  return { reasignados, sinCupo };
}
