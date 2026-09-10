import { api } from './cliente';

export interface Sucursal {
  id: string;
  nombre: string;
  codigo: string;
  telefonoPrincipal: string | null;
  direccionCompleta: string | null;
  zonaHoraria: string;
  /** D13: sucursal sin sistema — solo cobra pagos `corresponsal`. */
  sinSistema: boolean;
}

export function listarSucursales(): Promise<Sucursal[]> {
  return api<Sucursal[]>('/catalogos/sucursales');
}

export interface PuntoRuta {
  id: string;
  nombre: string;
  tipo: 'terminal' | 'parada';
  municipio: string | null;
  referencia: string | null;
  /** Sucursal a la que representa este punto terminal; `null` para una parada. */
  sucursalId: string | null;
  /** Hay al menos una ruta activa donde este punto permite ascenso. */
  puedeOriginar: boolean;
}

export function listarPuntos(): Promise<PuntoRuta[]> {
  return api<PuntoRuta[]>('/catalogos/puntos');
}

export function parametros(): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>('/catalogos/parametros');
}
