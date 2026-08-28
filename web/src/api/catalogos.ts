import { api } from './cliente';

export interface Sucursal {
  id: string;
  nombre: string;
  codigo: string;
  telefonoPrincipal: string | null;
  direccionCompleta: string | null;
  zonaHoraria: string;
}

export function listarSucursales(): Promise<Sucursal[]> {
  return api<Sucursal[]>('/catalogos/sucursales');
}

export function parametros(): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>('/catalogos/parametros');
}
