import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { fijarAlExpirarSesion, fijarToken, tokenActual } from '../api/cliente';
import {
  entrarModoConsulta as apiEntrarModoConsulta,
  login as apiLogin, logout as apiLogout, yo, type SucursalBreve, type Yo,
} from '../api/auth';

interface Sesion {
  usuarioId: string;
  rol: 'administrador' | 'gerente' | 'vendedor';
  sucursalId: string | null;
  sucursalNombre: string | null;
  modoConsulta: boolean;
  sucursales: SucursalBreve[];
  permisos: string[];
}

interface ContextoSesion {
  sesion: Sesion | null;
  cargando: boolean;
  /** `true` si hay usuario pero aún no eligió sucursal Y no está en modo consulta. */
  faltaSucursal: boolean;
  /** `true` si la última sesión se cerró porque la API la rechazó (401). */
  expirada: boolean;
  iniciar: (
    email: string, password: string,
  ) => Promise<{ sesionCompleta: boolean; sucursales: SucursalBreve[] }>;
  refrescar: () => Promise<void>;
  cerrar: () => Promise<void>;
  puede: (permiso: string) => boolean;
  /** Entra (o vuelve) a modo consulta sin sucursal — solo administrador/gerente (0076). */
  entrarModoConsulta: () => Promise<void>;
}

const Ctx = createContext<ContextoSesion | null>(null);

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const [cargando, setCargando] = useState(true);
  const [expirada, setExpirada] = useState(false);

  const aplicar = useCallback((y: Yo) => {
    setSesion({
      usuarioId: y.usuarioId,
      rol: y.rol,
      sucursalId: y.sucursalId,
      sucursalNombre: y.sucursalNombre,
      modoConsulta: y.modoConsulta,
      sucursales: y.sucursales,
      permisos: y.permisos,
    });
  }, []);

  const refrescar = useCallback(async () => {
    if (!tokenActual()) {
      setSesion(null);
      return;
    }
    try {
      aplicar(await yo());
    } catch {
      fijarToken(null);
      setSesion(null);
    }
  }, [aplicar]);

  useEffect(() => {
    void refrescar().finally(() => setCargando(false));
  }, [refrescar]);

  // Cuando cualquier llamada a la API devuelve `401 no_autorizado`, el cliente
  // ya limpió el token: acá borramos la sesión en memoria. `<Protegida>` ve
  // `sesion === null` y redirige a `/login`.
  useEffect(() => {
    fijarAlExpirarSesion(() => {
      setSesion(null);
      setExpirada(true);
    });
    return () => fijarAlExpirarSesion(null);
  }, []);

  const iniciar = useCallback(
    async (email: string, password: string) => {
      const r = await apiLogin(email, password);
      fijarToken(r.token);
      setExpirada(false);
      await refrescar();
      return { sesionCompleta: r.sesionCompleta, sucursales: r.sucursales };
    },
    [refrescar],
  );

  const entrarModoConsulta = useCallback(async () => {
    await apiEntrarModoConsulta();
    await refrescar();
  }, [refrescar]);

  const cerrar = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      /* la sesión se cierra local igual */
    }
    fijarToken(null);
    setSesion(null);
  }, []);

  const valor = useMemo<ContextoSesion>(
    () => ({
      sesion,
      cargando,
      faltaSucursal: sesion !== null && sesion.sucursalId === null && !sesion.modoConsulta,
      expirada,
      iniciar,
      refrescar,
      cerrar,
      puede: (permiso) => sesion?.permisos.includes(permiso) ?? false,
      entrarModoConsulta,
    }),
    [sesion, cargando, expirada, iniciar, refrescar, cerrar, entrarModoConsulta],
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useSesion(): ContextoSesion {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSesion fuera de <ProveedorSesion>');
  return ctx;
}
