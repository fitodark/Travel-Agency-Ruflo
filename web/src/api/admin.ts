/**
 * Cliente de la sección de administración (`/admin/*` de la API de la terminal).
 *
 * Estas rutas escriben en la NUBE con la sesión local del administrador. Si la
 * nube no está disponible responden 503: la UI muestra la sección en solo-lectura.
 */

import { api } from './cliente';

export type ModoPropagacion = 'ventana' | 'inmediato' | 'programado';

export interface Propagacion {
  modo: ModoPropagacion;
  confirmarInmediato?: boolean;
  fechaProgramada?: string;
}

export interface SaludAdmin {
  disponible: boolean;
}

export function saludAdmin(): Promise<SaludAdmin> {
  return api<SaludAdmin>('/admin/salud');
}

// ---- sucursales -----------------------------------------------------------

export interface SucursalAdmin {
  id: string;
  codigo: string;
  nombre: string;
  direccionCompleta: string | null;
  telefonoPrincipal: string | null;
  zonaHoraria: string;
  activo: boolean;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  tieneHotp: boolean;
}

export const listarSucursales = (): Promise<SucursalAdmin[]> => api('/admin/sucursales');

export const crearSucursal = (
  d: { nombre: string; direccionCompleta: string; telefonoPrincipal: string; zonaHoraria?: string; codigo?: string } & Propagacion,
): Promise<{ codigo: string }> =>
  api('/admin/sucursales', { method: 'POST', body: JSON.stringify(d) });

export const editarSucursal = (
  id: string,
  d: Partial<{ nombre: string; direccionCompleta: string; telefonoPrincipal: string; zonaHoraria: string }> & Propagacion,
): Promise<unknown> => api(`/admin/sucursales/${id}`, { method: 'PATCH', body: JSON.stringify(d) });

export const bajaSucursal = (id: string): Promise<unknown> =>
  api(`/admin/sucursales/${id}/baja`, { method: 'POST', body: JSON.stringify({ modo: 'inmediato', confirmarInmediato: true }) });

export const regenerarHotp = (id: string): Promise<unknown> =>
  api(`/admin/sucursales/${id}/regenerar-hotp`, { method: 'POST', body: '{}' });

// ---- usuarios ------------------------------------------------------------

export interface UsuarioAdmin {
  id: string;
  nombre: string;
  email: string;
  rol: 'administrador' | 'gerente' | 'vendedor';
  telefono: string | null;
  activo: boolean;
  tieneCredencial: boolean;
  debeCambiarPassword: boolean;
  sucursales: { id: string; codigo: string; nombre: string; activa: boolean }[];
}

export const listarUsuarios = (): Promise<UsuarioAdmin[]> => api('/admin/usuarios');

export const crearUsuario = (
  d: { nombre: string; email: string; rol: string; telefono?: string; sucursalIds?: string[] } & Propagacion,
): Promise<{ passwordTemporal: string }> =>
  api('/admin/usuarios', { method: 'POST', body: JSON.stringify(d) });

export const editarUsuario = (
  id: string,
  d: Partial<{ nombre: string; rol: string; telefono: string | null }> & Propagacion,
): Promise<unknown> => api(`/admin/usuarios/${id}`, { method: 'PATCH', body: JSON.stringify(d) });

export const bajaUsuario = (id: string): Promise<unknown> =>
  api(`/admin/usuarios/${id}/baja`, { method: 'POST', body: '{}' });

export const asignarSucursal = (id: string, sucursalId: string): Promise<unknown> =>
  api(`/admin/usuarios/${id}/sucursales`, {
    method: 'POST', body: JSON.stringify({ sucursalId, modo: 'inmediato', confirmarInmediato: true }),
  });

export const quitarSucursal = (id: string, sucursalId: string): Promise<unknown> =>
  api(`/admin/usuarios/${id}/sucursales/${sucursalId}`, { method: 'DELETE', body: '{}' });

export const restablecerPassword = (id: string): Promise<{ passwordTemporal: string }> =>
  api(`/admin/usuarios/${id}/restablecer-password`, { method: 'POST', body: '{}' });

export const codigoRevocacion = (id: string, sucursalId: string): Promise<{ codigo: string }> =>
  api(`/admin/usuarios/${id}/codigo-revocacion`, { method: 'POST', body: JSON.stringify({ sucursalId }) });

// ---- impresoras --------------------------------------------------------

export interface ImpresoraAdmin {
  sucursal_nombre: string;
  nombre: string;
  transporte: 'tcp' | 'usb';
  ip: string | null;
  puerto: number | null;
  usb_nombre_cola: string | null;
  ancho_cols: number;
  code_page: string;
  soporta_qr_nativo: boolean;
  es_predeterminada: boolean;
}

export const listarImpresoras = (): Promise<ImpresoraAdmin[]> => api('/admin/impresoras');

export const configurarImpresora = (d: {
  sucursalId: string; nombre: string; transporte: 'tcp' | 'usb';
  ip?: string; puerto?: number; usbNombreCola?: string;
  anchoCols?: number; codePage?: string; esPredeterminada?: boolean;
}): Promise<unknown> => api('/admin/impresoras', { method: 'POST', body: JSON.stringify(d) });

// ---- ticket ----------------------------------------------------------

export interface TicketVigente {
  leyenda_pie?: string | null;
  telefono_atencion?: string | null;
  credenciales_proveedor?: string | null;
  logo_url?: string | null;
  hmac_qr_secreto?: string | null;
  effective_from?: string | null;
}

export const ticketVigente = (): Promise<TicketVigente> => api('/admin/ticket');

export const guardarTicket = (
  d: Partial<{ leyendaPie: string; telefonoAtencion: string; credencialesProveedor: string; logoUrl: string | null; hmacQrSecreto: string | null }> & Partial<Propagacion>,
): Promise<unknown> => api('/admin/ticket', { method: 'POST', body: JSON.stringify(d) });

// ---- tarifas -------------------------------------------------------

export interface RutaAdmin {
  id: string;
  nombre: string;
  paradas: { orden: number; sucursal: string }[];
}

export interface TarifaAdmin {
  id: string;
  ruta_nombre: string;
  parada_origen_orden: number;
  parada_destino_orden: number;
  importe: string;
  effective_from: string | null;
  effective_until: string | null;
  activo: boolean;
}

export const listarRutas = (): Promise<RutaAdmin[]> => api('/admin/rutas');
export const listarTarifas = (): Promise<TarifaAdmin[]> => api('/admin/tarifas');

export const crearTarifa = (
  d: { rutaId: string; paradaOrigenOrden: number; paradaDestinoOrden: number; importe: number } & { modo?: 'ventana' | 'programado'; fechaProgramada?: string },
): Promise<unknown> => api('/admin/tarifas', { method: 'POST', body: JSON.stringify(d) });

export const bajaTarifa = (id: string, modo: { modo?: 'ventana' | 'programado'; fechaProgramada?: string }): Promise<unknown> =>
  api(`/admin/tarifas/${id}/baja`, { method: 'POST', body: JSON.stringify(modo) });
