import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import { bajaTarifa, crearTarifa, listarRutas, listarTarifas } from '../../api/admin';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo completar la operación.');
const fecha = (s: string | null) => (s ? new Date(s).toLocaleDateString('es-MX') : '—');
const mxn = (n: string) => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

export function AdminTarifas() {
  const qc = useQueryClient();
  const rutas = useQuery({ queryKey: ['admin', 'rutas'], queryFn: listarRutas });
  const tarifas = useQuery({ queryKey: ['admin', 'tarifas'], queryFn: listarTarifas });
  const refrescar = () => qc.invalidateQueries({ queryKey: ['admin', 'tarifas'] });
  const [error, setError] = useState<string | null>(null);

  const [rutaId, setRutaId] = useState('');
  const [origen, setOrigen] = useState('0');
  const [destino, setDestino] = useState('');
  const [importe, setImporte] = useState('');
  const [modo, setModo] = useState<'ventana' | 'programado'>('ventana');
  const [fechaProg, setFechaProg] = useState('');

  const ruta = useMemo(() => rutas.data?.find((r) => r.id === rutaId), [rutas.data, rutaId]);
  const paradas = ruta?.paradas ?? [];

  const m = useMutation({
    mutationFn: () => crearTarifa({
      rutaId, paradaOrigenOrden: Number(origen), paradaDestinoOrden: Number(destino), importe: Number(importe),
      modo, ...(modo === 'programado' && fechaProg ? { fechaProgramada: new Date(fechaProg).toISOString() } : {}),
    }),
    onSuccess: () => { setImporte(''); setError(null); void refrescar(); },
    onError: (e) => setError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        Un precio por tramo. Nunca inmediato (§3.4): entra por la ventana nocturna o programado.
        El precio nuevo cierra el anterior del mismo tramo.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <details className="rounded border bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium">+ Nueva tarifa</summary>
        <form onSubmit={enviar} className="mt-3 grid gap-3 sm:grid-cols-2 text-sm">
          <label>Ruta
            <select value={rutaId} onChange={(e) => { setRutaId(e.target.value); setOrigen('0'); setDestino(''); }} className="mt-1 w-full rounded border px-2 py-1">
              <option value="">— elige —</option>
              {rutas.data?.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}
            </select>
          </label>
          <div />
          <label>Desde
            <select value={origen} onChange={(e) => setOrigen(e.target.value)} className="mt-1 w-full rounded border px-2 py-1">
              {paradas.map((p) => <option key={p.orden} value={p.orden}>{p.orden} · {p.sucursal}</option>)}
            </select>
          </label>
          <label>Hasta
            <select value={destino} onChange={(e) => setDestino(e.target.value)} className="mt-1 w-full rounded border px-2 py-1">
              <option value="">— elige —</option>
              {paradas.map((p) => <option key={p.orden} value={p.orden}>{p.orden} · {p.sucursal}</option>)}
            </select>
          </label>
          <label>Importe<input type="number" step="0.01" min="0" required value={importe} onChange={(e) => setImporte(e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /></label>
          <label>Cuándo
            <select value={modo} onChange={(e) => setModo(e.target.value as 'ventana' | 'programado')} className="mt-1 w-full rounded border px-2 py-1">
              <option value="ventana">Ventana nocturna (03:00)</option>
              <option value="programado">Programado</option>
            </select>
          </label>
          {modo === 'programado' && (
            <label>Fecha<input type="datetime-local" value={fechaProg} onChange={(e) => setFechaProg(e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /></label>
          )}
          <button type="submit" disabled={m.isPending || !rutaId || !destino} className="rounded bg-slate-900 text-white px-4 py-1.5 disabled:opacity-50 justify-self-start">
            {m.isPending ? 'Creando…' : 'Crear'}
          </button>
        </form>
      </details>

      <div className="overflow-x-auto">
        <table className="w-full text-sm bg-white rounded border">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Ruta</th><th className="px-3 py-2">Tramo</th>
              <th className="px-3 py-2">Importe</th><th className="px-3 py-2">Vigencia</th>
              <th className="px-3 py-2">Estado</th><th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {tarifas.data?.map((t) => {
              const vigente = t.activo && !t.effective_until;
              return (
                <tr key={t.id} className="border-t">
                  <td className="px-3 py-2">{t.ruta_nombre}</td>
                  <td className="px-3 py-2">{t.parada_origen_orden} → {t.parada_destino_orden}</td>
                  <td className="px-3 py-2">{mxn(t.importe)}</td>
                  <td className="px-3 py-2 text-slate-500">{fecha(t.effective_from)}{t.effective_until ? ` → ${fecha(t.effective_until)}` : ''}</td>
                  <td className="px-3 py-2">
                    {vigente
                      ? <span className="rounded bg-green-100 text-green-700 px-2 py-0.5 text-xs">vigente</span>
                      : <span className="rounded bg-slate-200 text-slate-600 px-2 py-0.5 text-xs">cerrada</span>}
                  </td>
                  <td className="px-3 py-2">
                    {vigente && (
                      <button
                        className="underline text-slate-700"
                        onClick={() => {
                          if (window.confirm('¿Retirar el precio de este tramo? Entra por la ventana nocturna.')) {
                            bajaTarifa(t.id, { modo: 'ventana' }).then(() => void refrescar()).catch((e) => setError(msg(e)));
                          }
                        }}
                      >
                        retirar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {tarifas.data?.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin tarifas.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
