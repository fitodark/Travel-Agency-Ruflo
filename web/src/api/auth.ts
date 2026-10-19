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
  sucursalNombre: string | null;
  /** `true` si administrador/gerente entró a propósito sin sucursal (0076). */
  modoConsulta: boolean;
  sucursales: SucursalBreve[];
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

export function cambiarSucursal(sucursalId: string): Promise<{ sucursalId: string }> {
  return api('/auth/cambiar-sucursal', {
    method: 'POST',
    body: JSON.stringify({ sucursalId }),
  });
}

/** Entra (o vuelve) a modo consulta: administrador/gerente sin sucursal activa (0076). */
export function entrarModoConsulta(): Promise<{ ok: true }> {
  return api('/auth/modo-consulta', { method: 'POST' });
}

export function yo(): Promise<Yo> {
  return api<Yo>('/auth/me');
}

export function logout(): Promise<{ ok: true }> {
  return api('/auth/logout', { method: 'POST' });
}
