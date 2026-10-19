import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import { configurarImpresora, listarImpresoras, listarSucursales } from '../../api/admin';
import {
  fijarOverrideLocal, listarImpresorasLocales, quitarOverrideLocal, type Transporte,
} from '../../api/impresora-local';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo guardar la impresora.');

/**
 * Ajuste de emergencia SIN internet (0078): QA detectó que, sin conexión a la
 * nube, el administrador no tenía ningún camino para corregir la IP de la
 * impresora aunque estuviera físicamente en la sucursal — `/admin/*` exige
 * nube por diseño. Este bloque habla con `/impresora-local` en vez de
 * `/admin`, así que funciona con o sin conexión. La nube sigue siendo la
 * fuente de verdad: al volver el internet, corrige la IP real aquí arriba.
 */
function OverrideLocalImpresora() {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['impresora-local'], queryFn: listarImpresorasLocales });
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<Record<string, { transporte: Transporte; ip: string; puerto: string; usbNombreCola: string }>>({});

  const campo = (id: string) => f[id] ?? { transporte: 'tcp' as Transporte, ip: '', puerto: '9100', usbNombreCola: '' };
  const setCampo = (id: string, patch: Partial<ReturnType<typeof campo>>) =>
    setF({ ...f, [id]: { ...campo(id), ...patch } });

  const fijar = useMutation({
    mutationFn: ({ id }: { id: string }) => {
      const c = campo(id);
      return fijarOverrideLocal(id, {
        transporte: c.transporte,
        ...(c.transporte === 'tcp'
          ? { ip: c.ip, puerto: Number(c.puerto) || undefined }
          : { usbNombreCola: c.usbNombreCola }),
        nota: 'Ajustado localmente sin conexión a la nube',
      });
    },
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: ['impresora-local'] }); },
    onError: (e) => setError(msg(e)),
  });
  const quitar = useMutation({
    mutationFn: (id: string) => quitarOverrideLocal(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['impresora-local'] }),
    onError: (e) => setError(msg(e)),
  });

  if (lista.data?.length === 0) return null;

  return (
    <div className="tarjeta space-y-3 border-amber-200 bg-amber-50/40 p-4">
      <div>
        <p className="text-sm font-medium text-amber-900">Ajuste de emergencia (sin internet)</p>
        <p className="text-sm text-amber-800">
          Si la IP de la impresora de ESTA terminal cambió y no hay conexión a la nube para
          corregirla arriba, ajústala aquí: toma efecto de inmediato en esta máquina. Cuando
          vuelva el internet, corrige la IP real en el formulario de arriba — esto es un
          parche local, no reemplaza la configuración de la nube.
        </p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="space-y-3">
        {lista.data?.map((i) => {
          const c = campo(i.id);
          return (
            <div key={i.id} className="rounded-lg border border-amber-200 bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{i.nombre}</span>
                <span className="text-slate-500">
                  Vigente ahora: {i.transporte === 'tcp' ? `${i.ip}:${i.puerto}` : `USB · ${i.usbNombreCola}`}
                  {i.override && ' (override local activo)'}
                </span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr_auto_auto]">
                <select
                  value={c.transporte}
                  onChange={(e) => setCampo(i.id, { transporte: e.target.value as Transporte })}
                  className="campo"
                >
                  <option value="tcp">TCP (red)</option>
                  <option value="usb">USB</option>
                </select>
                {c.transporte === 'tcp' ? (
                  <>
                    <input
                      value={c.ip} onChange={(e) => setCampo(i.id, { ip: e.target.value })}
                      placeholder="192.168.1.110" className="campo"
                    />
                    <input
                      value={c.puerto} onChange={(e) => setCampo(i.id, { puerto: e.target.value })}
                      className="campo" placeholder="9100"
                    />
                  </>
                ) : (
                  <input
                    value={c.usbNombreCola} onChange={(e) => setCampo(i.id, { usbNombreCola: e.target.value })}
                    placeholder="XP-80" className="campo sm:col-span-2"
                  />
                )}
                <button
                  type="button" onClick={() => fijar.mutate({ id: i.id })} disabled={fijar.isPending}
                  className="btn-fantasma"
                >
                  Aplicar aquí
                </button>
              </div>
              {i.override && (
                <button
                  type="button" onClick={() => quitar.mutate(i.id)} disabled={quitar.isPending}
                  className="mt-2 text-xs text-slate-500 underline"
                >
                  Quitar override y volver a lo de la nube
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

      <OverrideLocalImpresora />

      <details className="tarjeta p-4">
        <summary className="cursor-pointer text-sm font-medium">+ Configurar impresora</summary>
        <form onSubmit={enviar} className="mt-3 grid gap-3 sm:grid-cols-2 text-sm">
          <label>Sucursal
            <select value={f.sucursalId} onChange={set('sucursalId')} className="campo mt-1">
              <option value="">— elige —</option>
              {sucs.map((s) => <option key={s.id} value={s.id}>{s.codigo} {s.nombre}</option>)}
            </select>
          </label>
          <label>Nombre<input value={f.nombre} onChange={set('nombre')} className="campo mt-1" /></label>
          <label>Transporte
            <select value={f.transporte} onChange={set('transporte')} className="campo mt-1">
              <option value="tcp">TCP (red)</option>
              <option value="usb">USB (cola Windows)</option>
            </select>
          </label>
          {f.transporte === 'tcp' ? (
            <>
              <label>IP<input value={f.ip} onChange={set('ip')} placeholder="192.168.1.110" className="campo mt-1" /></label>
              <label>Puerto<input type="number" value={f.puerto} onChange={set('puerto')} className="campo mt-1" /></label>
            </>
          ) : (
            <label>Cola USB<input value={f.usbNombreCola} onChange={set('usbNombreCola')} placeholder="XP-80" className="campo mt-1" /></label>
          )}
          <label>Columnas<input type="number" value={f.anchoCols} onChange={set('anchoCols')} className="campo mt-1" /></label>
          <label>Code page<input value={f.codePage} onChange={set('codePage')} className="campo mt-1" /></label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={f.esPredeterminada} onChange={set('esPredeterminada')} /> predeterminada
          </label>
          <button type="submit" disabled={m.isPending} className="btn-primario justify-self-start">
            {m.isPending ? 'Guardando…' : 'Guardar'}
          </button>
        </form>
      </details>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Sucursal</th><th className="px-4 py-2.5">Nombre</th>
              <th className="px-4 py-2.5">Transporte</th><th className="px-4 py-2.5">Ancho</th>
              <th className="px-4 py-2.5">Code page</th><th className="px-4 py-2.5">QR</th><th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {lista.data?.map((i, idx) => (
              <tr key={idx} className="border-t border-slate-100 transition hover:bg-brand-50/40">
                <td className="px-4 py-3">{i.sucursal_nombre}</td>
                <td className="px-4 py-3">{i.nombre}</td>
                <td className="px-4 py-3">{i.transporte === 'tcp' ? `${i.ip}:${i.puerto}` : `USB · ${i.usb_nombre_cola}`}</td>
                <td className="px-4 py-3">{i.ancho_cols} col</td>
                <td className="px-4 py-3">{i.code_page}</td>
                <td className="px-4 py-3">{i.soporta_qr_nativo ? 'nativo' : 'raster'}</td>
                <td className="px-4 py-3">{i.es_predeterminada && <span className="chip-ok">predet.</span>}</td>
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
