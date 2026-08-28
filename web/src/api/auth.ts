import { api } from './cliente';

export interface SucursalBreve {
  id: string;
  nombre: string;
}

export interface RespuestaLogin {
  token: string;
  usuarioId: string;
  rol: 'administrador' | 'gerente' | 'vendedor';
  debeCambiar: boolean;
  sesionCompleta: boolean;
  sucursales: SucursalBreve[];
}

export interface Yo {
  usuarioId: string;
  rol: 'administrador' | 'gerente' | 'vendedor';
  sucursalId: string | null;
  permisos: string[];
}

export function login(email: string, password: string): Promise<RespuestaLogin> {
  return api<RespuestaLogin>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function elegirSucursal(sucursalId: string): Promise<{ sucursalId: string }> {
  return api('/auth/sucursal', {
    method: 'POST',
    body: JSON.stringify({ sucursalId }),
  });
}

export function yo(): Promise<Yo> {
  return api<Yo>('/auth/me');
}

export function logout(): Promise<{ ok: true }> {
  return api('/auth/logout', { method: 'POST' });
}
