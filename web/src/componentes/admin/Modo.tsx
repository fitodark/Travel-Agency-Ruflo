import { useState } from 'react';
import type { Propagacion } from '../../api/admin';

/**
 * Selector de "cuándo" surte efecto un cambio de configuración (03 §3.2):
 * ventana nocturna (03:00), inmediato (con confirmación explícita) o programado.
 */
export function useModo(opts: { soloDiferido?: boolean } = {}) {
  const [modo, setModo] = useState<Propagacion['modo']>('ventana');
  const [confirmar, setConfirmar] = useState(false);
  const [fecha, setFecha] = useState('');

  const valor = (): Propagacion => ({
    modo,
    ...(modo === 'inmediato' ? { confirmarInmediato: confirmar } : {}),
    ...(modo === 'programado' && fecha ? { fechaProgramada: new Date(fecha).toISOString() } : {}),
  });

  const nodo = (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label>
        Cuándo
        <select
          value={modo}
          onChange={(e) => setModo(e.target.value as Propagacion['modo'])}
          className="mt-1 block rounded border px-2 py-1"
        >
          <option value="ventana">Ventana nocturna (03:00)</option>
          {!opts.soloDiferido && <option value="inmediato">Inmediato</option>}
          <option value="programado">Programado</option>
        </select>
      </label>
      {modo === 'programado' && (
        <label>
          Fecha
          <input
            type="datetime-local"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="mt-1 block rounded border px-2 py-1"
          />
        </label>
      )}
      {modo === 'inmediato' && !opts.soloDiferido && (
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={confirmar} onChange={(e) => setConfirmar(e.target.checked)} />
          confirmo el cambio inmediato
        </label>
      )}
    </div>
  );

  return { valor, nodo };
}
