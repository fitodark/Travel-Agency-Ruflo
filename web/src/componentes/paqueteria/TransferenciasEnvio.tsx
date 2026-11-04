/**
 * Cola del encargado para paquetería (P4): transferencias de envíos cobradas
 * en esta sucursal que falta confirmar. Va en Caja, junto a la de boletos: al
 * confirmar, el monto entra al corte abierto en ese momento.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirmarTransferenciaEnvio, transferenciasEnvioPorVerificar } from '../../api/paqueteria';
import { fechaHora } from '../../lib/fechas';
import { mxn } from './comun';

export function TransferenciasEnvio({
  hayCorte, onCambio, onError,
}: { hayCorte: boolean; onCambio: () => void; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['paqueteria', 'transferencias'],
    queryFn: transferenciasEnvioPorVerificar,
  });
  const confirmar = useMutation({
    mutationFn: (pagoEnvioId: string) => confirmarTransferenciaEnvio(pagoEnvioId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['paqueteria'] }); onCambio(); },
    onError,
  });

  if (!q.data || q.data.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-600">
        Transferencias de paquetería por verificar ({q.data.length})
      </h2>
      {!hayCorte && (
        <p className="text-xs text-amber-700">Abre el corte de caja para poder confirmar.</p>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Cobrada</th>
              <th className="px-4 py-2.5">Envío</th>
              <th className="px-4 py-2.5">Cobró</th>
              <th className="px-4 py-2.5">Referencia</th>
              <th className="px-3 py-2 text-right">Monto</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {q.data.map((t) => (
              <tr key={t.pagoEnvioId} className="border-t border-slate-100">
                <td className="px-4 py-3 whitespace-nowrap">{fechaHora(t.pagadoEn)}</td>
                <td className="px-4 py-3"><span className="font-mono">{t.folio}</span> · {t.descripcion}</td>
                <td className="px-4 py-3">{t.cobradoPor}</td>
                <td className="px-4 py-3">{t.referencia ?? '—'}</td>
                <td className="px-3 py-3 text-right">{mxn(t.monto)}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    className="btn-primario px-3 py-1 text-xs"
                    disabled={!hayCorte || confirmar.isPending}
                    onClick={() => confirmar.mutate(t.pagoEnvioId)}
                  >
                    Confirmar pago
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
