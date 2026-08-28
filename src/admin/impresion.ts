/**
 * Configuración de impresora y de ticket desde la consola (F2b, slice 4).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.1, §3
 *                  docs/architecture/04-riesgos-roadmap.md §F0 (pendiente de impresora)
 *
 * `core.config_impresora` NO lleva fecha de vigencia a propósito (0011): la IP de
 * una impresora es hardware presente, no una política que se programe para la
 * madrugada. Un cambio de IP surte efecto en la siguiente impresión. Por eso solo
 * admite el modo inmediato. Este es el pendiente de F0: cuando llegue la Enduro,
 * `configurarImpresora({ ip })` y listo, sin desplegar nada.
 *
 * `core.config_ticket` sí es versionado-append (`v_config_ticket_vigente` toma la
 * fila con `effective_from` más reciente ya vencido): cada cambio es una fila
 * nueva, y puede programarse.
 */

import type { Consultable } from '../db/consulta.js';
import { escribirConfig, type ModoPropagacion } from './escribir-config.js';

export type Transporte = 'tcp' | 'usb';

export interface DatosImpresora {
  sucursalId: string;
  nombre: string;
  transporte: Transporte;
  /** Requerida si `transporte = 'tcp'`. */
  ip?: string;
  puerto?: number;
  /** Requerido si `transporte = 'usb'`. */
  usbNombreCola?: string;
  anchoMm?: number;
  anchoCols?: number;
  codePage?: string;
  soportaQrNativo?: boolean;
  esPredeterminada?: boolean;
}

export interface DatosTicket {
  agenciaId: string;
  logoUrl?: string | null;
  telefonoAtencion?: string | null;
  leyendaPie?: string | null;
  credencialesProveedor?: string | null;
  hmacQrSecreto?: string | null;
}

interface OpcionesTicket {
  modo?: ModoPropagacion;
  fechaProgramada?: Date;
  confirmarInmediato?: boolean;
  ahora?: () => Date;
}

const filaImpresora = (d: DatosImpresora): Record<string, unknown> => {
  const fila: Record<string, unknown> = {
    sucursal_id: d.sucursalId,
    nombre: d.nombre,
    transporte: d.transporte,
  };
  if (d.ip !== undefined) fila['ip'] = d.ip;
  if (d.puerto !== undefined) fila['puerto'] = d.puerto;
  if (d.usbNombreCola !== undefined) fila['usb_nombre_cola'] = d.usbNombreCola;
  if (d.anchoMm !== undefined) fila['ancho_mm'] = d.anchoMm;
  if (d.anchoCols !== undefined) fila['ancho_cols'] = d.anchoCols;
  if (d.codePage !== undefined) fila['code_page'] = d.codePage;
  if (d.soportaQrNativo !== undefined) fila['soporta_qr_nativo'] = d.soportaQrNativo;
  if (d.esPredeterminada !== undefined) fila['es_predeterminada'] = d.esPredeterminada;
  return fila;
};

function validarTransporte(d: DatosImpresora): void {
  if (d.transporte === 'tcp' && !d.ip) {
    throw new Error('transporte "tcp" exige ip');
  }
  if (d.transporte === 'usb' && !d.usbNombreCola) {
    throw new Error('transporte "usb" exige usbNombreCola');
  }
}

/**
 * Da de alta o actualiza la impresora de una sucursal. Siempre inmediato.
 *
 * Si la sucursal ya tiene una impresora vigente, se ACTUALIZA esa fila (corregir
 * la IP, cambiar de transporte). Si no, se crea.
 */
export async function configurarImpresora(
  db: Consultable,
  datos: DatosImpresora,
  opts: { ahora?: () => Date } = {},
): Promise<{ id: string; creada: boolean }> {
  validarTransporte(datos);

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM core.config_impresora
      WHERE sucursal_id = $1 AND activo
      ORDER BY es_predeterminada DESC, modificado_en DESC NULLS LAST
      LIMIT 1`,
    [datos.sucursalId],
  );

  const fila = filaImpresora(datos);
  if (rows[0]) fila['id'] = rows[0].id;

  const r = await escribirConfig(db, {
    tabla: 'core.config_impresora',
    fila,
    modo: 'inmediato',
    confirmarInmediato: true,
    ...(opts.ahora ? { ahora: opts.ahora } : {}),
  });
  return { id: r.id, creada: r.creada };
}

export async function listarImpresoras(
  db: Consultable,
  sucursalId?: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `SELECT ci.id, ci.sucursal_id, ci.nombre, ci.transporte, host(ci.ip) AS ip,
            ci.puerto, ci.usb_nombre_cola, ci.ancho_mm, ci.ancho_cols, ci.code_page,
            ci.soporta_qr_nativo, ci.es_predeterminada, ci.activo,
            s.nombre AS sucursal_nombre
       FROM core.config_impresora ci
       JOIN core.sucursal s ON s.id = ci.sucursal_id
      WHERE ($1::uuid IS NULL OR ci.sucursal_id = $1)
      ORDER BY s.codigo, ci.es_predeterminada DESC`,
    [sucursalId ?? null],
  );
  return rows;
}

/**
 * Publica una versión nueva de la configuración de ticket de la agencia.
 *
 * SIEMPRE es una fila nueva (`config_ticket` es versionado-append). Modo `ventana`
 * por defecto — cambios cosméticos —, pero admite inmediato (§3.4).
 */
export async function configurarTicket(
  db: Consultable,
  datos: DatosTicket,
  opts: OpcionesTicket = {},
): Promise<{ id: string; effectiveFrom: string }> {
  const fila: Record<string, unknown> = { agencia_id: datos.agenciaId };
  if (datos.logoUrl !== undefined) fila['logo_url'] = datos.logoUrl;
  if (datos.telefonoAtencion !== undefined) fila['telefono_atencion'] = datos.telefonoAtencion;
  if (datos.leyendaPie !== undefined) fila['leyenda_pie'] = datos.leyendaPie;
  if (datos.credencialesProveedor !== undefined) fila['credenciales_proveedor'] = datos.credencialesProveedor;
  if (datos.hmacQrSecreto !== undefined) fila['hmac_qr_secreto'] = datos.hmacQrSecreto;

  const r = await escribirConfig(db, {
    tabla: 'core.config_ticket',
    fila,
    modo: opts.modo ?? 'ventana',
    ...(opts.fechaProgramada ? { fechaProgramada: opts.fechaProgramada } : {}),
    ...(opts.confirmarInmediato ? { confirmarInmediato: true } : {}),
    ...(opts.ahora ? { ahora: opts.ahora } : {}),
  });
  return { id: r.id, effectiveFrom: r.vigenciaDesde.toISOString() };
}

/**
 * La configuración de ticket en vigor en `ahora`.
 *
 * Consulta la tabla base, no `v_config_ticket_vigente`: la vista fija el instante
 * en `now()` de la base, y la consola necesita poder previsualizar a una fecha
 * dada (y las pruebas corren con un reloj inyectado).
 */
export async function ticketVigente(
  db: Consultable,
  agenciaId: string,
  ahora: Date = new Date(),
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query(
    `SELECT agencia_id, logo_url, telefono_atencion, leyenda_pie,
            credenciales_proveedor, hmac_qr_secreto, effective_from
       FROM core.config_ticket
      WHERE agencia_id = $1 AND activo AND effective_from <= $2::timestamptz
      ORDER BY effective_from DESC LIMIT 1`,
    [agenciaId, ahora.toISOString()],
  );
  return rows[0] ?? null;
}
