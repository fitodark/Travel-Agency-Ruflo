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

/**
 * `core.salida.mapa_snapshot` (D-7): el layout de la unidad congelado al
 * materializar. Declarativo desde 0003 — ningún layout se hardcodea en la
 * app. Las claves del jsonb son las que autoriza `knowledge/esquema.JPG` /
 * `src/db/seed/0001_tipo_unidad_sprinter18.sql`, tal cual llegan de Postgres
 * (snake_case: es JSON de un ancho, no columnas SQL).
 */
export interface MapaAsientosSalida {
  filas: number;
  columnas: number;
  /** Columna (0-based) después de la cual va el pasillo. */
  pasillo_despues_columna: number;
  accesos?: Array<{ fila: number; lado: 'izquierdo' | 'derecho'; etiqueta: string }>;
  asientos: Array<{
    num: number;
    fila: number;
    col: number;
    tipo?: string;
    vendible?: boolean;
  }>;
}

export interface OpcionesBusqueda {
  /** Día de viaje, `YYYY-MM-DD`. */
  fecha: string;
  /**
   * Punto de origen y de destino. Desde Fase 1 (migración 0049) llevan
   * `core.punto_ruta.id`, NO `core.sucursal.id`. El origen debe permitir ascenso
   * en la ruta (`ruta_parada.permite_ascenso`); una parada de solo descenso nunca
   * origina. Los nombres se conservan por compatibilidad con los llamadores.
   */
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
  /**
   * Hora de paso programada en el destino del tramo. `null` si el destino es
   * una parada autorizada sin horario capturado (0052, D6) — no todas las
   * paradas no-terminal tienen hora de paso.
   */
  horaLlegadaDestino: Date | null;
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
  /** Nombre de la ruta — distingue dos salidas al mismo destino a la misma hora. */
  rutaNombre: string;
  origenNombre: string;
  destinoNombre: string;
  /** Paradas intermedias entre origen y destino, en orden. Vacío si es directo. */
  escalas: string[];
  /** Tarifa vigente por categoría de pasajero: `{ general, inapam?, menor? }` (D4). */
  tarifas: Partial<Record<'general' | 'inapam' | 'menor', number>>;
  /** Layout de la unidad (D-7), para el mapa visual del paso 3. */
  mapa: MapaAsientosSalida;
  /** `core.tipo_unidad.nombre` — p. ej. "Mercedes Benz Sprinter 18 plazas". */
  unidadNombre: string;
  /**
   * `core.unidad.numero_economico`: `null` si la salida aún no tiene una
   * unidad física asignada (`unidad_id` es dato operativo, no de plantilla).
   */
  unidadNumeroEconomico: string | null;
}

interface FilaBusqueda {
  salida_id: string;
  horario_id: string;
  fecha_operacion: string;
  hora_salida_origen: Date;
  hora_llegada_destino: Date | null;
  origen_orden: number;
  destino_orden: number;
  estado: string;
  cierre_venta_en: Date;
  importe: string | null;
  asientos_ofrecibles: number[] | null;
  disponibles: number;
  seleccionable: boolean;
  ruta_nombre: string;
  origen_nombre: string;
  destino_nombre: string;
  escalas: string[] | null;
  tarifas: Record<string, number | string> | null;
  mapa: MapaAsientosSalida;
  unidad_nombre: string;
  unidad_numero_economico: string | null;
}

export async function buscarSalidas(
  db: Consultable,
  opts: OpcionesBusqueda,
): Promise<SalidaDisponible[]> {
  const { rows } = await db.query<FilaBusqueda>(
    `SELECT salida_id, horario_id, fecha_operacion::text AS fecha_operacion,
            hora_salida_origen, hora_llegada_destino, origen_orden, destino_orden, estado,
            cierre_venta_en, importe, asientos_ofrecibles, disponibles, seleccionable,
            ruta_nombre, origen_nombre, destino_nombre, escalas, tarifas, mapa,
            unidad_nombre, unidad_numero_economico
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
    horaLlegadaDestino: f.hora_llegada_destino,
    origenOrden: Number(f.origen_orden),
    destinoOrden: Number(f.destino_orden),
    estado: f.estado,
    cierreVentaEn: f.cierre_venta_en,
    importe: f.importe === null ? null : Number(f.importe),
    asientosOfrecibles: (f.asientos_ofrecibles ?? []).map(Number),
    disponibles: Number(f.disponibles),
    seleccionable: f.seleccionable,
    rutaNombre: f.ruta_nombre,
    origenNombre: f.origen_nombre,
    destinoNombre: f.destino_nombre,
    escalas: f.escalas ?? [],
    tarifas: Object.fromEntries(
      Object.entries(f.tarifas ?? {}).map(([k, v]) => [k, Number(v)]),
    ),
    mapa: f.mapa,
    unidadNombre: f.unidad_nombre,
    unidadNumeroEconomico: f.unidad_numero_economico,
  }));
}
