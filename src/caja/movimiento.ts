/**
 * Movimientos de un corte de caja: egresos, anulación y lectura por rol (F6).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
 *
 * El ingreso por pago de boleto lo crea un trigger (`core.trg_pago_a_ingreso`),
 * no esta capa. Aquí van los egresos por insumo, la anulación (baja lógica que
 * devuelve el monto al corte) y la lectura diferenciada por rol:
 *   - gerente / vendedor → solo movimientos activos (`v_movimiento_operativo`)
 *   - administrador       → activos e inactivos (`v_movimiento_auditoria`)
 */

import type { Consultable } from '../db/consulta.js';

export type Rol = 'administrador' | 'gerente' | 'vendedor';

export async function registrarEgreso(
  db: Consultable,
  args: { corteId: string; usuarioId: string; monto: number; descripcion: string; ahora?: Date },
): Promise<string> {
  const { rows } = await db.query<{ registrar_egreso: string }>(
    `SELECT core.registrar_egreso($1::uuid, $2::uuid, $3::numeric, $4::text, $5::timestamptz)`,
    [args.corteId, args.usuarioId, args.monto, args.descripcion, args.ahora ?? new Date()],
  );
  return rows[0]!.registrar_egreso;
}

/** Baja lógica de un movimiento. `true` si cambió algo (idempotente). */
export async function anularMovimiento(
  db: Consultable,
  args: { movimientoId: string; usuarioId: string; motivo: string; ahora?: Date },
): Promise<boolean> {
  const { rows } = await db.query<{ anular_movimiento: boolean }>(
    `SELECT core.anular_movimiento($1::uuid, $2::uuid, $3::text, $4::timestamptz)`,
    [args.movimientoId, args.usuarioId, args.motivo, args.ahora ?? new Date()],
  );
  return rows[0]!.anular_movimiento;
}

export interface Movimiento {
  id: string;
  corteCajaId: string;
  tipo: 'ingreso' | 'egreso';
  origenTipo: string;
  origenId: string | null;
  descripcion: string | null;
  monto: number;
  usuarioId: string;
  registradoEn: Date;
  activo: boolean;
}

interface FilaMovimiento {
  id: string;
  corte_caja_id: string;
  tipo: 'ingreso' | 'egreso';
  origen_tipo: string;
  origen_id: string | null;
  descripcion: string | null;
  monto: string;
  usuario_id: string;
  registrado_en: Date;
  activo: boolean;
}

/**
 * Movimientos de un corte, según lo que el rol puede ver. El administrador ve
 * también los inactivos ("como parte de su auditoría para visualizar posibles
 * malos manejos").
 */
export async function movimientosDeCorte(
  db: Consultable, corteId: string, rol: Rol,
): Promise<Movimiento[]> {
  const vista = rol === 'administrador'
    ? 'core.v_movimiento_auditoria'
    : 'core.v_movimiento_operativo';
  const { rows } = await db.query<FilaMovimiento>(
    `SELECT id, corte_caja_id, tipo, origen_tipo, origen_id, descripcion,
            monto, usuario_id, registrado_en, activo
       FROM ${vista}
      WHERE corte_caja_id = $1::uuid
      ORDER BY registrado_en, id`,
    [corteId],
  );
  return rows.map((r) => ({
    id: r.id,
    corteCajaId: r.corte_caja_id,
    tipo: r.tipo,
    origenTipo: r.origen_tipo,
    origenId: r.origen_id,
    descripcion: r.descripcion,
    monto: Number(r.monto),
    usuarioId: r.usuario_id,
    registradoEn: r.registrado_en,
    activo: r.activo,
  }));
}

export interface PasajeroBoleto { folio: string; pasajero: string; importe: number }

/** 0088: el envío detrás de un ingreso o reembolso de paquetería. */
export interface EnvioMovimiento {
  folio: string; descripcion: string; destino: string; destinatario: string;
  bultos: number; modalidad: 'pagado' | 'por_cobrar';
}

export interface MovimientoDetalle {
  id: string;
  corteCajaId: string;
  tipo: 'ingreso' | 'egreso';
  origenTipo: string;
  origenId: string | null;
  descripcion: string | null;
  monto: number;
  usuarioId: string;
  usuario: string;
  registradoEn: Date;
  activo: boolean;
  /** Solo si `origenTipo` es `pago_boleto`: cómo se cobró. */
  metodoPago: string | null;
  referenciaTransferencia: string | null;
  esAbono: boolean | null;
  ventaId: string | null;
  /** Pasajeros/folios de la venta (abonos incluidos), si `ventaId` no es null. */
  pasajeros: PasajeroBoleto[] | null;
  /** 0088: el envío, si el movimiento es de paquetería. */
  envio: EnvioMovimiento | null;
}

interface FilaMovimientoDetalle {
  id: string;
  corte_caja_id: string;
  tipo: 'ingreso' | 'egreso';
  origen_tipo: string;
  origen_id: string | null;
  descripcion: string | null;
  monto: string;
  usuario_id: string;
  usuario: string;
  registrado_en: Date;
  activo: boolean;
  metodo_pago: string | null;
  referencia_transferencia: string | null;
  es_abono: boolean | null;
  venta_id: string | null;
  pasajeros: PasajeroBoleto[] | null;
  envio: EnvioMovimiento | null;
}

/**
 * Movimientos de un corte con el detalle de pago (0077): método, referencia
 * de transferencia y los pasajeros/folios de la venta cuando el ingreso viene
 * de un boleto. Para la pantalla `/historial/:id/movimientos` (admin/gerente,
 * ambos ven inactivos ahí — la vista es de auditoría del historial, no la
 * operativa del corte activo).
 */
export async function movimientosCorteDetalle(
  db: Consultable, corteId: string,
): Promise<MovimientoDetalle[]> {
  const { rows } = await db.query<FilaMovimientoDetalle>(
    `SELECT id, corte_caja_id, tipo, origen_tipo, origen_id, descripcion, monto,
            usuario_id, usuario, registrado_en, activo, metodo_pago,
            referencia_transferencia, es_abono, venta_id, pasajeros, envio
       FROM core.movimientos_corte_detalle($1::uuid, true)`,
    [corteId],
  );
  return rows.map((r) => ({
    id: r.id,
    corteCajaId: r.corte_caja_id,
    tipo: r.tipo,
    origenTipo: r.origen_tipo,
    origenId: r.origen_id,
    descripcion: r.descripcion,
    monto: Number(r.monto),
    usuarioId: r.usuario_id,
    usuario: r.usuario,
    registradoEn: r.registrado_en,
    activo: r.activo,
    metodoPago: r.metodo_pago,
    referenciaTransferencia: r.referencia_transferencia,
    esAbono: r.es_abono,
    ventaId: r.venta_id,
    pasajeros: r.pasajeros,
    envio: r.envio,
  }));
}
