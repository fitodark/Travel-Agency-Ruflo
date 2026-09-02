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
