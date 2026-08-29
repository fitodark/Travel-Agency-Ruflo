import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { elegirSucursal, type SucursalBreve } from '../api/auth';
import { tokenActual } from '../api/cliente';
import { useSesion } from '../auth/sesion';

/**
 * Segundo paso del login: el usuario con más de una sucursal elige en cuál abre
 * turno. La lista viene del login y se guarda en `sessionStorage` para
 * sobrevivir a un F5 en esta pantalla.
 */
export function ElegirSucursal() {
  const { sesion, refrescar } = useSesion();
  const navigate = useNavigate();
  const [sucursales, setSucursales] = useState<SucursalBreve[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [eligiendo, setEligiendo] = useState<string | null>(null);

  useEffect(() => {
    // Si ya hay sucursal, no hay nada que elegir.
    if (sesion?.sucursalId) {
      navigate('/', { replace: true });
      return;
    }
    // La lista viene del login; si se recargó la página se re-consulta.
    const cache = sessionStorage.getItem('donaji.sucursales');
    if (cache) {
      setSucursales(JSON.parse(cache) as SucursalBreve[]);
    }
  }, [sesion, navigate]);

  const elegir = async (id: string) => {
    setError(null);
    setEligiendo(id);
    try {
      await elegirSucursal(id);
      sessionStorage.removeItem('donaji.sucursales');
      await refrescar();
      navigate('/', { replace: true });
    } catch {
      setError('No se pudo elegir la sucursal.');
    } finally {
      setEligiendo(null);
    }
  };

  if (!tokenActual()) {
    navigate('/login', { replace: true });
    return null;
  }

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-lienzo via-lienzo to-brand-50 p-6">
      <div className="tarjeta w-[22rem] space-y-3 p-6 shadow-panel">
        <h1 className="text-base font-semibold tracking-tight">Elige tu sucursal</h1>
        <p className="text-xs text-slate-500">Vas a operar la terminal como esta sucursal.</p>
        {sucursales.length === 0 && (
          <p className="text-sm text-slate-500">
            No se recibió la lista de sucursales. Vuelve a{' '}
            <button className="text-brand-700 underline" onClick={() => navigate('/login')}>
              iniciar sesión
            </button>
            .
          </p>
        )}
        <div className="space-y-2 pt-1">
          {sucursales.map((s) => (
            <button
              key={s.id}
              onClick={() => void elegir(s.id)}
              disabled={eligiendo !== null}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3.5 py-2.5 text-left text-sm transition hover:border-brand-300 hover:bg-brand-50/50 disabled:opacity-50"
            >
              <span className="font-medium text-slate-700">{s.nombre}</span>
              <span className="text-brand-500">→</span>
            </button>
          ))}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
