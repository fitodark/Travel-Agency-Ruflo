/**
 * Cliente de `/paqueteria` (Fases C–G, migr. 0084–0088).
 * docs/architecture/06-lugar-paso-paqueteria.md §1.2
 */
import { api } from './cliente';

export type Modalidad = 'pagado' | 'por_cobrar';
export type EstadoEnvio = 'registrado' | 'en_ruta' | 'en_sucursal' | 'entregado' | 'cancelado';
export type EstadoPagoEnvio = 'pagado' | 'por_confirmar' | 'pendiente';

export interface PagoEnvioInput {
  metodo: 'efectivo' | 'transferencia';
  efectivoRecibido?: number;
  referencia?: string;
}

export interface NuevoEnvio {
  salidaId: string;
  sucursalDestinoId: string;
  remitenteNombre: string;
  remitenteTelefono: string;
  destinatarioNombre: string;
  destinatarioTelefono: string;
  descripcion: string;
  bultos: number;
  importe: number;
  modalidad: Modalidad;
  pago?: PagoEnvioInput;
}

export interface ResultadoEnvio {
  envioId: string;
  folio: string;
  estadoPago: EstadoPagoEnvio;
  pagoEnvioId: string | null;
  printJobs: number;
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
  registradoEn: string;
  registradoPor: string;
  pagoPorConfirmarId: string | null;
}

export interface SalidaParaEnvio {
  salidaId: string;
  ruta: string;
  estado: string;
  horaPaso: string;
  unidad: string | null;
  abierta: boolean;
}

export interface TransferenciaEnvioPorVerificar {
  pagoEnvioId: string;
  envioId: string;
  folio: string;
  descripcion: string;
  monto: number;
  referencia: string | null;
  cobradoPor: string;
  pagadoEn: string;
}

const post = <T>(ruta: string, body?: unknown): Promise<T> =>
  api<T>(ruta, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

export const registrarEnvio = (e: NuevoEnvio) => post<ResultadoEnvio>('/paqueteria', e);

export const salidasParaEnvio = (fecha: string, destinoId: string) =>
  api<SalidaParaEnvio[]>(`/paqueteria/salidas?fecha=${fecha}&destinoId=${destinoId}`);

export const buscarEnvio = (folio: string) =>
  api<Envio>(`/paqueteria/folio?folio=${encodeURIComponent(folio)}`);

export const enviosDestino = (estado: 'por_recibir' | 'por_entregar') =>
  api<Envio[]>(`/paqueteria/destino?estado=${estado}`);

export const enviosDeSalida = (salidaId: string) => api<Envio[]>(`/paqueteria/salida/${salidaId}`);

export type VistaEntregas = 'por_entregar' | 'entregados' | 'todos';

export interface FiltrosEntregas {
  vista?: VistaEntregas;
  entregaDesde?: string;
  entregaHasta?: string;
  remitente?: string;
  destinatario?: string;
  folio?: string;
}

export interface EnvioEntregas extends Envio {
  entregadoEn: string | null;
  entregadoPor: string | null;
}

/** «Por entregar» con historial: pendientes + entregados, paginado. */
export const historialEntregas = (f: FiltrosEntregas & { pagina: number; porPagina: number }) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') qs.set(k, String(v));
  return api<{ filas: EnvioEntregas[]; total: number; pagina: number; porPagina: number }>(
    `/paqueteria/destino/historial?${qs.toString()}`,
  );
};

/** Un solo envío a «en ruta», desde su terminal de origen (0089). */
export const marcarEnvioEnRuta = (envioId: string) =>
  post<{ envioId: string; estado: EstadoEnvio }>(`/paqueteria/${envioId}/en-ruta`);

export const despacharEnvios = (salidaId: string) =>
  post<{ despachados: number }>(`/paqueteria/salida/${salidaId}/despachar`);

export const recibirEnvio = (envioId: string) => post<{ estado: EstadoEnvio }>(`/paqueteria/${envioId}/recibir`);

export const entregarEnvio = (envioId: string, nombreVerificado: boolean, pago?: PagoEnvioInput) =>
  post<{ estado: EstadoEnvio; estadoPago: EstadoPagoEnvio }>(
    `/paqueteria/${envioId}/entregar`, { nombreVerificado, ...(pago ? { pago } : {}) },
  );

export const reimprimirEnvio = (
  envioId: string, que: 'recibo' | 'etiquetas' | 'todo', motivo: string, bulto?: number,
) => post<{ printJobs: number }>(`/paqueteria/${envioId}/reimprimir`, { que, motivo, ...(bulto ? { bulto } : {}) });

export const moverEnvio = (envioId: string, salidaId: string) =>
  post<{ printJobs: number }>(`/paqueteria/${envioId}/mover`, { salidaId });

export const cancelarEnvio = (envioId: string, motivo: string) =>
  post<{ reembolso: number }>(`/paqueteria/${envioId}/cancelar`, { motivo });

export const transferenciasEnvioPorVerificar = () =>
  api<TransferenciaEnvioPorVerificar[]>('/paqueteria/transferencias-por-verificar');

export const confirmarTransferenciaEnvio = (pagoEnvioId: string) =>
  post<{ estadoPago: EstadoPagoEnvio }>(`/paqueteria/pagos/${pagoEnvioId}/verificar`);

export const ESTADO_ENVIO: Record<EstadoEnvio, string> = {
  registrado: 'Registrado',
  en_ruta: 'En ruta',
  en_sucursal: 'En sucursal',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

export const ESTADO_PAGO_ENVIO: Record<EstadoPagoEnvio, string> = {
  pagado: 'Pagado',
  por_confirmar: 'Transferencia por confirmar',
  pendiente: 'Por cobrar',
};
