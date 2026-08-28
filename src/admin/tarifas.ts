/**
 * Tarifas por tramo desde la consola (F2b, slice 4).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §3.4
 *
 * `core.tarifa` es versionado por tramo con `effective_from` / `effective_until`.
 * REGLA (§3.4): un cambio de tarifa NUNCA es inmediato — no se cambia el precio a
 * media venta. Va por la ventana nocturna o programado a una fecha.
 *
 * Un precio nuevo para un tramo cierra el anterior en la misma fecha: no hay
 * traslape ni hueco.
 */

import type { Consultable } from '../db/consulta.js';
import { escribirConfig, proximaVentana, ZONA_DEFECTO } from './escribir-config.js';

export interface DatosTarifa {
  rutaId: string;
  paradaOrigenOrden: number;
  paradaDestinoOrden: number;
  importe: number;
}

interface OpcionesTarifa {
  /** `ventana` (default) o `programado`. `inmediato` se rechaza. */
  modo?: 'ventana' | 'programado';
  fechaProgramada?: Date;
  zonaHoraria?: string;
  ahora?: () => Date;
}

async function cuandoEntra(db: Consultable, opts: OpcionesTarifa): Promise<Date> {
  if (opts.modo === 'programado') {
    if (!opts.fechaProgramada) throw new Error('el modo "programado" exige fechaProgramada');
    return opts.fechaProgramada;
  }
  return proximaVentana(db, opts.zonaHoraria ?? ZONA_DEFECTO, opts.ahora?.() ?? new Date());
}

export async function listarTarifas(
  db: Consultable,
  rutaId?: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `SELECT t.id, t.ruta_id, r.nombre AS ruta_nombre, t.parada_origen_orden,
            t.parada_destino_orden, t.importe, t.activo, t.effective_from, t.effective_until
       FROM core.tarifa t
       JOIN core.ruta r ON r.id = t.ruta_id
      WHERE ($1::uuid IS NULL OR t.ruta_id = $1)
      ORDER BY r.nombre, t.parada_origen_orden, t.parada_destino_orden, t.effective_from DESC`,
    [rutaId ?? null],
  );
  return rows;
}

/**
 * Fija un precio nuevo para un tramo. Cierra el precio anterior de ese tramo en
 * la misma fecha de entrada.
 */
export async function crearTarifa(
  db: Consultable,
  datos: DatosTarifa,
  opts: OpcionesTarifa = {},
): Promise<{ id: string; effectiveFrom: string; cerroAnterior: string | null }> {
  if ((opts as { modo?: string }).modo === 'inmediato') {
    throw new Error('una tarifa no se cambia de forma inmediata (§3.4): usá "ventana" o "programado".');
  }
  if (datos.paradaOrigenOrden >= datos.paradaDestinoOrden) {
    throw new Error('parada de origen debe ser anterior a la de destino');
  }
  if (datos.importe < 0) throw new Error('el importe no puede ser negativo');

  const cuando = await cuandoEntra(db, opts);

  const { rows: previa } = await db.query<{ id: string }>(
    `SELECT id FROM core.tarifa
      WHERE ruta_id = $1 AND parada_origen_orden = $2 AND parada_destino_orden = $3
        AND activo AND effective_until IS NULL
      ORDER BY effective_from DESC LIMIT 1`,
    [datos.rutaId, datos.paradaOrigenOrden, datos.paradaDestinoOrden],
  );

  let cerroAnterior: string | null = null;
  if (previa[0]) {
    await escribirConfig(db, {
      tabla: 'core.tarifa',
      fila: { id: previa[0].id },
      vigenciaEn: 'effective_until',
      modo: 'programado',
      fechaProgramada: cuando,
      ...(opts.ahora ? { ahora: opts.ahora } : {}),
    });
    cerroAnterior = previa[0].id;
  }

  const r = await escribirConfig(db, {
    tabla: 'core.tarifa',
    fila: {
      ruta_id: datos.rutaId,
      parada_origen_orden: datos.paradaOrigenOrden,
      parada_destino_orden: datos.paradaDestinoOrden,
      importe: datos.importe,
    },
    modo: 'programado',
    fechaProgramada: cuando,
    ...(opts.ahora ? { ahora: opts.ahora } : {}),
  });

  return { id: r.id, effectiveFrom: r.vigenciaDesde.toISOString(), cerroAnterior };
}

/** Retira el precio de un tramo (baja lógica con `effective_until`). */
export async function darDeBajaTarifa(
  db: Consultable,
  id: string,
  opts: OpcionesTarifa = {},
): Promise<{ id: string; effectiveUntil: string }> {
  const cuando = await cuandoEntra(db, opts);
  const r = await escribirConfig(db, {
    tabla: 'core.tarifa',
    fila: { id, activo: false },
    vigenciaEn: 'effective_until',
    modo: 'programado',
    fechaProgramada: cuando,
    ...(opts.ahora ? { ahora: opts.ahora } : {}),
  });
  return { id: r.id, effectiveUntil: r.vigenciaDesde.toISOString() };
}
