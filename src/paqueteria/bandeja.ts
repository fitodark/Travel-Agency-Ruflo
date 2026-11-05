/**
 * Bandeja «Por entregar» de la terminal destino con su historial completo
 * (retro del equipo, 4 nov): lo que espera a que lo recojan y lo ya entregado,
 * paginado y con filtros, para que un envío entregado no desaparezca de la
 * pantalla y solo se encuentre por folio.
 *
 * Solo lectura: la entrega sale del `core.evento_envio` 'entregado' (0086).
 */

import type { Consultable } from '../db/consulta.js';
import { mapear, SELECT_ENVIO, type Envio, type FilaEnvio } from './envio.js';

export type VistaEntregas = 'por_entregar' | 'entregados' | 'todos';

export interface FiltrosEntregas {
  vista?: VistaEntregas;
  /** Fecha de entrega (día en la zona horaria de la sucursal), inclusive. */
  entregaDesde?: string;
  entregaHasta?: string;
  /** Búsqueda parcial, sin distinguir mayúsculas. */
  remitente?: string;
  destinatario?: string;
  folio?: string;
}

export interface EnvioEntregas extends Envio {
  entregadoEn: Date | null;
  entregadoPor: string | null;
}

const ESTADOS: Record<VistaEntregas, string[]> = {
  por_entregar: ['en_sucursal'],
  entregados: ['entregado'],
  todos: ['en_sucursal', 'entregado'],
};

/** `%texto%` para ILIKE, con los comodines del usuario escapados. */
const contiene = (t: string | undefined): string | null => {
  const limpio = t?.trim();
  return limpio ? `%${limpio.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
};

/**
 * Envíos de mi sucursal destino ya recibidos: primero los que esperan a que
 * los recojan, luego los entregados del más reciente al más viejo.
 */
export async function historialEntregas(
  db: Consultable,
  sucursalId: string,
  f: FiltrosEntregas,
  pag: { limite: number; offset: number },
): Promise<{ filas: EnvioEntregas[]; total: number }> {
  const { rows } = await db.query<FilaEnvio & {
    entregado_en: Date | null; entregado_por: string | null; total: string;
  }>(
    `SELECT b.*, ent.entregado_en, ent.entregado_por, count(*) OVER () AS total
       FROM (${SELECT_ENVIO}
              WHERE e.sucursal_destino_id = $1::uuid AND e.activo
                AND es.estado = ANY($2::text[])) b
       JOIN core.sucursal su ON su.id = $1::uuid
       LEFT JOIN LATERAL (
         SELECT ev.ocurrido_en AS entregado_en, ue.nombre AS entregado_por
           FROM core.evento_envio ev
           JOIN core.usuario ue ON ue.id = ev.usuario_id
          WHERE ev.envio_id = b.envio_id AND ev.activo AND ev.tipo = 'entregado'
          ORDER BY ev.ocurrido_en DESC LIMIT 1
       ) ent ON true
      WHERE ($3::date IS NULL OR (ent.entregado_en AT TIME ZONE su.zona_horaria)::date >= $3::date)
        AND ($4::date IS NULL OR (ent.entregado_en AT TIME ZONE su.zona_horaria)::date <= $4::date)
        AND ($5::text IS NULL OR b.remitente_nombre    ILIKE $5)
        AND ($6::text IS NULL OR b.destinatario_nombre ILIKE $6)
        AND ($7::text IS NULL OR b.folio               ILIKE $7)
      ORDER BY (b.estado = 'entregado'), ent.entregado_en DESC NULLS LAST, b.registrado_en
      LIMIT $8 OFFSET $9`,
    [
      sucursalId, ESTADOS[f.vista ?? 'todos'],
      f.entregaDesde ?? null, f.entregaHasta ?? null,
      contiene(f.remitente), contiene(f.destinatario), contiene(f.folio),
      pag.limite, pag.offset,
    ],
  );
  return {
    filas: rows.map((r) => ({ ...mapear(r), entregadoEn: r.entregado_en, entregadoPor: r.entregado_por })),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
}
