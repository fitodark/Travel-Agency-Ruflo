/**
 * Override LOCAL de emergencia para IP/transporte de una impresora (0078).
 *
 * `core.config_impresora` es clase A (solo la nube escribe, 01-sincronización
 * §1): así un administrador remoto corrige la impresora de una sucursal sin
 * viajar (D-4). Pero esa misma regla deja sin salida al administrador que SÍ
 * está en la sucursal cuando la IP cambió y no hay internet en ese momento:
 * `/admin/*` entero responde 503, y escribir la fila en LOCAL no serviría de
 * nada porque el siguiente pull la revertiría ("clase A: el nodo nunca la
 * gana", sync/pull.ts).
 *
 * Esta tabla es deliberadamente ajena al sync (no pasa por
 * `core.registrar_entidad`, no está en `CLASE_POR_TABLA`): nunca se sube ni
 * se baja. `cargarConfigImpresora` (./config.ts) la consulta primero y gana
 * mientras exista. No se autolimpia: la fuente de verdad sigue siendo la
 * consola — cuando vuelve el internet, el administrador debe corregir ahí la
 * IP real, y puede borrar el override desde aquí si quiere.
 */

import type { Consultable } from '../db/consulta.js';

export type Transporte = 'tcp' | 'usb';

export interface OverrideImpresoraLocal {
  impresoraId: string;
  transporte: Transporte;
  ip: string | null;
  puerto: number | null;
  usbNombreCola: string | null;
  nota: string | null;
  actualizadoEn: string;
  actualizadoPor: string;
}

export interface ImpresoraLocalConEstado {
  id: string;
  sucursalId: string;
  nombre: string;
  /** Transporte/IP vigentes: los del override si existe, si no los replicados. */
  transporte: Transporte;
  ip: string | null;
  puerto: number | null;
  usbNombreCola: string | null;
  esPredeterminada: boolean;
  override: OverrideImpresoraLocal | null;
}

function validarTransporte(d: { transporte: Transporte; ip?: string; usbNombreCola?: string }): void {
  if (d.transporte === 'tcp' && !d.ip) {
    throw new Error('transporte "tcp" exige ip');
  }
  if (d.transporte === 'usb' && !d.usbNombreCola) {
    throw new Error('transporte "usb" exige usbNombreCola');
  }
}

/**
 * Impresoras de la sucursal, con el override local encima si lo tiene. Lee
 * siempre la base LOCAL: por diseño debe responder igual con o sin nube.
 */
export async function listarImpresorasLocales(
  db: Consultable,
  sucursalId: string,
): Promise<ImpresoraLocalConEstado[]> {
  const { rows } = await db.query<{
    id: string; sucursal_id: string; nombre: string; transporte: Transporte;
    ip: string | null; puerto: number | null; usb_nombre_cola: string | null;
    es_predeterminada: boolean;
    o_transporte: Transporte | null; o_ip: string | null; o_puerto: number | null;
    o_usb_nombre_cola: string | null; o_nota: string | null;
    o_actualizado_en: Date | null; o_actualizado_por: string | null;
  }>(
    `SELECT ci.id, ci.sucursal_id, ci.nombre, ci.transporte, host(ci.ip) AS ip, ci.puerto,
            ci.usb_nombre_cola, ci.es_predeterminada,
            o.transporte AS o_transporte, host(o.ip) AS o_ip, o.puerto AS o_puerto,
            o.usb_nombre_cola AS o_usb_nombre_cola, o.nota AS o_nota,
            o.actualizado_en AS o_actualizado_en, o.actualizado_por AS o_actualizado_por
       FROM core.config_impresora ci
       LEFT JOIN core.config_impresora_override_local o ON o.impresora_id = ci.id
      WHERE ci.sucursal_id = $1 AND ci.activo
      ORDER BY ci.es_predeterminada DESC, ci.nombre`,
    [sucursalId],
  );

  return rows.map((r) => ({
    id: r.id,
    sucursalId: r.sucursal_id,
    nombre: r.nombre,
    transporte: r.o_actualizado_en ? r.o_transporte! : r.transporte,
    ip: r.o_actualizado_en ? r.o_ip : r.ip,
    puerto: r.o_actualizado_en ? r.o_puerto : r.puerto,
    usbNombreCola: r.o_actualizado_en ? r.o_usb_nombre_cola : r.usb_nombre_cola,
    esPredeterminada: r.es_predeterminada,
    override: r.o_actualizado_en ? {
      impresoraId: r.id,
      transporte: r.o_transporte!,
      ip: r.o_ip,
      puerto: r.o_puerto,
      usbNombreCola: r.o_usb_nombre_cola,
      nota: r.o_nota,
      actualizadoEn: r.o_actualizado_en.toISOString(),
      actualizadoPor: r.o_actualizado_por!,
    } : null,
  }));
}

/** Da de alta o reemplaza el override de una impresora ya existente en LOCAL. */
export async function fijarOverrideLocal(
  db: Consultable,
  datos: {
    impresoraId: string; transporte: Transporte; ip?: string; puerto?: number;
    usbNombreCola?: string; nota?: string; actualizadoPor: string;
  },
  opts: { ahora?: () => Date } = {},
): Promise<void> {
  validarTransporte(datos);

  const existe = await db.query(
    `SELECT 1 FROM core.config_impresora WHERE id = $1 AND activo`, [datos.impresoraId],
  );
  if ((existe.rowCount ?? 0) === 0) {
    throw new Error(
      'Esa impresora no existe (o no está activa) en la base local de esta terminal.',
    );
  }

  const ahora = opts.ahora?.() ?? new Date();
  await db.query(
    `INSERT INTO core.config_impresora_override_local
       (impresora_id, transporte, ip, puerto, usb_nombre_cola, nota, actualizado_en, actualizado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (impresora_id) DO UPDATE SET
       transporte      = EXCLUDED.transporte,
       ip              = EXCLUDED.ip,
       puerto          = EXCLUDED.puerto,
       usb_nombre_cola = EXCLUDED.usb_nombre_cola,
       nota            = EXCLUDED.nota,
       actualizado_en  = EXCLUDED.actualizado_en,
       actualizado_por = EXCLUDED.actualizado_por`,
    [
      datos.impresoraId, datos.transporte, datos.ip ?? null, datos.puerto ?? null,
      datos.usbNombreCola ?? null, datos.nota ?? null, ahora, datos.actualizadoPor,
    ],
  );
}

/** Quita el override: la impresora vuelve a usar lo replicado de la nube. */
export async function quitarOverrideLocal(db: Consultable, impresoraId: string): Promise<void> {
  await db.query(`DELETE FROM core.config_impresora_override_local WHERE impresora_id = $1`, [impresoraId]);
}
