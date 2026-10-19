import { api } from './cliente';

export interface CorteAbierto {
  corteId: string;
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  /** Ingresos en efectivo (0065). */
  ingresosEfectivo: number;
  /** Ingresos por transferencia verificada (0065): suman al corte, no a la caja. */
  ingresosTransferencia: number;
  /** Efectivo que debe estar en la caja = inicial + ingresos efectivo − egresos. */
  efectivoCalculado: number;
  /** Total del corte (incluye transferencia). */
  saldoCalculado: number;
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
  registradoEn: string;
  activo: boolean;
}

export interface CierreCorte {
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  ingresosEfectivo: number;
  /** Ingresos por transferencia verificada: suman al corte, no a la caja. */
  transferencia: number;
  /** Efectivo que debe estar en la caja. */
  efectivoCalculado: number;
  /** Total del corte (incluye transferencia). */
  saldoCalculado: number;
  saldoDeclarado: number;
  /** `declarado − efectivoCalculado`. */
  diferencia: number;
}

export function corteAbierto(): Promise<CorteAbierto | null> {
  return api<CorteAbierto | null>('/caja/corte');
}

export function abrirCorte(saldoInicial: number): Promise<{ corteId: string }> {
  return api('/caja/corte', { method: 'POST', body: JSON.stringify({ saldoInicial }) });
}

export function cerrarCorte(corteId: string, saldoDeclarado: number): Promise<CierreCorte> {
  return api<CierreCorte>(`/caja/corte/${corteId}/cerrar`, {
    method: 'POST',
    body: JSON.stringify({ saldoDeclarado }),
  });
}

export function movimientos(corteId: string): Promise<Movimiento[]> {
  return api<Movimiento[]>(`/caja/corte/${corteId}/movimientos`);
}

export interface PasajeroBoleto { folio: string; pasajero: string; importe: number }

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
  registradoEn: string;
  activo: boolean;
  /** Solo si `origenTipo` es `pago_boleto`: cómo se cobró. */
  metodoPago: string | null;
  referenciaTransferencia: string | null;
  esAbono: boolean | null;
  ventaId: string | null;
  /** Pasajeros/folios de la venta (abonos incluidos), si `ventaId` no es null. */
  pasajeros: PasajeroBoleto[] | null;
}

/** Movimientos con detalle de pago (0077), para /historial/:id/movimientos. */
export function movimientosCorteDetalle(corteId: string): Promise<MovimientoDetalle[]> {
  return api<MovimientoDetalle[]>(`/caja/corte/${corteId}/movimientos-detalle`);
}

export interface CobradoEnCorresponsal {
  conteo: number;
  suma: number;
  detalle: {
    pagoId: string;
    folio: string | null;
    pasajero: string | null;
    sucursalCobro: string;
    monto: number;
    pagadoEn: string;
  }[];
}

/** Apartado "cobrado en corresponsal" del corte (D8): no entra al efectivo. */
export function cobradoEnCorresponsal(corteId: string): Promise<CobradoEnCorresponsal> {
  return api<CobradoEnCorresponsal>(`/caja/corte/${corteId}/corresponsal`);
}

export interface CorteHistorial {
  corteId: string;
  sucursalId: string;
  sucursal: string;
  estado: 'abierto' | 'cerrado';
  abiertoEn: string;
  cerradoEn: string | null;
  usuarioAperturaId: string;
  usuarioApertura: string;
  usuarioCierre: string | null;
  saldoInicial: number;
  ingresos: number;
  egresos: number;
  /** Ingresos por transferencia verificada: suman al corte, no a la caja. */
  transferencia: number;
  /** Efectivo que debe estar en la caja. */
  efectivoCalculado: number;
  /** Total del corte (incluye transferencia). */
  saldoCalculado: number;
  saldoDeclarado: number | null;
  /** `declarado − efectivoCalculado`. */
  diferencia: number | null;
}

export interface FiltrosHistorial {
  desde?: string; hasta?: string; estado?: 'abierto' | 'cerrado'; sucursalId?: string;
  usuarioAperturaId?: string;
}

export interface HistorialCortesPagina {
  filas: CorteHistorial[];
  /** Total que cumple el filtro, antes de paginar. */
  total: number;
  pagina: number;
  porPagina: 20 | 50 | 100;
}

const aQs = (obj: object): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj) as [string, string | number | undefined][]) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * Historial de cortes, paginado (0077, restringido a admin/gerente): admin =
 * todas las sucursales; gerente = la que elija entre las suyas. En modo
 * consulta (0076, sin sucursal activa) hay que mandar `sucursalId` explícito.
 */
export function historialCortes(
  filtros: FiltrosHistorial & { pagina?: number; porPagina?: 20 | 50 | 100 } = {},
): Promise<HistorialCortesPagina> {
  return api<HistorialCortesPagina>(`/caja/cortes${aQs(filtros)}`);
}

export interface UsuarioBreve { id: string; nombre: string }

/** Combo de filtro "usuario que abrió el corte" (0077). */
export function cortesUsuariosVisibles(
  filtros: Omit<FiltrosHistorial, 'usuarioAperturaId'> = {},
): Promise<UsuarioBreve[]> {
  return api<UsuarioBreve[]>(`/caja/cortes/usuarios${aQs(filtros)}`);
}

/** Resumen de un corte por id (0077), para el encabezado del detalle. */
export function corteDetalle(corteId: string): Promise<CorteHistorial> {
  return api<CorteHistorial>(`/caja/cortes/${corteId}`);
}

export function registrarEgreso(
  corteId: string, datos: { monto: number; descripcion: string },
): Promise<{ movimientoId: string }> {
  return api(`/caja/corte/${corteId}/egresos`, {
    method: 'POST',
    body: JSON.stringify(datos),
  });
}

export function anularMovimiento(id: string, motivo: string): Promise<{ anulado: boolean }> {
  return api(`/caja/movimientos/${id}/anular`, {
    method: 'POST',
    body: JSON.stringify({ motivo }),
  });
}

// ---------------------------------------------------------------------------
// Transferencias por verificar (0065): el encargado recibe el comprobante y
// confirma el pago; el monto entra al corte abierto en ese momento.
// ---------------------------------------------------------------------------
export interface TransferenciaPorVerificar {
  pagoId: string;
  ventaId: string;
  folio: string | null;
  pasajero: string | null;
  monto: number;
  referencia: string | null;
  vendedor: string;
  registradoEn: string;
}

export function transferenciasPorVerificar(): Promise<TransferenciaPorVerificar[]> {
  return api<TransferenciaPorVerificar[]>('/caja/transferencias-por-verificar');
}

export interface ConfirmacionTransferencia {
  pagado: number;
  saldoPendiente: number;
  liquidada: boolean;
  printJobs: number;
}

/** Confirma el comprobante de una transferencia (quien vendió o un gerente/admin). */
export function confirmarTransferencia(pagoId: string): Promise<ConfirmacionTransferencia> {
  return api<ConfirmacionTransferencia>(`/ventas/pagos/${pagoId}/verificar`, { method: 'POST' });
}
