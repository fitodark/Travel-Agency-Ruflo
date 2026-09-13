import type { ReactNode } from 'react';
import type { SalidaDisponible } from '../../api/ventas';
import { fechaHora, hora } from '../../lib/fechas';
import { formatoAsiento } from '../../lib/asientos';

/**
 * Panel lateral persistente de los pasos 3-6 de Vender: datos del viaje, conteo
 * de pasajeros/asientos y el total — con las acciones del paso (`children`) al
 * pie, para no repetir esta caja en cada paso.
 */
export function ResumenViaje({
  salida,
  personas,
  asientos,
  total,
  totalLabel = 'Total',
  precioUnitario,
  precioUnitarioLabel = 'Precio unitario',
  aviso,
  children,
}: {
  salida: SalidaDisponible;
  personas: number;
  asientos: number[];
  total: number;
  totalLabel?: string;
  /** Tarifa por pasajero; se omite la fila si no hay una tarifa que mostrar (`null`). */
  precioUnitario?: number | null;
  /** P. ej. "Precio unitario × General". */
  precioUnitarioLabel?: string;
  aviso?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <aside className="tarjeta space-y-3 p-4 text-sm lg:sticky lg:top-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Viaje de ida</p>
        <p className="font-semibold text-slate-800">{fechaHora(salida.horaSalidaOrigen)}</p>
      </div>
      <div className="space-y-1 text-slate-600">
        <p><span className="text-slate-400">Origen:</span> {salida.origenNombre}</p>
        <p><span className="text-slate-400">Destino:</span> {salida.destinoNombre}</p>
        <p className="text-xs text-slate-400">
          {salida.unidadNombre}
          {salida.horaLlegadaDestino ? ` · llega ${hora(salida.horaLlegadaDestino)} h` : ''}
        </p>
      </div>
      <div className="space-y-1 border-t pt-3 text-slate-600">
        {precioUnitario != null && (
          <div className="flex justify-between">
            <span>{precioUnitarioLabel}</span>
            <span className="font-medium text-slate-800">${precioUnitario}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span>Pasajeros</span>
          <span className="font-medium text-slate-800">{personas}</span>
        </div>
        <div className="flex justify-between">
          <span>Asientos</span>
          <span className="font-medium text-slate-800">
            {asientos.length > 0
              ? [...asientos].sort((a, b) => a - b).map(formatoAsiento).join(' - ')
              : 'por asignar'}
          </span>
        </div>
      </div>
      {aviso && <p className="border-t pt-3 text-xs text-slate-500">{aviso}</p>}
      <div className="flex justify-between border-t pt-3 text-base font-semibold text-slate-900">
        <span>{totalLabel}</span>
        <span>${total}</span>
      </div>
      {children && <div className="space-y-2 pt-1">{children}</div>}
    </aside>
  );
}
