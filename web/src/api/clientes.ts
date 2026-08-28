import { api } from './cliente';

export interface Cliente {
  id: string;
  nombre: string;
  telefono: string | null;
  email: string | null;
  sucursalRegistroId: string | null;
  creadoEn: string;
  modificadoEn: string;
}

export interface NuevoCliente {
  nombre: string;
  telefono?: string;
  email?: string;
}

export function listarClientes(busqueda?: string): Promise<Cliente[]> {
  const q = busqueda ? `?q=${encodeURIComponent(busqueda)}` : '';
  return api<Cliente[]>(`/clientes${q}`);
}

export function crearCliente(datos: NuevoCliente): Promise<Cliente> {
  return api<Cliente>('/clientes', {
    method: 'POST',
    body: JSON.stringify(datos),
  });
}

export function actualizarCliente(id: string, datos: Partial<NuevoCliente>): Promise<Cliente> {
  return api<Cliente>(`/clientes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(datos),
  });
}

export function bajaCliente(id: string): Promise<null> {
  return api<null>(`/clientes/${id}`, { method: 'DELETE' });
}
