/**
 * Piezas compartidas de las pantallas de paquetería (Fase G).
 */
import type { PagoEnvioInput } from '../../api/paqueteria';

export const ETIQUETA = 'mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500';

export const mxn = (n: number): string =>
  n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

export const hoyIso = (): string => new Date().toISOString().slice(0, 10);

export interface EstadoCobro {
  metodo: 'efectivo' | 'transferencia';
  recibido: string;
  referencia: string;
}

export const cobroInicial = (): EstadoCobro => ({ metodo: 'efectivo', recibido: '', referencia: '' });

/** ¿El cobro capturado cubre `monto`? (en efectivo, lo recibido; transferencia no bloquea). */
export function cobroValido(c: EstadoCobro, monto: number): boolean {
  if (c.metodo === 'transferencia') return true;
  if (c.recibido.trim() === '') return true;   // sin "recibe": se cobra exacto
  const r = Number(c.recibido);
  return Number.isFinite(r) && r >= monto;
}

export function aPago(c: EstadoCobro): PagoEnvioInput {
  return {
    metodo: c.metodo,
    ...(c.metodo === 'efectivo' && c.recibido.trim() !== '' ? { efectivoRecibido: Number(c.recibido) } : {}),
    ...(c.metodo === 'transferencia' && c.referencia.trim() ? { referencia: c.referencia.trim() } : {}),
  };
}

/** Método de cobro completo (sin anticipos, P3): efectivo con cambio o transferencia. */
export function CobroEnvio({
  monto, valor, onCambio,
}: { monto: number; valor: EstadoCobro; onCambio: (c: EstadoCobro) => void }) {
  const recibido = valor.recibido.trim() === '' ? null : Number(valor.recibido);
  const cambio = recibido != null && Number.isFinite(recibido) && recibido >= monto ? recibido - monto : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {(['efectivo', 'transferencia'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onCambio({ ...valor, metodo: m })}
            className={`rounded-sm border p-2 text-left text-sm ${
              valor.metodo === m ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700' : 'border-slate-300 bg-white'
            }`}
          >
            {m === 'efectivo' ? 'Efectivo' : 'Transferencia'}
          </button>
        ))}
      </div>
      {valor.metodo === 'efectivo' ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={ETIQUETA}>Recibe (efectivo)</span>
            <input
              type="number" min={monto} step="1" inputMode="decimal"
              value={valor.recibido}
              onChange={(e) => onCambio({ ...valor, recibido: e.target.value })}
              className="campo rounded-sm"
            />
          </label>
          <div>
            <span className={ETIQUETA}>Cambio</span>
            <p className="campo flex items-center rounded-sm bg-slate-50">{cambio != null ? mxn(cambio) : '—'}</p>
          </div>
          {!cobroValido(valor, monto) && (
            <p className="col-span-2 text-xs text-red-600">El efectivo recibido debe cubrir {mxn(monto)}.</p>
          )}
        </div>
      ) : (
        <label className="block">
          <span className={ETIQUETA}>Referencia / folio SPEI</span>
          <input
            value={valor.referencia}
            onChange={(e) => onCambio({ ...valor, referencia: e.target.value })}
            className="campo rounded-sm"
          />
          <span className="mt-1 block text-xs text-slate-500">
            No detiene la operación: queda por confirmar y entra al corte al confirmarse en Caja.
          </span>
        </label>
      )}
    </div>
  );
}
