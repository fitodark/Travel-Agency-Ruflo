/**
 * Autoría del catálogo de puntos de ruta (Fase 5c).
 *
 * docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D1, D2) / §4-§5
 *
 * `core.punto_ruta` (0048) es el catálogo de lugares por los que pasa una ruta:
 *   - `tipo = 'terminal'` — una `core.sucursal` real (PC, caja, folio, impresora).
 *     Su punto se deriva de la sucursal con id determinista
 *     (`core.asegurar_punto_terminal`), así que "crear" una terminal aquí es
 *     idempotente y no duplica.
 *   - `tipo = 'parada'` — una parada autorizada (típicamente de solo descenso):
 *     NO es sucursal, no tiene `sucursal_id`, lleva su propia `zona_horaria`
 *     (copia point-in-time de la sucursal más cercana o la que decida el admin).
 *
 * Clase A (`registrar_entidad` + `publicar_a_nodos`, 0048): cada INSERT/UPDATE se
 * publica por `trg_cambio_log` y el nodo lo recibe en el pull. Escritura sencilla,
 * sin `Client` del pool.
 *
 * La zona horaria de una terminal se copia de la sucursal al crear el punto
 * (F0-D2 / D2): NO se re-propaga en vivo si el admin cambia la tz de la sucursal
 * —la tz operativa vive en el punto y se edita aquí—.
 */

import type { Consultable } from '../db/consulta.js';

export interface PuntoRuta {
  id: string;
  nombre: string;
  tipo: 'terminal' | 'parada';
  referencia: string | null;
  municipio: string | null;
  zonaHoraria: string;
  sucursalId: string | null;
  sucursal: string | null;
  activo: boolean;
  /** Referenciado por al menos una `ruta_parada` activa: no se puede dar de baja. */
  enUso: boolean;
}

export async function listarPuntos(db: Consultable): Promise<PuntoRuta[]> {
  const { rows } = await db.query<PuntoRuta>(
    `SELECT p.id, p.nombre, p.tipo, p.referencia, p.municipio,
            p.zona_horaria AS "zonaHoraria",
            p.sucursal_id AS "sucursalId", s.nombre AS sucursal, p.activo,
            EXISTS (SELECT 1 FROM core.ruta_parada rp
                     WHERE rp.punto_id = p.id AND rp.activo) AS "enUso"
       FROM core.punto_ruta p
       LEFT JOIN core.sucursal s ON s.id = p.sucursal_id
      ORDER BY p.activo DESC, p.tipo, p.nombre`,
  );
  return rows;
}

export interface NuevoPunto {
  tipo: 'terminal' | 'parada';
  /** Solo `parada`: nombre y zona horaria son obligatorios. */
  nombre?: string;
  zonaHoraria?: string;
  referencia?: string;
  municipio?: string;
  /** Solo `terminal`: la sucursal cuya identidad de punto se asegura. */
  sucursalId?: string;
}

export async function crearPunto(db: Consultable, p: NuevoPunto): Promise<{ id: string }> {
  if (p.tipo === 'terminal') {
    if (!p.sucursalId) throw new Error('un punto terminal necesita la sucursal');
    const { rows } = await db.query<{ id: string }>(
      `SELECT core.asegurar_punto_terminal($1::uuid) AS id`, [p.sucursalId],
    );
    return { id: rows[0]!.id };
  }

  const nombre = p.nombre?.trim();
  const tz = p.zonaHoraria?.trim();
  if (!nombre) throw new Error('la parada necesita un nombre');
  if (!tz) throw new Error('la parada necesita una zona horaria (p. ej. America/Mexico_City)');

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO core.punto_ruta (nombre, tipo, referencia, municipio, zona_horaria)
     VALUES ($1, 'parada', $2, $3, $4)
     RETURNING id`,
    [nombre, p.referencia?.trim() || null, p.municipio?.trim() || null, tz],
  );
  return { id: rows[0]!.id };
}

export async function editarPunto(
  db: Consultable,
  id: string,
  args: Partial<{ nombre: string; referencia: string | null; municipio: string | null; zonaHoraria: string }>,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const push = (col: string, v: unknown): void => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (args.nombre !== undefined) {
    if (!args.nombre.trim()) throw new Error('el nombre no puede quedar vacío');
    push('nombre', args.nombre.trim());
  }
  if (args.referencia !== undefined) push('referencia', args.referencia?.trim() || null);
  if (args.municipio !== undefined) push('municipio', args.municipio?.trim() || null);
  if (args.zonaHoraria !== undefined) {
    if (!args.zonaHoraria.trim()) throw new Error('la zona horaria no puede quedar vacía');
    push('zona_horaria', args.zonaHoraria.trim());
  }
  if (sets.length === 0) return;
  await db.query(`UPDATE core.punto_ruta SET ${sets.join(', ')} WHERE id = $1::uuid`, vals);
}

/** Baja lógica. Rechaza si el punto está en una ruta activa. */
export async function darDeBajaPunto(db: Consultable, id: string): Promise<void> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM core.ruta_parada WHERE punto_id = $1::uuid AND activo`, [id],
  );
  if ((rows[0]?.n ?? 0) > 0) {
    throw new Error('el punto está en una ruta activa: quita la parada de la ruta antes de darlo de baja');
  }
  await db.query(
    `UPDATE core.punto_ruta SET activo = false WHERE id = $1::uuid AND activo`, [id],
  );
}
