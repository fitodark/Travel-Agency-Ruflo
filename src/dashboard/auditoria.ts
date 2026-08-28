/**
 * Auditoría, salud de sync y gastos para el dashboard en nube (F8).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
 *
 * Lee del esquema `reporte`. Todo de solo lectura.
 */

import type { Consultable } from '../db/consulta.js';

export interface RegistroInactivo {
  tabla: string;
  id: string;
  desactivadoEn: Date | null;
  desactivadoPor: string | null;
  desactivadoMotivo: string | null;
  resumen: string;
}

export async function auditoriaInactivos(
  db: Consultable, opts: { tabla?: string } = {},
): Promise<RegistroInactivo[]> {
  const { rows } = await db.query<{
    tabla: string; id: string; desactivado_en: Date | null;
    desactivado_por: string | null; desactivado_motivo: string | null; resumen: string;
  }>(
    `SELECT tabla, id, desactivado_en, desactivado_por, desactivado_motivo, resumen
       FROM reporte.v_inactivos
      WHERE ($1::text IS NULL OR tabla = $1::text)
      ORDER BY desactivado_en DESC NULLS LAST`,
    [opts.tabla ?? null],
  );
  return rows.map((r) => ({
    tabla: r.tabla,
    id: r.id,
    desactivadoEn: r.desactivado_en,
    desactivadoPor: r.desactivado_por,
    desactivadoMotivo: r.desactivado_motivo,
    resumen: r.resumen,
  }));
}

export interface SaludSucursal {
  sucursalId: string;
  sucursal: string;
  ultimaSyncExitosa: Date | null;
  atrasoHoras: number | null;
  outboxPendiente: number | null;
  derivaRelojSeg: number | null;
  excepcionesCriticas: number | null;
  versionEsquema: string | null;
  versionBinario: string | null;
  ultimoRespaldoEn: Date | null;
  reportadoEn: Date | null;
  /** `null` = nunca reportó; `false` = arrancando; `true` = pasó el umbral. */
  degradado: boolean | null;
}

export async function saludSucursales(db: Consultable): Promise<SaludSucursal[]> {
  const { rows } = await db.query<{
    sucursal_id: string; sucursal: string; ultima_sync_exitosa: Date | null;
    atraso_horas: string | null; outbox_pendiente: number | null;
    deriva_reloj_seg: number | null; excepciones_criticas: number | null;
    version_esquema: string | null; version_binario: string | null;
    ultimo_respaldo_en: Date | null; reportado_en: Date | null; degradado: boolean | null;
  }>(
    `SELECT sucursal_id, sucursal, ultima_sync_exitosa, atraso_horas, outbox_pendiente,
            deriva_reloj_seg, excepciones_criticas, version_esquema, version_binario,
            ultimo_respaldo_en, reportado_en, degradado
       FROM reporte.v_salud_sucursal ORDER BY sucursal`,
  );
  return rows.map((r) => ({
    sucursalId: r.sucursal_id,
    sucursal: r.sucursal,
    ultimaSyncExitosa: r.ultima_sync_exitosa,
    atrasoHoras: r.atraso_horas === null ? null : Number(r.atraso_horas),
    outboxPendiente: r.outbox_pendiente,
    derivaRelojSeg: r.deriva_reloj_seg,
    excepcionesCriticas: r.excepciones_criticas,
    versionEsquema: r.version_esquema,
    versionBinario: r.version_binario,
    ultimoRespaldoEn: r.ultimo_respaldo_en,
    reportadoEn: r.reportado_en,
    degradado: r.degradado,
  }));
}

export interface ExcepcionAbierta {
  excepcionId: string;
  sucursal: string | null;
  tipo: string;
  severidad: 'critica' | 'alta' | 'media' | 'baja';
  entidad: string | null;
  detalle: Record<string, unknown>;
  creadoEn: Date;
  antiguedadHoras: number;
}

export async function excepcionesAbiertas(db: Consultable): Promise<ExcepcionAbierta[]> {
  const { rows } = await db.query<{
    excepcion_id: string; sucursal: string | null; tipo: string;
    severidad: ExcepcionAbierta['severidad']; entidad: string | null;
    detalle: Record<string, unknown>; creado_en: Date; antiguedad_horas: string;
  }>(`SELECT * FROM reporte.f_excepciones_abiertas()`);
  return rows.map((r) => ({
    excepcionId: r.excepcion_id,
    sucursal: r.sucursal,
    tipo: r.tipo,
    severidad: r.severidad,
    entidad: r.entidad,
    detalle: r.detalle,
    creadoEn: r.creado_en,
    antiguedadHoras: Number(r.antiguedad_horas),
  }));
}

export async function excepcionesResumen(
  db: Consultable,
): Promise<Record<'critica' | 'alta' | 'media' | 'baja', number>> {
  const { rows } = await db.query<{ severidad: string; abiertas: number }>(
    `SELECT severidad, abiertas FROM reporte.f_excepciones_resumen()`,
  );
  const out = { critica: 0, alta: 0, media: 0, baja: 0 };
  for (const r of rows) out[r.severidad as keyof typeof out] = Number(r.abiertas);
  return out;
}

export interface FilaGasto {
  concepto: string;
  sucursal: string | null;
  movimientos: number;
  monto: number;
}

export async function gastos(
  db: Consultable, desde: string, hasta: string,
): Promise<FilaGasto[]> {
  const { rows } = await db.query<{
    concepto: string; sucursal: string | null; movimientos: number; monto: string;
  }>(
    `SELECT concepto, sucursal, movimientos, monto
       FROM reporte.f_gastos($1::date, $2::date)`,
    [desde, hasta],
  );
  return rows.map((r) => ({
    concepto: r.concepto,
    sucursal: r.sucursal,
    movimientos: Number(r.movimientos),
    monto: Number(r.monto),
  }));
}
