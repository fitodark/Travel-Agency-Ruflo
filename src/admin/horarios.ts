/**
 * Autoría de rutas y horarios desde la consola (F2c / Fase 3).
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5 y §6
 *
 * Tres niveles (0004): `ruta` (plantilla geográfica), `horario` (plantilla
 * temporal), `salida` (instancia — la materializa el job nocturno de la nube).
 *
 * IMPORTANTE: cambiar una ruta o un horario NO re-materializa las salidas ya
 * creadas (D-7: el mapa y las paradas se congelan al materializar). El job
 * `core.materializar_salidas` toma los cambios para las salidas FUTURAS.
 *
 * MATERIALIZACIÓN AUTOMÁTICA: al crear un horario CON conductor —o al asignarle
 * uno después— esta capa materializa su horizonte AHÍ MISMO, contra la nube. El
 * administrador no corre nada aparte: guarda el horario (en la ventana que
 * acordó con las terminales) y al siguiente pull las sucursales ya ven las
 * salidas. El job nocturno `npm run materializar` sigue existiendo para el
 * barrido diario (empujar el día 91 del horizonte, tomar horarios que ganaron
 * conductor por otra vía). `core.materializar_salidas` es idempotente
 * (`ON CONFLICT (horario_id, fecha_operacion) DO NOTHING`), así que llamarlo de
 * más no duplica ni toca las salidas ya congeladas.
 *
 * Las cuatro tablas son clase A (`registrar_entidad` + `publicar_a_nodos`, 0004 y
 * 0008): cada `INSERT` publica por `trg_cambio_log` y el nodo lo recibe en el
 * pull. Las inserciones compuestas van en UNA sentencia con CTEs para que sean
 * atómicas sin pedir un `Client` del pool.
 */

import type { Consultable } from '../db/consulta.js';
import { materializarHorario } from '../fleet/materializar.js';

export interface ParadaRuta {
  id: string;
  orden: number;
  sucursalId: string;
  sucursal: string;
}

export interface RutaDetalle {
  id: string;
  nombre: string;
  activo: boolean;
  paradas: ParadaRuta[];
}

export async function listarRutasDetalle(db: Consultable): Promise<RutaDetalle[]> {
  const { rows } = await db.query<RutaDetalle>(
    `SELECT r.id, r.nombre, r.activo,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'id', rp.id, 'orden', rp.orden,
                       'sucursalId', rp.sucursal_id, 'sucursal', s.nombre) ORDER BY rp.orden)
                FROM core.ruta_parada rp
                JOIN core.sucursal s ON s.id = rp.sucursal_id
               WHERE rp.ruta_id = r.id AND rp.activo
            ), '[]'::jsonb) AS paradas
       FROM core.ruta r
      ORDER BY r.activo DESC, r.nombre`,
  );
  return rows;
}

/** Crea una ruta con sus paradas ordenadas (origen … intermedias … destino). */
export async function crearRuta(
  db: Consultable,
  args: { nombre: string; sucursalIds: string[] },
): Promise<{ id: string }> {
  const ids = args.sucursalIds;
  if (ids.length < 2) throw new Error('una ruta necesita al menos origen y destino');
  if (new Set(ids).size !== ids.length) throw new Error('una sucursal no puede aparecer dos veces en la ruta');

  const paradas = ids.map((sucursalId, orden) => ({ sucursal_id: sucursalId, orden }));
  const { rows } = await db.query<{ id: string }>(
    `WITH r AS (
       INSERT INTO core.ruta (nombre, sucursal_origen_id, sucursal_destino_id)
       VALUES ($1, $2::uuid, $3::uuid)
       RETURNING id
     ), p AS (
       INSERT INTO core.ruta_parada (ruta_id, sucursal_id, orden)
       SELECT r.id, x.sucursal_id, x.orden
         FROM r, jsonb_to_recordset($4::jsonb) AS x(sucursal_id uuid, orden int)
       RETURNING 1
     )
     SELECT id FROM r`,
    [args.nombre, ids[0], ids[ids.length - 1], JSON.stringify(paradas)],
  );
  return { id: rows[0]!.id };
}

export async function editarRuta(
  db: Consultable, id: string, args: { nombre: string },
): Promise<void> {
  await db.query(`UPDATE core.ruta SET nombre = $2 WHERE id = $1::uuid`, [id, args.nombre]);
}

export async function darDeBajaRuta(db: Consultable, id: string): Promise<void> {
  await db.query(`UPDATE core.ruta SET activo = false WHERE id = $1::uuid AND activo`, [id]);
}

export interface HorarioDetalle {
  id: string;
  rutaId: string;
  rutaNombre: string;
  horaSalida: string;
  diasSemana: number[];
  conductorId: string | null;
  conductor: string | null;
  unidadId: string | null;
  unidad: string | null;
  vigenteDesde: string | null;
  vigenteHasta: string | null;
  activo: boolean;
  pasos: { orden: number; horaPaso: string; sucursal: string }[];
}

export async function listarHorarios(db: Consultable, rutaId?: string): Promise<HorarioDetalle[]> {
  const { rows } = await db.query<HorarioDetalle>(
    `SELECT h.id, h.ruta_id AS "rutaId", r.nombre AS "rutaNombre",
            h.hora_salida::text AS "horaSalida", h.dias_semana AS "diasSemana",
            h.conductor_id AS "conductorId", c.nombre AS conductor,
            h.unidad_id AS "unidadId", u.numero_economico AS unidad,
            h.vigente_desde::text AS "vigenteDesde", h.vigente_hasta::text AS "vigenteHasta",
            h.activo,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'orden', hp.orden, 'horaPaso', hp.hora_paso::text, 'sucursal', s.nombre) ORDER BY hp.orden)
                FROM core.horario_parada hp
                JOIN core.ruta_parada rp ON rp.id = hp.ruta_parada_id
                JOIN core.sucursal s ON s.id = rp.sucursal_id
               WHERE hp.horario_id = h.id
            ), '[]'::jsonb) AS pasos
       FROM core.horario h
       JOIN core.ruta r ON r.id = h.ruta_id
       LEFT JOIN core.conductor c ON c.id = h.conductor_id
       LEFT JOIN core.unidad u ON u.id = h.unidad_id
      WHERE ($1::uuid IS NULL OR h.ruta_id = $1::uuid)
      ORDER BY h.activo DESC, r.nombre, h.hora_salida`,
    [rutaId ?? null],
  );
  return rows;
}

export interface NuevoHorario {
  rutaId: string;
  horaSalida: string;
  diasSemana: number[];
  conductorId?: string;
  unidadId?: string;
  vigenteDesde?: string;
  vigenteHasta?: string;
  /** Hora de paso por cada parada de la ruta. `rutaParadaId` de `listarRutasDetalle`. */
  pasos: { rutaParadaId: string; orden: number; horaPaso: string }[];
}

export interface ResultadoHorario {
  id: string;
  /** Salidas materializadas en el acto (0 si el horario aún no tiene conductor). */
  salidasCreadas: number;
  /** Presente si se intentó materializar y no se pudo (p. ej. el horario todavía
   *  no está vigente): el horario SÍ quedó guardado; el job nocturno lo tomará. */
  avisoMaterializacion?: string;
}

/**
 * Materializa el horizonte de un horario, best-effort. Si no tiene conductor no
 * hace nada; si `core.materializar_salidas` se queja (horario aún no vigente, sin
 * mapa), se devuelve el aviso pero NO se propaga: el horario ya está guardado y
 * el barrido nocturno lo retomará.
 */
async function materializarSiSePuede(
  db: Consultable, id: string, tieneConductor: boolean,
): Promise<{ salidasCreadas: number; avisoMaterializacion?: string }> {
  if (!tieneConductor) return { salidasCreadas: 0 };
  try {
    const r = await materializarHorario(db, id);
    return { salidasCreadas: r.creadas };
  } catch (err) {
    return {
      salidasCreadas: 0,
      avisoMaterializacion: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function crearHorario(db: Consultable, h: NuevoHorario): Promise<ResultadoHorario> {
  if (h.diasSemana.length === 0 || h.diasSemana.some((d) => d < 1 || d > 7)) {
    throw new Error('días de la semana inválidos (1 = lunes … 7 = domingo)');
  }
  if (h.pasos.length === 0) throw new Error('el horario necesita al menos la hora de salida de la parada de origen');

  const { rows } = await db.query<{ id: string }>(
    `WITH nuevo AS (
       INSERT INTO core.horario (ruta_id, hora_salida, dias_semana, conductor_id, unidad_id,
                                 vigente_desde, vigente_hasta)
       VALUES ($1::uuid, $2::time, $3::smallint[], $4::uuid, $5::uuid, $6::date, $7::date)
       RETURNING id
     ), pasos AS (
       INSERT INTO core.horario_parada (horario_id, ruta_parada_id, orden, hora_paso)
       SELECT nuevo.id, x.ruta_parada_id, x.orden, x.hora_paso
         FROM nuevo, jsonb_to_recordset($8::jsonb)
                AS x(ruta_parada_id uuid, orden int, hora_paso time)
       RETURNING 1
     )
     SELECT id FROM nuevo`,
    [
      h.rutaId, h.horaSalida, h.diasSemana,
      h.conductorId ?? null, h.unidadId ?? null,
      h.vigenteDesde ?? null, h.vigenteHasta ?? null,
      JSON.stringify(h.pasos.map((p) => ({ ruta_parada_id: p.rutaParadaId, orden: p.orden, hora_paso: p.horaPaso }))),
    ],
  );
  const id = rows[0]!.id;
  return { id, ...(await materializarSiSePuede(db, id, h.conductorId != null)) };
}

export async function editarHorario(
  db: Consultable,
  id: string,
  args: Partial<{
    horaSalida: string; diasSemana: number[]; conductorId: string | null;
    unidadId: string | null; vigenteDesde: string | null; vigenteHasta: string | null;
  }>,
): Promise<{ salidasCreadas: number; avisoMaterializacion?: string }> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const push = (col: string, cast: string, v: unknown): void => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  if (args.horaSalida !== undefined) push('hora_salida', '::time', args.horaSalida);
  if (args.diasSemana !== undefined) push('dias_semana', '::smallint[]', args.diasSemana);
  if (args.conductorId !== undefined) push('conductor_id', '::uuid', args.conductorId);
  if (args.unidadId !== undefined) push('unidad_id', '::uuid', args.unidadId);
  if (args.vigenteDesde !== undefined) push('vigente_desde', '::date', args.vigenteDesde);
  if (args.vigenteHasta !== undefined) push('vigente_hasta', '::date', args.vigenteHasta);
  if (sets.length === 0) return { salidasCreadas: 0 };
  await db.query(`UPDATE core.horario SET ${sets.join(', ')} WHERE id = $1::uuid`, vals);

  // Tras el cambio, ¿el horario tiene conductor? Un `vigente_hasta` extendido o un
  // conductor recién asignado dan salidas nuevas; las ya congeladas no se tocan.
  const { rows } = await db.query<{ conductor_id: string | null }>(
    `SELECT conductor_id FROM core.horario WHERE id = $1::uuid AND activo`, [id],
  );
  return materializarSiSePuede(db, id, rows[0]?.conductor_id != null);
}

/**
 * Da de baja el horario Y cancela sus salidas futuras SIN boletos vendidos: si
 * no se cancelan, `buscar_salidas` las seguiría ofreciendo (materializadas, aún
 * `programada`) y aparecen como duplicados del horario que las reemplaza. Las
 * salidas con boletos NO se tocan (D-7): esos viajes ya vendidos siguen en pie.
 */
export async function darDeBajaHorario(
  db: Consultable, id: string,
): Promise<{ salidasCanceladas: number }> {
  await db.query(`UPDATE core.horario SET activo = false WHERE id = $1::uuid AND activo`, [id]);
  const r = await db.query(
    `UPDATE core.salida SET estado = 'cancelada'
      WHERE horario_id = $1::uuid
        AND estado = 'programada'
        AND fecha_operacion >= current_date
        AND NOT EXISTS (
          SELECT 1 FROM core.boleto b
           WHERE b.salida_id = core.salida.id AND b.activo AND b.estado <> 'cancelado')`,
    [id],
  );
  return { salidasCanceladas: r.rowCount ?? 0 };
}

export async function listarConductores(db: Consultable): Promise<{ id: string; nombre: string }[]> {
  const { rows } = await db.query<{ id: string; nombre: string }>(
    `SELECT id, nombre FROM core.conductor WHERE activo ORDER BY nombre`,
  );
  return rows;
}

export async function listarUnidades(db: Consultable): Promise<{ id: string; nombre: string }[]> {
  const { rows } = await db.query<{ id: string; nombre: string }>(
    `SELECT id, numero_economico AS nombre FROM core.unidad WHERE activo ORDER BY numero_economico`,
  );
  return rows;
}
