import { api } from './cliente';

export interface SalidaDisponible {
  salidaId: string;
  horarioId: string;
  fechaOperacion: string;
  horaSalidaOrigen: string;
  origenOrden: number;
  destinoOrden: number;
  estado: string;
  cierreVentaEn: string;
  importe: number | null;
  asientosOfrecibles: number[];
  disponibles: number;
  seleccionable: boolean;
  rutaNombre: string;
  origenNombre: string;
  destinoNombre: string;
  /** Paradas intermedias entre origen y destino; vacío si es directo. */
  escalas: string[];
}

export interface BuscarParams {
  fecha: string;
  origen: string;
  destino: string;
  personas: number;
  conConexion: boolean;
}

export function buscarSalidas(p: BuscarParams): Promise<SalidaDisponible[]> {
  const q = new URLSearchParams({
    fecha: p.fecha,
    origen: p.origen,
    destino: p.destino,
    personas: String(p.personas),
    conConexion: String(p.conConexion),
  });
  return api<SalidaDisponible[]>(`/ventas/salidas?${q.toString()}`);
}

export interface ResultadoLease {
  estado: 'otorgado' | 'ocupado' | 'lease_ajeno';
  leaseId: string | null;
  expiraEn: string | null;
}

export function adquirirLease(datos: {
  salidaId: string; asientoNum: number; desde: number; hasta: number;
}): Promise<ResultadoLease> {
  return api<ResultadoLease>('/ventas/lease', {
    method: 'POST',
    body: JSON.stringify(datos),
  });
}

export interface Pasajero {
  asientoNum: number;
  nombre: string;
  importe: number;
  leaseId?: string;
}

export interface PagoInput {
  metodo: 'efectivo' | 'transferencia';
  monto: number;
  esAbono?: boolean;
  referencia?: string;
}

export interface NuevaVenta {
  salidaId: string;
  origenOrden: number;
  destinoOrden: number;
  contactoTelefono: string;
  esReservacion?: boolean;
  clienteId?: string;
  conConexion?: boolean;
  pasajeros: Pasajero[];
  pago?: PagoInput;
}

export interface BoletoEmitido {
  boletoId: string;
  folio: string;
  asientoNum: number;
  pasajero: string;
  importe: number;
}

export interface ResultadoVenta {
  ventaId: string;
  estado: 'pendiente' | 'liquidada';
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
  boletos: BoletoEmitido[];
  printJobs: number;
  imprimible: boolean;
}

export function registrarVenta(v: NuevaVenta): Promise<ResultadoVenta> {
  return api<ResultadoVenta>('/ventas', {
    method: 'POST',
    body: JSON.stringify(v),
  });
}

export interface ResultadoPago {
  pagoId: string;
  pagado: number;
  saldoPendiente: number;
  liquidada: boolean;
  printJobs: number;
}

export function registrarPago(ventaId: string, pago: PagoInput): Promise<ResultadoPago> {
  return api<ResultadoPago>(`/ventas/${ventaId}/pagos`, {
    method: 'POST',
    body: JSON.stringify(pago),
  });
}

export interface DetalleVenta {
  ventaId: string;
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
  boletos: Array<{
    id: string;
    folio: string;
    asientoNum: number;
    tramos: string;
    pasajeroNombre: string;
    importe: number;
    estado: string;
    impresoEn: string | null;
  }>;
}

export function detalleVenta(ventaId: string): Promise<DetalleVenta> {
  return api<DetalleVenta>(`/ventas/${ventaId}`);
}
