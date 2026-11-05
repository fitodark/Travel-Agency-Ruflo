/**
 * Paquetería: registro y consulta de envíos (Fase C).
 *
 * docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P1..P6, P8)
 *
 * La lógica transaccional vive en `core.registrar_envio` /
 * `core.verificar_transferencia_envio` / `core.v_envio_estado` (0084). Aquí
 * solo se invocan y se normalizan.
 */

import type { Consultable } from '../db/consulta.js';
import { normalizarFolio } from '../fleet/abordaje.js';

export type Modalidad = 'pagado' | 'por_cobrar';
export type EstadoEnvio = 'registrado' | 'en_ruta' | 'en_sucursal' | 'entregado' | 'cancelado';
export type EstadoPagoEnvio = 'pagado' | 'por_confirmar' | 'pendiente';

export interface PagoEnvioInput {
  metodo: 'efectivo' | 'transferencia';
  /** Solo efectivo: con cuánto pagó (>= importe). */
  efectivoRecibido?: number;
  referencia?: string;
  corteCajaId?: string;
}

export interface RegistrarEnvioArgs {
  salidaId: string;
  sucursalOrigenId: string;
  usuarioId: string;
  sucursalDestinoId: string;
  remitenteNombre: string;
  remitenteTelefono: string;
  destinatarioNombre: string;
  destinatarioTelefono: string;
  descripcion: string;
  bultos: number;
  importe: number;
  modalidad: Modalidad;
  /** Obligatorio si `pagado`; prohibido si `por_cobrar` (P3). */
  pago?: PagoEnvioInput;
  ahora?: Date;
}

export interface ResultadoEnvio {
  envioId: string;
  folio: string;
  estadoPago: EstadoPagoEnvio;
  pagoEnvioId: string | null;
  /** Tickets encolados (0085): el recibo + uno por bulto. */
  printJobs: number;
}

export async function registrarEnvio(db: Consultable, a: RegistrarEnvioArgs): Promise<ResultadoEnvio> {
  const pago = a.pago
    ? {
        metodo: a.pago.metodo,
        ...(a.pago.efectivoRecibido != null ? { efectivo_recibido: a.pago.efectivoRecibido } : {}),
        ...(a.pago.referencia ? { referencia: a.pago.referencia } : {}),
        ...(a.pago.corteCajaId ? { corte_caja_id: a.pago.corteCajaId } : {}),
      }
    : null;
  const { rows } = await db.query<{
    envio_id: string; folio: string; estado_pago: EstadoPagoEnvio; pago_envio_id: string | null;
    print_jobs: number;
  }>(
    `SELECT envio_id, folio, estado_pago, pago_envio_id, print_jobs
       FROM core.registrar_envio($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9,
                                 $10::int, $11::numeric, $12, $13::jsonb, $14::timestamptz)`,
    [
      a.salidaId, a.sucursalOrigenId, a.usuarioId, a.sucursalDestinoId,
      a.remitenteNombre, a.remitenteTelefono, a.destinatarioNombre, a.destinatarioTelefono,
      a.descripcion, a.bultos, a.importe, a.modalidad,
      pago ? JSON.stringify(pago) : null, a.ahora ?? new Date(),
    ],
  );
  const r = rows[0]!;
  return {
    envioId: r.envio_id, folio: r.folio, estadoPago: r.estado_pago,
    pagoEnvioId: r.pago_envio_id, printJobs: Number(r.print_jobs),
  };
}

export interface Envio {
  envioId: string;
  folio: string;
  salidaId: string;
  fechaOperacion: string;
  origen: string;
  destino: string;
  sucursalOrigenId: string;
  sucursalDestinoId: string;
  remitenteNombre: string;
  remitenteTelefono: string;
  destinatarioNombre: string;
  destinatarioTelefono: string;
  descripcion: string;
  bultos: number;
  importe: number;
  modalidad: Modalidad;
  estado: EstadoEnvio;
  estadoPago: EstadoPagoEnvio;
  cobrado: number;
  porConfirmar: number;
  porCobrar: number;
  registradoEn: Date;
  registradoPor: string;
  /** Transferencia aún sin confirmar (para el botón "Confirmar"), si la hay. */
  pagoPorConfirmarId: string | null;
}

export const SELECT_ENVIO = `
  SELECT e.id AS envio_id, e.folio, e.salida_id, s.fecha_operacion::text AS fecha_operacion,
         so.nombre AS origen, sd.nombre AS destino,
         e.sucursal_origen_id, e.sucursal_destino_id,
         e.remitente_nombre, e.remitente_telefono, e.destinatario_nombre, e.destinatario_telefono,
         e.descripcion, e.bultos, e.importe, e.modalidad,
         es.estado, es.estado_pago, es.cobrado, es.por_confirmar, es.por_cobrar,
         e.registrado_en, u.nombre AS registrado_por,
         (SELECT p.id FROM core.pago_envio p
           WHERE p.envio_id = e.id AND p.activo AND p.metodo = 'transferencia' AND NOT p.verificado
           ORDER BY p.pagado_en LIMIT 1) AS pago_por_confirmar_id
    FROM core.envio e
    JOIN core.v_envio_estado es ON es.envio_id = e.id
    JOIN core.salida s    ON s.id  = e.salida_id
    JOIN core.sucursal so ON so.id = e.sucursal_origen_id
    JOIN core.sucursal sd ON sd.id = e.sucursal_destino_id
    JOIN core.usuario u   ON u.id  = e.usuario_id`;

export interface FilaEnvio {
  envio_id: string; folio: string; salida_id: string; fecha_operacion: string;
  origen: string; destino: string; sucursal_origen_id: string; sucursal_destino_id: string;
  remitente_nombre: string; remitente_telefono: string;
  destinatario_nombre: string; destinatario_telefono: string;
  descripcion: string; bultos: number; importe: string; modalidad: Modalidad;
  estado: EstadoEnvio; estado_pago: EstadoPagoEnvio;
  cobrado: string; por_confirmar: string; por_cobrar: string;
  registrado_en: Date; registrado_por: string; pago_por_confirmar_id: string | null;
}

export const mapear = (r: FilaEnvio): Envio => ({
  envioId: r.envio_id,
  folio: r.folio,
  salidaId: r.salida_id,
  fechaOperacion: r.fecha_operacion,
  origen: r.origen,
  destino: r.destino,
  sucursalOrigenId: r.sucursal_origen_id,
  sucursalDestinoId: r.sucursal_destino_id,
  remitenteNombre: r.remitente_nombre,
  remitenteTelefono: r.remitente_telefono,
  destinatarioNombre: r.destinatario_nombre,
  destinatarioTelefono: r.destinatario_telefono,
  descripcion: r.descripcion,
  bultos: Number(r.bultos),
  importe: Number(r.importe),
  modalidad: r.modalidad,
  estado: r.estado,
  estadoPago: r.estado_pago,
  cobrado: Number(r.cobrado),
  porConfirmar: Number(r.por_confirmar),
  porCobrar: Number(r.por_cobrar),
  registradoEn: r.registrado_en,
  registradoPor: r.registrado_por,
  pagoPorConfirmarId: r.pago_por_confirmar_id,
});

/** Consulta de un envío por folio (P10 auditoría). El folio es único global. */
export async function buscarEnvioPorFolio(db: Consultable, folioEntrada: string): Promise<Envio | null> {
  const folio = normalizarFolio(folioEntrada);
  if (folio.length !== 6) return null;
  const { rows } = await db.query<FilaEnvio>(`${SELECT_ENVIO} WHERE e.folio = $1`, [folio]);
  return rows[0] ? mapear(rows[0]) : null;
}

/** Envíos de una salida que tocan mi sucursal (como origen o destino). */
export async function enviosDeSalida(
  db: Consultable, salidaId: string, sucursalId: string,
): Promise<Envio[]> {
  const { rows } = await db.query<FilaEnvio>(
    `${SELECT_ENVIO}
      WHERE e.salida_id = $1::uuid AND e.activo
        AND $2::uuid IN (e.sucursal_origen_id, e.sucursal_destino_id)
      ORDER BY e.registrado_en`,
    [salidaId, sucursalId],
  );
  return rows.map(mapear);
}

export async function verificarTransferenciaEnvio(
  db: Consultable, pagoEnvioId: string, usuarioId: string, ahora?: Date,
): Promise<{ envioId: string; estadoPago: EstadoPagoEnvio }> {
  const { rows } = await db.query<{ envio_id: string; estado_pago: EstadoPagoEnvio }>(
    `SELECT envio_id, estado_pago
       FROM core.verificar_transferencia_envio($1::uuid, $2::uuid, $3::timestamptz)`,
    [pagoEnvioId, usuarioId, ahora ?? new Date()],
  );
  return { envioId: rows[0]!.envio_id, estadoPago: rows[0]!.estado_pago };
}

export type QueReimprimir = 'recibo' | 'etiquetas' | 'todo';

/** Reimprime el recibo, todas las etiquetas o una sola (`bulto`), con motivo (0085). */
export async function reimprimirEnvio(
  db: Consultable,
  a: { envioId: string; sucursalId: string; que: QueReimprimir; motivo: string; bulto?: number },
): Promise<{ printJobs: number }> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT core.reimprimir_envio($1::uuid, $2::uuid, $3, $4, $5::int) AS n`,
    [a.envioId, a.sucursalId, a.que, a.motivo, a.bulto ?? null],
  );
  return { printJobs: Number(rows[0]!.n) };
}

// ---------------------------------------------------------------------------
// Fase E (0086): en ruta, recepción en destino y entrega.
// ---------------------------------------------------------------------------

/** Pasa a en ruta los envíos de la salida que salen de mi terminal (P8). */
export async function despacharEnvios(
  db: Consultable, a: { salidaId: string; sucursalId: string; usuarioId: string; ahora?: Date },
): Promise<{ despachados: number }> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT core.despachar_envios($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) AS n`,
    [a.salidaId, a.sucursalId, a.usuarioId, a.ahora ?? new Date()],
  );
  return { despachados: Number(rows[0]!.n) };
}

/** Pasa a en ruta UN envío registrado, desde su terminal de origen (0089). */
export async function despacharEnvio(
  db: Consultable, a: { envioId: string; sucursalId: string; usuarioId: string; ahora?: Date },
): Promise<{ envioId: string; estado: EstadoEnvio }> {
  const { rows } = await db.query<{ envio_id: string; estado: EstadoEnvio }>(
    `SELECT envio_id, estado FROM core.despachar_envio($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
    [a.envioId, a.sucursalId, a.usuarioId, a.ahora ?? new Date()],
  );
  return { envioId: rows[0]!.envio_id, estado: rows[0]!.estado };
}

export interface EstadoTrasEvento {
  envioId: string;
  estado: EstadoEnvio;
  estadoPago: EstadoPagoEnvio;
}

/** La terminal destino registra que el paquete llegó (en_sucursal). */
export async function recibirEnvio(
  db: Consultable, a: { envioId: string; sucursalId: string; usuarioId: string; ahora?: Date },
): Promise<EstadoTrasEvento & { porCobrar: number }> {
  const { rows } = await db.query<{
    envio_id: string; estado: EstadoEnvio; estado_pago: EstadoPagoEnvio; por_cobrar: string;
  }>(
    `SELECT envio_id, estado, estado_pago, por_cobrar
       FROM core.recibir_envio($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
    [a.envioId, a.sucursalId, a.usuarioId, a.ahora ?? new Date()],
  );
  const r = rows[0]!;
  return { envioId: r.envio_id, estado: r.estado, estadoPago: r.estado_pago, porCobrar: Number(r.por_cobrar) };
}

export interface EntregarEnvioArgs {
  envioId: string;
  sucursalId: string;
  usuarioId: string;
  /** El vendedor confirmó que el nombre completo de la credencial coincide (P9). */
  nombreVerificado: boolean;
  /** Solo si queda por cobrar: el cobro completo en destino. */
  pago?: PagoEnvioInput;
  ahora?: Date;
}

/** Entrega al destinatario; si es por cobrar, cobra completo en el corte del destino. */
export async function entregarEnvio(
  db: Consultable, a: EntregarEnvioArgs,
): Promise<EstadoTrasEvento & { pagoEnvioId: string | null }> {
  const pago = a.pago
    ? {
        metodo: a.pago.metodo,
        ...(a.pago.efectivoRecibido != null ? { efectivo_recibido: a.pago.efectivoRecibido } : {}),
        ...(a.pago.referencia ? { referencia: a.pago.referencia } : {}),
        ...(a.pago.corteCajaId ? { corte_caja_id: a.pago.corteCajaId } : {}),
      }
    : null;
  const { rows } = await db.query<{
    envio_id: string; estado: EstadoEnvio; estado_pago: EstadoPagoEnvio; pago_envio_id: string | null;
  }>(
    `SELECT envio_id, estado, estado_pago, pago_envio_id
       FROM core.entregar_envio($1::uuid, $2::uuid, $3::uuid, $4::boolean, $5::jsonb, $6::timestamptz)`,
    [a.envioId, a.sucursalId, a.usuarioId, a.nombreVerificado,
     pago ? JSON.stringify(pago) : null, a.ahora ?? new Date()],
  );
  const r = rows[0]!;
  return { envioId: r.envio_id, estado: r.estado, estadoPago: r.estado_pago, pagoEnvioId: r.pago_envio_id };
}

/** Envíos que llegan a mi sucursal, filtrados por estado (por recibir / por entregar). */
export async function enviosParaMiSucursal(
  db: Consultable, sucursalId: string, estados: EstadoEnvio[],
): Promise<Envio[]> {
  const { rows } = await db.query<FilaEnvio>(
    `${SELECT_ENVIO}
      WHERE e.sucursal_destino_id = $1::uuid AND e.activo AND es.estado = ANY($2::text[])
      ORDER BY e.registrado_en`,
    [sucursalId, estados],
  );
  return rows.map(mapear);
}

// ---------------------------------------------------------------------------
// Fase F (0087): mover de salida y cancelar (solo la terminal de origen).
// ---------------------------------------------------------------------------

/** Mueve un envío aún no despachado a otra salida y reimprime recibo + tickets (P10). */
export async function moverEnvio(
  db: Consultable,
  a: { envioId: string; salidaNuevaId: string; sucursalId: string; usuarioId: string; ahora?: Date },
): Promise<{ envioId: string; salidaId: string; printJobs: number }> {
  const { rows } = await db.query<{ envio_id: string; salida_id: string; print_jobs: number }>(
    `SELECT envio_id, salida_id, print_jobs
       FROM core.mover_envio($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz)`,
    [a.envioId, a.salidaNuevaId, a.sucursalId, a.usuarioId, a.ahora ?? new Date()],
  );
  const r = rows[0]!;
  return { envioId: r.envio_id, salidaId: r.salida_id, printJobs: Number(r.print_jobs) };
}

/** Cancela un envío aún no despachado; reembolso solo de lo cobrado en efectivo (P11). */
export async function cancelarEnvio(
  db: Consultable,
  a: { envioId: string; sucursalId: string; usuarioId: string; motivo: string; ahora?: Date },
): Promise<{ envioId: string; reembolso: number }> {
  const { rows } = await db.query<{ envio_id: string; reembolso: string }>(
    `SELECT envio_id, reembolso
       FROM core.cancelar_envio($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)`,
    [a.envioId, a.sucursalId, a.usuarioId, a.motivo, a.ahora ?? new Date()],
  );
  return { envioId: rows[0]!.envio_id, reembolso: Number(rows[0]!.reembolso) };
}

// ---------------------------------------------------------------------------
// Fase G: apoyo a las pantallas.
// ---------------------------------------------------------------------------

export interface SalidaParaEnvio {
  salidaId: string;
  ruta: string;
  estado: string;
  /** Hora de paso por MI terminal. */
  horaPaso: Date;
  unidad: string | null;
  /** ¿Todavía recibe envíos aquí? (vendible y antes del cierre de N minutos). */
  abierta: boolean;
}

/**
 * Salidas de un día que pasan por mi terminal y DESPUÉS por el destino: las
 * candidatas para registrar o mover un envío (P1, P6).
 */
export async function salidasParaEnvio(
  db: Consultable, a: { fecha: string; sucursalId: string; destinoId: string; ahora?: Date },
): Promise<SalidaParaEnvio[]> {
  const { rows } = await db.query<{
    salida_id: string; ruta: string; estado: string; hora_paso: Date;
    unidad: string | null; abierta: boolean;
  }>(
    `SELECT s.id AS salida_id, r.nombre AS ruta, s.estado, spo.hora_paso_programada AS hora_paso,
            un.numero_economico AS unidad,
            core.salida_vendible(s.estado, spo.orden)
              AND (spo.hora_paso_programada IS NULL
                   OR spo.hora_paso_programada - make_interval(mins => COALESCE(
                        (SELECT (valor)::text::integer FROM core.parametro
                          WHERE clave = 'minutos_cierre_paqueteria' AND effective_from <= $4
                          ORDER BY effective_from DESC LIMIT 1), 5)) > $4) AS abierta
       FROM core.salida s
       JOIN core.horario h ON h.id = s.horario_id
       JOIN core.ruta r    ON r.id = h.ruta_id
       LEFT JOIN core.unidad un ON un.id = s.unidad_id
       JOIN LATERAL (
         SELECT sp.orden, sp.hora_paso_programada
           FROM core.salida_parada sp JOIN core.punto_ruta pr ON pr.id = sp.punto_id
          WHERE sp.salida_id = s.id AND pr.sucursal_id = $2::uuid AND pr.tipo = 'terminal'
          ORDER BY sp.orden LIMIT 1
       ) spo ON true
      WHERE s.activo AND s.fecha_operacion = $1::date
        AND s.estado IN ('programada', 'en_ruta')
        AND EXISTS (
          SELECT 1 FROM core.salida_parada sd JOIN core.punto_ruta pd ON pd.id = sd.punto_id
           WHERE sd.salida_id = s.id AND pd.sucursal_id = $3::uuid AND pd.tipo = 'terminal'
             AND sd.orden > spo.orden)
      ORDER BY spo.hora_paso_programada`,
    [a.fecha, a.sucursalId, a.destinoId, a.ahora ?? new Date()],
  );
  return rows.map((r) => ({
    salidaId: r.salida_id, ruta: r.ruta, estado: r.estado, horaPaso: r.hora_paso,
    unidad: r.unidad, abierta: r.abierta,
  }));
}

export interface TransferenciaEnvioPorVerificar {
  pagoEnvioId: string;
  envioId: string;
  folio: string;
  descripcion: string;
  monto: number;
  referencia: string | null;
  cobradoPor: string;
  pagadoEn: Date;
}

/** Transferencias de paquetería cobradas en mi sucursal que falta confirmar (P4). */
export async function transferenciasEnvioPorVerificar(
  db: Consultable, sucursalId: string,
): Promise<TransferenciaEnvioPorVerificar[]> {
  const { rows } = await db.query<{
    pago_envio_id: string; envio_id: string; folio: string; descripcion: string;
    monto: string; referencia: string | null; cobrado_por: string; pagado_en: Date;
  }>(
    `SELECT p.id AS pago_envio_id, e.id AS envio_id, e.folio, e.descripcion, p.monto,
            p.referencia_transferencia AS referencia, u.nombre AS cobrado_por, p.pagado_en
       FROM core.pago_envio p
       JOIN core.envio e   ON e.id = p.envio_id
       JOIN core.usuario u ON u.id = p.usuario_id
      WHERE p.sucursal_cobro_id = $1::uuid AND p.activo
        AND p.metodo = 'transferencia' AND NOT p.verificado
      ORDER BY p.pagado_en`,
    [sucursalId],
  );
  return rows.map((r) => ({
    pagoEnvioId: r.pago_envio_id, envioId: r.envio_id, folio: r.folio, descripcion: r.descripcion,
    monto: Number(r.monto), referencia: r.referencia, cobradoPor: r.cobrado_por, pagadoEn: r.pagado_en,
  }));
}
