/**
 * Cliente HTTP de la SPA. Habla solo con la API local, vía el proxy `/api`.
 * El token es opaco (id de sesión): se guarda en memoria y en `sessionStorage`
 * para sobrevivir a un F5.
 */

export class ErrorApi extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorApi';
  }
}

const CLAVE = 'donaji.token';
let enMemoria: string | null = null;

/**
 * Se invoca cuando la API responde `401 no_autorizado` (sesión expirada o
 * revocada). El token ya se limpió antes de llamarlo. `<ProveedorSesion>` lo
 * engancha para borrar la sesión, y `<Protegida>` redirige a `/login`.
 */
let alExpirarSesion: (() => void) | null = null;

export function fijarAlExpirarSesion(fn: (() => void) | null): void {
  alExpirarSesion = fn;
}

export function fijarToken(token: string | null): void {
  enMemoria = token;
  try {
    if (token) sessionStorage.setItem(CLAVE, token);
    else sessionStorage.removeItem(CLAVE);
  } catch {
    /* ventana privada: se queda solo en memoria */
  }
}

export function tokenActual(): string | null {
  if (enMemoria) return enMemoria;
  try {
    enMemoria = sessionStorage.getItem(CLAVE);
  } catch {
    enMemoria = null;
  }
  return enMemoria;
}

export async function api<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  const token = tokenActual();
  const res = await fetch(`/api${ruta}`, {
    ...opciones,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opciones.headers,
    },
  });

  const cuerpo: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = cuerpo as { error?: string; mensaje?: string } | null;
    const codigo = e?.error ?? 'error';
    // Sesión expirada o revocada: la API la rechaza con `401 no_autorizado`.
    // Limpiamos el token y avisamos para volver a `/login`. (El login fallido
    // NO llega acá: responde con `credenciales_invalidas` / `demasiados_intentos`.)
    if (res.status === 401 && codigo === 'no_autorizado') {
      if (token) fijarToken(null);
      alExpirarSesion?.();
    }
    throw new ErrorApi(res.status, codigo, e?.mensaje ?? res.statusText);
  }
  return cuerpo as T;
}
