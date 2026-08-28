/**
 * Viajes efectuados: listado de salidas del día y manifiestos de abordaje (F7).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
 *
 * La lógica vive en `core.salidas_del_dia` / `core.datos_manifiesto` /
 * `core.generar_manifiestos`. Este módulo genera los DATOS y encola los dos
 * `print_job`; imprimirlos es F5.
 */

import type { Consultable } from '../db/consulta.js';

export interface SalidaDelDia {
  salidaId: string;
  horarioId: string;
  estado: string;
  horaSalida: Date;
  origen: string;
  destino: string;
  conductor: string | null;
  boletos: number;
}

export async function salidasDelDia(
  db: Consultable,
  args: { fecha: string; sucursalId?: string },
): Promise<SalidaDelDia[]> {
  const { rows } = await db.query<{
    salida_id: string; horario_id: string; estado: string; hora_salida: Date;
    origen: string; destino: string; conductor: string | null; boletos: number;
  }>(
    `SELECT salida_id, horario_id, estado, hora_salida, origen, destino, conductor, boletos
       FROM core.salidas_del_dia($1::date, $2::uuid)`,
    [args.fecha, args.sucursalId ?? null],
  );
  return rows.map((r) => ({
    salidaId: r.salida_id,
    horarioId: r.horario_id,
    estado: r.estado,
    horaSalida: r.hora_salida,
    origen: r.origen,
    destino: r.destino,
    conductor: r.conductor,
    boletos: Number(r.boletos),
  }));
}

export type CopiaManifiesto = 'conductor' | 'terminal';

/** Los datos congelados de un manifiesto, para previsualizarlo. */
export async function datosManifiesto(
  db: Consultable,
  salidaId: string,
  copia: CopiaManifiesto = 'terminal',
  ahora?: Date,
): Promise<Record<string, unknown>> {
  const { rows } = await db.query<{ datos_manifiesto: Record<string, unknown> }>(
    `SELECT core.datos_manifiesto($1::uuid, $2::text, $3::timestamptz) AS datos_manifiesto`,
    [salidaId, copia, ahora ?? new Date()],
  );
  return rows[0]!.datos_manifiesto;
}

export interface ManifiestoEncolado {
  printJobId: string;
  pasajeros: number;
}

export interface ResultadoManifiestos {
  conductor: ManifiestoEncolado;
  terminal: ManifiestoEncolado;
}

/** Encola los dos manifiestos (conductor y terminal) de una salida. */
export async function generarManifiestos(
  db: Consultable,
  args: { salidaId: string; usuarioId: string; ahora?: Date },
): Promise<ResultadoManifiestos> {
  const { rows } = await db.query<{
    copia: CopiaManifiesto; print_job_id: string; pasajeros: number;
  }>(
    `SELECT copia, print_job_id, pasajeros
       FROM core.generar_manifiestos($1::uuid, $2::uuid, $3::timestamptz)`,
    [args.salidaId, args.usuarioId, args.ahora ?? new Date()],
  );
  const porCopia = new Map(rows.map((r) => [r.copia, r]));
  const armar = (c: CopiaManifiesto): ManifiestoEncolado => {
    const r = porCopia.get(c);
    if (!r) throw new Error(`generar_manifiestos no devolvió la copia ${c}`);
    return { printJobId: r.print_job_id, pasajeros: Number(r.pasajeros) };
  };
  return { conductor: armar('conductor'), terminal: armar('terminal') };
}
