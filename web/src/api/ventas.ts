import { api } from './cliente';

/** Layout de la unidad congelado en la salida (D-7), para el mapa del paso 3. */
export interface MapaAsientosSalida {
  filas: number;
  columnas: number;
  /** Columna (0-based) después de la cual va el pasillo. */
  pasillo_despues_columna: number;
  accesos?: Array<{ fila: number; lado: 'izquierdo' | 'derecho'; etiqueta: string }>;
  asientos: Array<{
    num: number;
    fila: number;
    col: number;
    tipo?: string;
    vendible?: boolean;
  }>;
}

export interface SalidaDisponible {
  salidaId: string;
  horarioId: string;
  fechaOperacion: string;
  horaSalidaOrigen: string;
  /** `null` si el destino es una parada autorizada sin horario capturado. */
  horaLlegadaDestino: string | null;
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
  /** Tarifa vigente por categoría de pasajero: `{ general, inapam?, menor? }` (D4). */
  tarifas: Partial<Record<'general' | 'inapam' | 'menor', number>>;
  /** Layout de la unidad (D-7), para el mapa visual del paso 3. */
  mapa: MapaAsientosSalida;
  /** `core.tipo_unidad.nombre` — p. ej. "Mercedes Benz Sprinter 18 plazas". */
  unidadNombre: string;
  /** `null` si la salida aún no tiene una unidad física asignada. */
  unidadNumeroEconomico: string | null;
}

export type CategoriaPasajero = 'general' | 'inapam' | 'menor';

export interface BuscarParams {
  fecha: string;
  /** `core.punto_ruta.id` (desde Fase 1 / migración 0049), no id de sucursal. */
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
  categoria?: CategoriaPasajero;
  leaseId?: string;
}

export interface PagoInput {
  metodo: 'efectivo' | 'transferencia' | 'corresponsal';
  monto: number;
  esAbono?: boolean;
  /** Solo `efectivo` (0064): con cuánto pagó el pasajero (>= `monto`). El backend calcula el cambio. */
  efectivoRecibido?: number;
  referencia?: string;
  /** Solo `corresponsal`: la sucursal `sin_sistema` donde se cobró (D8). */
  sucursalCobroId?: string;
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
  /** Categoría de tarifa con que se emitió el boleto (D4). `general` salvo descuento. */
  categoria: CategoriaPasajero;
}

export interface ResultadoVenta {
  ventaId: string;
  estado: 'pendiente' | 'liquidada' | 'finalizada_transferencia';
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
