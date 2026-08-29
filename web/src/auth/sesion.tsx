import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { fijarToken, tokenActual } from '../api/cliente';
import {
  login as apiLogin, logout as apiLogout, yo, type SucursalBreve, type Yo,
} from '../api/auth';

interface Sesion {
  usuarioId: string;
  rol: 'administrador' | 'gerente' | 'vendedor';
  sucursalId: string | null;
  sucursalNombre: string | null;
  sucursales: SucursalBreve[];
  permisos: string[];
}

interface ContextoSesion {
  sesion: Sesion | null;
  cargando: boolean;
  /** `true` si hay usuario pero aún no eligió sucursal. */
  faltaSucursal: boolean;
  iniciar: (
    email: string, password: string,
  ) => Promise<{ sesionCompleta: boolean; sucursales: SucursalBreve[] }>;
  refrescar: () => Promise<void>;
  cerrar: () => Promise<void>;
  puede: (permiso: string) => boolean;
}

const Ctx = createContext<ContextoSesion | null>(null);

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const [cargando, setCargando] = useState(true);

  const aplicar = useCallback((y: Yo) => {
    setSesion({
      usuarioId: y.usuarioId,
      rol: y.rol,
      sucursalId: y.sucursalId,
      sucursalNombre: y.sucursalNombre,
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

  const iniciar = useCallback(
    async (email: string, password: string) => {
      const r = await apiLogin(email, password);
      fijarToken(r.token);
      await refrescar();
      return { sesionCompleta: r.sesionCompleta, sucursales: r.sucursales };
    },
    [refrescar],
  );

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
      faltaSucursal: sesion !== null && sesion.sucursalId === null,
      iniciar,
      refrescar,
      cerrar,
      puede: (permiso) => sesion?.permisos.includes(permiso) ?? false,
    }),
    [sesion, cargando, iniciar, refrescar, cerrar],
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useSesion(): ContextoSesion {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSesion fuera de <ProveedorSesion>');
  return ctx;
}
