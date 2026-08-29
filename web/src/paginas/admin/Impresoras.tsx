import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import { configurarImpresora, listarImpresoras, listarSucursales } from '../../api/admin';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo guardar la impresora.');

export function AdminImpresoras() {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['admin', 'impresoras'], queryFn: listarImpresoras });
  const sucursales = useQuery({ queryKey: ['admin', 'sucursales'], queryFn: listarSucursales });
  const [error, setError] = useState<string | null>(null);
  const sucs = (sucursales.data ?? []).filter((s) => s.activo);

  const [f, setF] = useState({
    sucursalId: '', nombre: 'Enduro', transporte: 'tcp' as 'tcp' | 'usb',
    ip: '', puerto: '9100', usbNombreCola: '', anchoCols: '48', codePage: 'CP858', esPredeterminada: true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked ?? false : e.target.value });

  const m = useMutation({
    mutationFn: () => configurarImpresora({
      sucursalId: f.sucursalId || sucs[0]?.id || '', nombre: f.nombre, transporte: f.transporte,
      ...(f.transporte === 'tcp' ? { ip: f.ip || undefined, puerto: Number(f.puerto) || undefined } : { usbNombreCola: f.usbNombreCola || undefined }),
      anchoCols: Number(f.anchoCols) || undefined, codePage: f.codePage || undefined, esPredeterminada: f.esPredeterminada,
    }),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: ['admin', 'impresoras'] }); },
    onError: (e) => setError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        Una impresora por sucursal. Los cambios son inmediatos: la IP es hardware presente, no una política.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <details className="rounded border bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium">+ Configurar impresora</summary>
        <form onSubmit={enviar} className="mt-3 grid gap-3 sm:grid-cols-2 text-sm">
          <label>Sucursal
            <select value={f.sucursalId} onChange={set('sucursalId')} className="mt-1 w-full rounded border px-2 py-1">
              <option value="">— elige —</option>
              {sucs.map((s) => <option key={s.id} value={s.id}>{s.codigo} {s.nombre}</option>)}
            </select>
          </label>
          <label>Nombre<input value={f.nombre} onChange={set('nombre')} className="mt-1 w-full rounded border px-2 py-1" /></label>
          <label>Transporte
            <select value={f.transporte} onChange={set('transporte')} className="mt-1 w-full rounded border px-2 py-1">
              <option value="tcp">TCP (red)</option>
              <option value="usb">USB (cola Windows)</option>
            </select>
          </label>
          {f.transporte === 'tcp' ? (
            <>
              <label>IP<input value={f.ip} onChange={set('ip')} placeholder="192.168.1.110" className="mt-1 w-full rounded border px-2 py-1" /></label>
              <label>Puerto<input type="number" value={f.puerto} onChange={set('puerto')} className="mt-1 w-full rounded border px-2 py-1" /></label>
            </>
          ) : (
            <label>Cola USB<input value={f.usbNombreCola} onChange={set('usbNombreCola')} placeholder="XP-80" className="mt-1 w-full rounded border px-2 py-1" /></label>
          )}
          <label>Columnas<input type="number" value={f.anchoCols} onChange={set('anchoCols')} className="mt-1 w-full rounded border px-2 py-1" /></label>
          <label>Code page<input value={f.codePage} onChange={set('codePage')} className="mt-1 w-full rounded border px-2 py-1" /></label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={f.esPredeterminada} onChange={set('esPredeterminada')} /> predeterminada
          </label>
          <button type="submit" disabled={m.isPending} className="rounded bg-slate-900 text-white px-4 py-1.5 disabled:opacity-50 justify-self-start">
            {m.isPending ? 'Guardando…' : 'Guardar'}
          </button>
        </form>
      </details>

      <div className="overflow-x-auto">
        <table className="w-full text-sm bg-white rounded border">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Sucursal</th><th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Transporte</th><th className="px-3 py-2">Ancho</th>
              <th className="px-3 py-2">Code page</th><th className="px-3 py-2">QR</th><th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {lista.data?.map((i, idx) => (
              <tr key={idx} className="border-t">
                <td className="px-3 py-2">{i.sucursal_nombre}</td>
                <td className="px-3 py-2">{i.nombre}</td>
                <td className="px-3 py-2">{i.transporte === 'tcp' ? `${i.ip}:${i.puerto}` : `USB · ${i.usb_nombre_cola}`}</td>
                <td className="px-3 py-2">{i.ancho_cols} col</td>
                <td className="px-3 py-2">{i.code_page}</td>
                <td className="px-3 py-2">{i.soporta_qr_nativo ? 'nativo' : 'raster'}</td>
                <td className="px-3 py-2">{i.es_predeterminada && <span className="rounded bg-green-100 text-green-700 px-2 py-0.5 text-xs">predet.</span>}</td>
              </tr>
            ))}
            {lista.data?.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Ninguna sucursal tiene impresora configurada.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
