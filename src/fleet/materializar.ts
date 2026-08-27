/**
 * Materialización de salidas — el job nocturno.
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §6.1
 *
 * Corre EN LA NUBE. Convierte cada horario vigente en las salidas concretas del
 * horizonte de 90 días, con el mapa de asientos congelado (D-7), y esas salidas
 * bajan replicadas a las terminales. La lógica vive en la función
 * `core.materializar_salidas`; aquí solo se la invoca y se agrega el resultado.
 */

import type { Consultable } from '../db/consulta.js';

export interface ResultadoMaterializacion {
  /** Salidas nuevas creadas en esta pasada. */
  creadas: number;
  /** Días que ya estaban materializados y no se tocaron (idempotencia). */
  yaExistentes: number;
  /** Salidas creadas sin ninguna parada: el horario no tiene `horario_parada`. */
  sinParadas: number;
}

interface FilaResultado {
  creadas: string;
  ya_existentes: string;
  sin_paradas: string;
}

const mapear = (r: FilaResultado): ResultadoMaterializacion => ({
  creadas: Number(r.creadas),
  yaExistentes: Number(r.ya_existentes),
  sinParadas: Number(r.sin_paradas),
});

/** Materializa un horario concreto. */
export async function materializarHorario(
  db: Consultable,
  horarioId: string,
  opts: { dias?: number; desde?: string } = {},
): Promise<ResultadoMaterializacion> {
  const { rows } = await db.query<FilaResultado>(
    `SELECT creadas, ya_existentes, sin_paradas
       FROM core.materializar_salidas($1::uuid, $2::int, $3::date)`,
    [horarioId, opts.dias ?? null, opts.desde ?? null],
  );
  return mapear(rows[0]!);
}

export interface ResumenMaterializacion extends ResultadoMaterializacion {
  horarios: number;
  detalle: ({ horarioId: string; ruta: string } & ResultadoMaterializacion)[];
}

/**
 * Materializa TODOS los horarios vigentes con conductor asignado.
 *
 * Un horario sin conductor no se puede materializar (D-7: sin conductor no hay
 * tipo de unidad ni mapa) y se salta en silencio: es un estado de planeación
 * incompleta, no un error del job.
 */
export async function materializarVigentes(
  db: Consultable,
  opts: { dias?: number; desde?: string } = {},
): Promise<ResumenMaterializacion> {
  const { rows: horarios } = await db.query<{ id: string; ruta: string }>(
    `SELECT h.id, r.nombre AS ruta
       FROM core.v_horario_vigente h
       JOIN core.ruta r ON r.id = h.ruta_id
      WHERE h.conductor_id IS NOT NULL
      ORDER BY r.nombre, h.hora_salida`,
  );

  const resumen: ResumenMaterializacion = {
    creadas: 0, yaExistentes: 0, sinParadas: 0, horarios: horarios.length, detalle: [],
  };

  for (const h of horarios) {
    const r = await materializarHorario(db, h.id, opts);
    resumen.creadas += r.creadas;
    resumen.yaExistentes += r.yaExistentes;
    resumen.sinParadas += r.sinParadas;
    resumen.detalle.push({ horarioId: h.id, ruta: h.ruta, ...r });
  }

  return resumen;
}
