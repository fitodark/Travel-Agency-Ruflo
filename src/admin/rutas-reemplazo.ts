/**
 * Reemplazo de rutas por vigencia (D5) y reporte de boletos huérfanos (D12).
 * Fase 5c de "paradas autorizadas".
 *
 * docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D5, D12) / §5
 *
 * Cambiar las paradas de una ruta = baja lógica de la vieja + alta nueva
 * independiente (sin espejo). La ruta nueva se configura con antelación con
 * `vigenteDesde` futuro; a la vieja se le pone `vigente_hasta` = día previo, sin
 * traslape. `materializar_salidas` ya respeta `horario.vigente_desde/hasta`.
 *
 * Poner `vigente_hasta` NO se bloquea aunque haya boletos vendidos después: el
 * sistema devuelve el listado de huérfanos (D12) para que el admin los reubique a
 * mano (cancelar + reemitir en la ruta nueva).
 */

import type { Consultable } from '../db/consulta.js';
import { crearRuta, type ParadaNueva } from './horarios.js';

export interface BoletoHuerfano {
  boletoId: string;
  folio: string;
  pasajero: string;
  contacto: string;
  salidaId: string;
  fechaOperacion: string;
  horaSalida: string | null;
  asiento: number;
  origen: string;
  destino: string;
  importe: number;
  estatusPago: 'pagado' | 'pendiente';
}

export async function boletosHuerfanos(
  db: Consultable, rutaId: string, desde: string,
): Promise<BoletoHuerfano[]> {
  const { rows } = await db.query<BoletoHuerfano>(
    `SELECT boleto_id AS "boletoId", folio, pasajero, contacto,
            salida_id AS "salidaId", fecha_operacion::text AS "fechaOperacion",
            hora_salida AS "horaSalida", asiento, origen, destino, importe,
            estatus_pago AS "estatusPago"
       FROM core.boletos_huerfanos($1::uuid, $2::date)`,
    [rutaId, desde],
  );
  return rows.map((r) => ({ ...r, asiento: Number(r.asiento), importe: Number(r.importe) }));
}

export interface ArgsReemplazo {
  rutaViejaId: string;
  nombre: string;
  paradas: ParadaNueva[];
  /** Primer día operativo de la ruta nueva (YYYY-MM-DD). Debe ser futuro. */
  vigenteDesde: string;
}

export interface ResultadoReemplazo {
  id: string;
  rutaViejaVigenteHasta: string;
  huerfanos: BoletoHuerfano[];
}

/**
 * Da de baja por vigencia la ruta vieja y crea la nueva con `reemplaza_a`.
 * Devuelve el listado de boletos que quedan huérfanos (salidas de la ruta vieja
 * en/después de `vigenteDesde`) para reubicación manual.
 */
export async function reemplazarRuta(
  db: Consultable, a: ArgsReemplazo,
): Promise<ResultadoReemplazo> {
  const { rows: viejaRows } = await db.query<{ activo: boolean; vigente_hasta: string | null }>(
    `SELECT activo, vigente_hasta::text FROM core.ruta WHERE id = $1::uuid`, [a.rutaViejaId],
  );
  const vieja = viejaRows[0];
  if (!vieja) throw new Error('la ruta a reemplazar no existe');
  if (!vieja.activo) throw new Error('la ruta a reemplazar ya está dada de baja');

  const { rows: yaReemplazada } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM core.ruta WHERE reemplaza_a = $1::uuid AND activo`, [a.rutaViejaId],
  );
  if ((yaReemplazada[0]?.n ?? 0) > 0) throw new Error('esta ruta ya fue reemplazada por otra');

  const { rows: fechaRows } = await db.query<{ futura: boolean; hasta: string }>(
    `SELECT $1::date > current_date AS futura, ($1::date - 1)::text AS hasta`, [a.vigenteDesde],
  );
  if (!fechaRows[0]!.futura) {
    throw new Error('la vigencia de la ruta nueva debe ser una fecha futura (configúrala con antelación)');
  }
  const vigenteHasta = fechaRows[0]!.hasta;

  // Traslape: ningún horario de la ruta vieja puede arrancar en/después de la
  // fecha de reemplazo (eso sería operar las dos versiones a la vez).
  const { rows: traslape } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM core.horario
      WHERE ruta_id = $1::uuid AND activo AND vigente_desde IS NOT NULL
        AND vigente_desde >= $2::date`,
    [a.rutaViejaId, a.vigenteDesde],
  );
  if ((traslape[0]?.n ?? 0) > 0) {
    throw new Error('un horario de la ruta actual arranca en/después de la fecha de reemplazo: ajusta esas fechas primero');
  }

  // 1. Cerrar la vieja por vigencia (ruta + sus horarios activos).
  await db.query(
    `UPDATE core.ruta SET vigente_hasta = $2::date
      WHERE id = $1::uuid`,
    [a.rutaViejaId, vigenteHasta],
  );
  await db.query(
    `UPDATE core.horario
        SET vigente_hasta = LEAST(COALESCE(vigente_hasta, 'infinity'::date), $2::date)
      WHERE ruta_id = $1::uuid AND activo`,
    [a.rutaViejaId, vigenteHasta],
  );

  // 2. Alta de la ruta nueva + cadena de reemplazo.
  const { id } = await crearRuta(db, { nombre: a.nombre, paradas: a.paradas });
  await db.query(`UPDATE core.ruta SET reemplaza_a = $2::uuid WHERE id = $1::uuid`, [id, a.rutaViejaId]);

  // 3. Huérfanos: boletos vivos de la ruta vieja para viajar desde la fecha nueva.
  const huerfanos = await boletosHuerfanos(db, a.rutaViejaId, a.vigenteDesde);
  return { id, rutaViejaVigenteHasta: vigenteHasta, huerfanos };
}
