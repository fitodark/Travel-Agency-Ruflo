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
    <div className="h-full flex items-center justify-center">
      <div className="w-80 bg-white rounded-lg shadow p-6 space-y-3">
        <h1 className="text-lg font-semibold">Elige tu sucursal</h1>
        {sucursales.length === 0 && (
          <p className="text-sm text-slate-500">
            No se recibió la lista de sucursales. Vuelve a{' '}
            <button className="underline" onClick={() => navigate('/login')}>
              iniciar sesión
            </button>
            .
          </p>
        )}
        {sucursales.map((s) => (
          <button
            key={s.id}
            onClick={() => void elegir(s.id)}
            disabled={eligiendo !== null}
            className="w-full text-left rounded border px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {s.nombre}
          </button>
        ))}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
