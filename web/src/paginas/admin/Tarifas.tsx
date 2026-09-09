import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import { bajaTarifa, crearTarifa, listarRutas, listarTarifas, type CategoriaPasajero } from '../../api/admin';

const CATEGORIA_ETIQUETA: Record<CategoriaPasajero, string> = {
  general: 'General', inapam: 'INAPAM', menor: 'Menor',
};

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
  const [categoria, setCategoria] = useState<CategoriaPasajero>('general');
  const [importe, setImporte] = useState('');
  const [modo, setModo] = useState<'ventana' | 'programado'>('ventana');
  const [fechaProg, setFechaProg] = useState('');

  const ruta = useMemo(() => rutas.data?.find((r) => r.id === rutaId), [rutas.data, rutaId]);
  const paradas = ruta?.paradas ?? [];
  const ordenMax = paradas.length > 0 ? Math.max(...paradas.map((p) => p.orden)) : 0;
  // Un descuento solo es válido terminal-extremo → terminal-extremo (D4).
  const descuentoValido = origen === '0' && destino !== '' && Number(destino) === ordenMax;

  const m = useMutation({
    mutationFn: () => crearTarifa({
      rutaId, paradaOrigenOrden: Number(origen), paradaDestinoOrden: Number(destino), importe: Number(importe),
      categoria,
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

      <details className="tarjeta p-4">
        <summary className="cursor-pointer text-sm font-medium">+ Nueva tarifa</summary>
        <form onSubmit={enviar} className="mt-3 grid gap-3 sm:grid-cols-2 text-sm">
          <label>Ruta
            <select value={rutaId} onChange={(e) => { setRutaId(e.target.value); setOrigen('0'); setDestino(''); }} className="campo mt-1">
              <option value="">— elige —</option>
              {rutas.data?.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}
            </select>
          </label>
          <div />
          <label>Desde
            <select value={origen} onChange={(e) => setOrigen(e.target.value)} className="campo mt-1">
              {paradas.map((p) => <option key={p.orden} value={p.orden}>{p.orden} · {p.sucursal}</option>)}
            </select>
          </label>
          <label>Hasta
            <select value={destino} onChange={(e) => setDestino(e.target.value)} className="campo mt-1">
              <option value="">— elige —</option>
              {paradas.map((p) => <option key={p.orden} value={p.orden}>{p.orden} · {p.sucursal}</option>)}
            </select>
          </label>
          <label>Categoría
            <select value={categoria} onChange={(e) => setCategoria(e.target.value as CategoriaPasajero)} className="campo mt-1">
              <option value="general">General</option>
              <option value="inapam">INAPAM (descuento)</option>
              <option value="menor">Menor (descuento)</option>
            </select>
          </label>
          <label>Importe<input type="number" step="0.01" min="0" required value={importe} onChange={(e) => setImporte(e.target.value)} className="campo mt-1" /></label>
          {categoria !== 'general' && !descuentoValido && (
            <p className="sm:col-span-2 text-xs text-amber-600">
              Un descuento solo aplica de la terminal de origen (0) a la de destino ({ordenMax}).
            </p>
          )}
          <label>Cuándo
            <select value={modo} onChange={(e) => setModo(e.target.value as 'ventana' | 'programado')} className="campo mt-1">
              <option value="ventana">Ventana nocturna (03:00)</option>
              <option value="programado">Programado</option>
            </select>
          </label>
          {modo === 'programado' && (
            <label>Fecha<input type="datetime-local" value={fechaProg} onChange={(e) => setFechaProg(e.target.value)} className="campo mt-1" /></label>
          )}
          <button
            type="submit"
            disabled={m.isPending || !rutaId || !destino || (categoria !== 'general' && !descuentoValido)}
            className="btn-primario justify-self-start"
          >
            {m.isPending ? 'Creando…' : 'Crear'}
          </button>
        </form>
      </details>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Ruta</th><th className="px-4 py-2.5">Tramo</th>
              <th className="px-4 py-2.5">Categoría</th>
              <th className="px-4 py-2.5">Importe</th><th className="px-4 py-2.5">Vigencia</th>
              <th className="px-4 py-2.5">Estado</th><th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {tarifas.data?.map((t) => {
              const vigente = t.activo && !t.effective_until;
              return (
                <tr key={t.id} className="border-t border-slate-100 transition hover:bg-brand-50/40">
                  <td className="px-4 py-3">{t.ruta_nombre}</td>
                  <td className="px-4 py-3">{t.parada_origen_orden} → {t.parada_destino_orden}</td>
                  <td className="px-4 py-3">
                    {t.categoria_pasajero === 'general'
                      ? <span className="text-slate-500">General</span>
                      : <span className="chip">{CATEGORIA_ETIQUETA[t.categoria_pasajero]}</span>}
                  </td>
                  <td className="px-4 py-3">{mxn(t.importe)}</td>
                  <td className="px-4 py-3 text-slate-500">{fecha(t.effective_from)}{t.effective_until ? ` → ${fecha(t.effective_until)}` : ''}</td>
                  <td className="px-4 py-3">
                    {vigente
                      ? <span className="chip-ok">vigente</span>
                      : <span className="chip-baja">cerrada</span>}
                  </td>
                  <td className="px-4 py-3">
                    {vigente && (
                      <button
                        className="btn-sutil"
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
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Sin tarifas.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
