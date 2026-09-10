import { api } from './cliente';

export interface SalidaDelDia {
  salidaId: string;
  horarioId: string;
  estado: string;
  horaSalida: string;
  origen: string;
  destino: string;
  conductor: string | null;
  boletos: number;
}

export type EstadoAbordaje = 'abordo' | 'no_presento' | 'pendiente';

export interface FilaChecklist {
  boletoId: string;
  folio: string;
  asientoNum: number;
  pasajeroNombre: string;
  tramos: string;
  conflicto: boolean;
  estadoAbordaje: EstadoAbordaje;
  capturadoEn: string | null;
}

export interface BoletoPorFolio extends FilaChecklist {
  salida: {
    salidaId: string;
    fechaOperacion: string;
    horaSalida: string;
    origen: string;
    destino: string;
    estado: string;
    conductor: string | null;
  };
}

export interface DetalleBoleto {
  boletoId: string;
  folio: string;
  pasajeroNombre: string;
  asientoNum: number;
  tramos: string;
  estado: string;
  conflicto: boolean;
  importe: number;
  impresoEn: string | null;
  vendidoEn: string;
  venta: {
    ventaId: string;
    esReservacion: boolean;
    importeTotal: number;
    boletosEnLaVenta: number;
    contactoTelefono: string;
    clienteNombre: string | null;
  };
  vendedor: { nombre: string; rol: string };
  sucursalVenta: string;
  ruta: { origen: string; destino: string; origenHora: string; destinoHora: string };
  salida: {
    salidaId: string;
    fechaOperacion: string;
    estado: string;
    conductor: string | null;
  };
}

export interface EstadoViaje {
  salidaId: string;
  estado: string;
  salidaRealEn?: string;
}

export interface ManifiestosEncolados {
  conductor: { printJobId: string; pasajeros: number };
  terminal: { printJobId: string; pasajeros: number };
}

export function salidasDelDia(fecha: string): Promise<SalidaDelDia[]> {
  return api<SalidaDelDia[]>(`/viajes?fecha=${encodeURIComponent(fecha)}`);
}

export function checklist(salidaId: string): Promise<FilaChecklist[]> {
  return api<FilaChecklist[]>(`/viajes/${salidaId}/checklist`);
}

/** Busca un boleto por su folio (string). Lanza `ErrorApi` 404 si no existe. */
export function buscarBoletoPorFolio(folio: string): Promise<BoletoPorFolio> {
  return api<BoletoPorFolio>(`/viajes/boleto?folio=${encodeURIComponent(folio)}`);
}

/** Detalle completo de un boleto vendido (vendedor, sucursal, fecha, costo, tramo). */
export function detalleBoleto(boletoId: string): Promise<DetalleBoleto> {
  return api<DetalleBoleto>(`/viajes/boleto/${encodeURIComponent(boletoId)}/detalle`);
}

export interface VeredictoQr {
  firma: 'valida' | 'invalida' | 'sin_firma' | 'sin_secreto';
  motivo: string | null;
  campos: Record<string, string>;
  boleto: {
    boletoId: string;
    folio: string;
    pasajeroNombre: string;
    asientoNum: number;
    tramos: string;
    estado: string;
    origen: string;
    destino: string;
    salida: { salidaId: string; fechaOperacion: string; estado: string; esHoy: boolean };
    estadoAbordaje: EstadoAbordaje;
    conflicto: boolean;
  } | null;
  coincide: boolean;
  veredicto: 'ok' | 'revisar' | 'rechazar';
  nota: string;
}

/**
 * Verifica un boleto escaneado (texto del QR): valida el HMAC contra el secreto
 * de la agencia y cruza el folio con la base local. Todo offline.
 */
export function verificarBoletoQr(qr: string): Promise<VeredictoQr> {
  return api<VeredictoQr>('/viajes/boleto/verificar', {
    method: 'POST', body: JSON.stringify({ qr }),
  });
}

export interface ResultadoReimpresion {
  printJobId: string;
  reimpresiones: number;
}

/** Reimprime un boleto liquidado: encola un `print_job` con la leyenda de reimpresión. */
export function reimprimirBoleto(
  boletoId: string, motivo?: string,
): Promise<ResultadoReimpresion> {
  return api<ResultadoReimpresion>(
    `/viajes/boleto/${encodeURIComponent(boletoId)}/reimprimir`,
    { method: 'POST', body: JSON.stringify(motivo ? { motivo } : {}) },
  );
}

export interface ResultadoCancelacion {
  ventaId: string;
  ventaCancelada: boolean;
  reembolsoId: string | null;
  reembolsoMonto: number | null;
  /** Sucursal donde se hace el reembolso a mano (pago corresponsal). */
  reembolsoPendienteEn: string | null;
}

/**
 * Cancela un boleto / reserva (D9): libera el asiento y reembolsa el pago
 * confirmado en el corte abierto. Hasta 1 h antes de la salida.
 */
export function cancelarBoleto(
  boletoId: string, motivo?: string,
): Promise<ResultadoCancelacion> {
  return api<ResultadoCancelacion>(
    `/viajes/boleto/${encodeURIComponent(boletoId)}/cancelar`,
    { method: 'POST', body: JSON.stringify(motivo ? { motivo } : {}) },
  );
}

export interface ResultadoReubicar {
  boletoNuevoId: string;
  folioNuevo: string;
  ventaNuevaId: string;
  importe: number;
  /** true = se mantuvo el precio que el pasajero ya había pagado (N-14). */
  precioMantenido: boolean;
  saldoPendiente: number;
  printJobs: number;
}

/**
 * Reubica un boleto huérfano (D12/N-14) en una salida de la ruta nueva: cancela
 * el viejo y reemite. Si ya pagó, mantiene el precio; si no, cobra la tarifa
 * vigente de la ruta nueva.
 */
export function reubicarBoleto(
  boletoId: string,
  d: { salidaNuevaId: string; origenOrden: number; destinoOrden: number; asientoNum: number },
): Promise<ResultadoReubicar> {
  return api<ResultadoReubicar>(
    `/viajes/boleto/${encodeURIComponent(boletoId)}/reubicar`,
    { method: 'POST', body: JSON.stringify(d) },
  );
}

export interface BoletoReubicable {
  boletoId: string;
  folio: string;
  pasajeroNombre: string;
  asientoNum: number;
}

/** Boletos vivos de una venta huérfana, para reubicarla completa (familia multi-boleto). */
export function boletosReubicables(ventaId: string): Promise<BoletoReubicable[]> {
  return api<BoletoReubicable[]>(`/viajes/venta/${encodeURIComponent(ventaId)}/reubicables`);
}

export interface ResultadoReubicarVenta {
  ventaNuevaId: string;
  importeTotal: number;
  pagado: number;
  saldoPendiente: number;
  precioMantenido: boolean;
  boletos: Array<{ boletoId: string; folio: string; asientoNum: number; pasajero: string; importe: number }>;
  printJobs: number;
}

/**
 * Reubica una venta huérfana completa (D12/N-14, F6-D2): una venta nueva con todos
 * los boletos. Todos viajan el tramo elegido en la salida nueva; si ya pagaron, se
 * mantiene el precio.
 */
export function reubicarVentaHuerfana(
  ventaId: string,
  d: {
    salidaNuevaId: string; origenOrden: number; destinoOrden: number;
    asientos: Array<{ boletoViejoId: string; asientoNum: number }>;
  },
): Promise<ResultadoReubicarVenta> {
  return api<ResultadoReubicarVenta>(
    `/viajes/venta/${encodeURIComponent(ventaId)}/reubicar`,
    { method: 'POST', body: JSON.stringify(d) },
  );
}

export function registrarAbordaje(
  boletoId: string, abordo: boolean,
): Promise<{ eventoId: string }> {
  return api('/viajes/abordaje', {
    method: 'POST',
    body: JSON.stringify({ boletoId, abordo }),
  });
}

export function generarManifiestos(salidaId: string): Promise<ManifiestosEncolados> {
  return api<ManifiestosEncolados>(`/viajes/${salidaId}/manifiestos`, { method: 'POST' });
}

export function marcarEnRuta(salidaId: string): Promise<EstadoViaje> {
  return api<EstadoViaje>(`/viajes/${salidaId}/en-ruta`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function finalizarViaje(salidaId: string): Promise<EstadoViaje> {
  return api<EstadoViaje>(`/viajes/${salidaId}/finalizar`, { method: 'POST' });
}
