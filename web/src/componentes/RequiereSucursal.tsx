import { useState } from 'react';
import { elegirSucursal } from '../api/auth';
import { useSesion } from '../auth/sesion';

/**
 * Pantallas 100% operativas (vender, caja, viajes, clientes, verificar,
 * sync): en modo consulta (0076) no se puede entrar sin elegir antes una
 * sucursal real. A diferencia de redirigir a `/elegir-sucursal`, esto NO
 * navega a otra página — muestra un diálogo encima para elegir, y al
 * resolver la sesión ya queda operando ahí.
 */
export function RequiereSucursal({ children }: { children: React.ReactNode }) {
  const { sesion, refrescar } = useSesion();
  const [eligiendo, setEligiendo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!sesion || sesion.sucursalId) return <>{children}</>;

  const elegir = async (id: string) => {
    setError(null);
    setEligiendo(id);
    try {
      await elegirSucursal(id);
      await refrescar();
    } catch {
      setError('No se pudo elegir la sucursal.');
    } finally {
      setEligiendo(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6">
      <div className="tarjeta w-[22rem] space-y-3 p-6 shadow-panel">
        <h2 className="text-base font-semibold tracking-tight">Elige una sucursal para continuar</h2>
        <p className="text-xs text-slate-500">
          Estás en modo consulta. Esta sección necesita que elijas desde cuál vas a operar.
        </p>
        <div className="space-y-2 pt-1">
          {sesion.sucursales.map((s) => (
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
