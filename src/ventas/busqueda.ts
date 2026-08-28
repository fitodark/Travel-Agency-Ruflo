/**
 * Pasos 1-2 del flujo de venta: búsqueda de salidas con disponibilidad por tramo.
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §2, §3.4
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F4)
 *
 * La lógica vive en `core.buscar_salidas` / `core.asientos_ofrecibles`. Aquí solo
 * se invoca y se normaliza el resultado. La disponibilidad se calcula por tramo y
 * respeta la regla de oro del modo offline: sin conexión, una sucursal solo
 * ofrece los asientos de su propio cupo vigente.
 */

import type { Consultable } from '../db/consulta.js';

export interface OpcionesBusqueda {
  /** Día de viaje, `YYYY-MM-DD`. */
  fecha: string;
  sucursalOrigenId: string;
  sucursalDestinoId: string;
  /** Nº de personas a viajar: define `seleccionable`. */
  nPersonas: number;
  /** La terminal que hace la búsqueda; determina qué cupo aplica offline. */
  sucursalVendedoraId: string;
  /** `false` cuando la terminal está sin internet. Por defecto `true`. */
  conConexion?: boolean;
  /** Inyectable para pruebas. Por defecto, el reloj de la base. */
  ahora?: Date;
}

export interface SalidaDisponible {
  salidaId: string;
  horarioId: string;
  fechaOperacion: string;
  /** Hora de paso programada por el origen, con zona horaria resuelta. */
  horaSalidaOrigen: Date;
  origenOrden: number;
  destinoOrden: number;
  estado: string;
  cierreVentaEn: Date;
  /** Tarifa vigente del tramo; `null` si la ruta no la tiene capturada. */
  importe: number | null;
  /** Identidades de asiento que esta terminal puede ofrecer en el paso 3. */
  asientosOfrecibles: number[];
  disponibles: number;
  /** Salida programada + venta abierta + caben las N personas. */
  seleccionable: boolean;
}

interface FilaBusqueda {
  salida_id: string;
  horario_id: string;
  fecha_operacion: string;
  hora_salida_origen: Date;
  origen_orden: number;
  destino_orden: number;
  estado: string;
  cierre_venta_en: Date;
  importe: string | null;
  asientos_ofrecibles: number[] | null;
  disponibles: number;
  seleccionable: boolean;
}

export async function buscarSalidas(
  db: Consultable,
  opts: OpcionesBusqueda,
): Promise<SalidaDisponible[]> {
  const { rows } = await db.query<FilaBusqueda>(
    `SELECT salida_id, horario_id, fecha_operacion::text AS fecha_operacion,
            hora_salida_origen, origen_orden, destino_orden, estado,
            cierre_venta_en, importe, asientos_ofrecibles, disponibles, seleccionable
       FROM core.buscar_salidas($1::date, $2::uuid, $3::uuid, $4::int, $5::uuid,
                                $6::boolean, $7::timestamptz)`,
    [
      opts.fecha,
      opts.sucursalOrigenId,
      opts.sucursalDestinoId,
      opts.nPersonas,
      opts.sucursalVendedoraId,
      opts.conConexion ?? true,
      opts.ahora ?? new Date(),
    ],
  );

  return rows.map((f) => ({
    salidaId: f.salida_id,
    horarioId: f.horario_id,
    fechaOperacion: f.fecha_operacion,
    horaSalidaOrigen: f.hora_salida_origen,
    origenOrden: Number(f.origen_orden),
    destinoOrden: Number(f.destino_orden),
    estado: f.estado,
    cierreVentaEn: f.cierre_venta_en,
    importe: f.importe === null ? null : Number(f.importe),
    asientosOfrecibles: (f.asientos_ofrecibles ?? []).map(Number),
    disponibles: Number(f.disponibles),
    seleccionable: f.seleccionable,
  }));
}
