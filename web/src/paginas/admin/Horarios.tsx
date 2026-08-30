import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import {
  bajaHorario, bajaRuta, crearHorario, crearRuta, listarConductores, listarHorarios,
  listarRutasDetalle, listarSucursales, listarUnidades, type RutaDetalle,
} from '../../api/admin';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo completar la operación.');
const DIAS = [
  { n: 1, t: 'L' }, { n: 2, t: 'M' }, { n: 3, t: 'M' }, { n: 4, t: 'J' },
  { n: 5, t: 'V' }, { n: 6, t: 'S' }, { n: 7, t: 'D' },
];
const dias = (ds: number[]) => DIAS.filter((d) => ds.includes(d.n)).map((d) => d.t).join(' ');

export function AdminHorarios() {
  const qc = useQueryClient();
  const rutas = useQuery({ queryKey: ['admin', 'rutas-detalle'], queryFn: listarRutasDetalle });
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  const refrescarRutas = () => qc.invalidateQueries({ queryKey: ['admin', 'rutas-detalle'] });
  const rutaSel = rutas.data?.find((r) => r.id === sel);

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        Ruta = qué sucursales toca y en qué orden. Horario = a qué hora y qué días.
        Al guardar un horario <b>con conductor</b> se generan sus salidas en el acto
        (bajan a las sucursales en el siguiente sync). Sin conductor, el horario
        queda listo y el job nocturno lo materializa cuando se le asigne uno.
        Cambiar un horario <b>no</b> re-materializa las salidas ya creadas.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <NuevaRuta onCreada={() => void refrescarRutas()} onError={setError} />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Ruta</th><th className="px-4 py-2.5">Paradas</th>
              <th className="px-4 py-2.5">Estado</th><th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rutas.data?.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 transition hover:bg-brand-50/40">
                <td className="px-4 py-3 font-medium">{r.nombre}</td>
                <td className="px-4 py-3 text-slate-600">{r.paradas.map((p) => p.sucursal).join(' → ')}</td>
                <td className="px-4 py-3">
                  {r.activo
                    ? <span className="chip-ok">activa</span>
                    : <span className="chip-baja">baja</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm">
                  <button className="btn-sutil mr-3" onClick={() => setSel(sel === r.id ? null : r.id)}>
                    {sel === r.id ? 'ocultar horarios' : 'horarios'}
                  </button>
                  {r.activo && (
                    <button
                      className="btn-sutil"
                      onClick={() => {
                        if (window.confirm('¿Dar de baja esta ruta?')) {
                          bajaRuta(r.id).then(() => void refrescarRutas()).catch((e) => setError(msg(e)));
                        }
                      }}
                    >
                      baja
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rutas.data?.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Sin rutas.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {rutaSel && <Horarios ruta={rutaSel} onError={setError} />}
    </div>
  );
}

function NuevaRuta({ onCreada, onError }: { onCreada: () => void; onError: (m: string) => void }) {
  const sucursales = useQuery({ queryKey: ['admin', 'sucursales'], queryFn: listarSucursales });
  const [nombre, setNombre] = useState('');
  const [ids, setIds] = useState<string[]>(['', '']);
  const sucs = (sucursales.data ?? []).filter((s) => s.activo);

  const m = useMutation({
    mutationFn: () => crearRuta({ nombre, sucursalIds: ids.filter(Boolean) }),
    onSuccess: () => { setNombre(''); setIds(['', '']); onCreada(); },
    onError: (e) => onError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  const setId = (i: number, v: string) => setIds(ids.map((x, j) => (j === i ? v : x)));

  return (
    <details className="tarjeta p-4">
      <summary className="cursor-pointer text-sm font-medium">+ Nueva ruta</summary>
      <form onSubmit={enviar} className="mt-3 space-y-3 text-sm">
        <label className="block">Nombre
          <input required value={nombre} onChange={(e) => setNombre(e.target.value)} className="mt-1 w-full max-w-sm rounded border px-2 py-1" />
        </label>
        <div className="space-y-2">
          <span className="text-slate-500">Paradas en orden (origen → destino)</span>
          {ids.map((id, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-6 text-slate-400">{i + 1}.</span>
              <select value={id} onChange={(e) => setId(i, e.target.value)} className="rounded border px-2 py-1">
                <option value="">— elige —</option>
                {sucs.map((s) => <option key={s.id} value={s.id}>{s.codigo} {s.nombre}</option>)}
              </select>
              {ids.length > 2 && (
                <button type="button" className="text-slate-400 underline" onClick={() => setIds(ids.filter((_, j) => j !== i))}>quitar</button>
              )}
            </div>
          ))}
          <button type="button" className="btn-sutil" onClick={() => setIds([...ids, ''])}>+ parada intermedia</button>
        </div>
        <button type="submit" disabled={m.isPending} className="btn-primario">
          {m.isPending ? 'Creando…' : 'Crear ruta'}
        </button>
      </form>
    </details>
  );
}

function Horarios({ ruta, onError }: { ruta: RutaDetalle; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const horarios = useQuery({ queryKey: ['admin', 'horarios', ruta.id], queryFn: () => listarHorarios(ruta.id) });
  const conductores = useQuery({ queryKey: ['admin', 'conductores'], queryFn: listarConductores });
  const unidades = useQuery({ queryKey: ['admin', 'unidades'], queryFn: listarUnidades });
  const refrescar = () => qc.invalidateQueries({ queryKey: ['admin', 'horarios', ruta.id] });
  const [aviso, setAviso] = useState<string | null>(null);

  const [horaSalida, setHoraSalida] = useState('07:00');
  const [ds, setDs] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [conductorId, setConductorId] = useState('');
  const [unidadId, setUnidadId] = useState('');
  const [vd, setVd] = useState('');
  const [vh, setVh] = useState('');
  // Hora de paso por parada: por defecto la de salida; el usuario ajusta las intermedias.
  const [pasos, setPasos] = useState<Record<string, string>>(() =>
    Object.fromEntries(ruta.paradas.map((p) => [p.id, '07:00'])),
  );
  const setPaso = (id: string, v: string) => setPasos({ ...pasos, [id]: v });

  const m = useMutation({
    mutationFn: () => crearHorario({
      rutaId: ruta.id, horaSalida, diasSemana: ds,
      ...(conductorId ? { conductorId } : {}),
      ...(unidadId ? { unidadId } : {}),
      ...(vd ? { vigenteDesde: vd } : {}),
      ...(vh ? { vigenteHasta: vh } : {}),
      pasos: ruta.paradas.map((p) => ({ rutaParadaId: p.id, orden: p.orden, horaPaso: p.orden === 0 ? horaSalida : (pasos[p.id] ?? horaSalida) })),
    }),
    onSuccess: (r) => {
      setAviso(
        r.avisoMaterializacion
          ? `Horario guardado. Salidas pendientes: ${r.avisoMaterializacion}`
          : r.salidasCreadas > 0
            ? `Horario guardado — ${r.salidasCreadas} salidas generadas.`
            : 'Horario guardado. Asígnale un conductor para generar sus salidas.',
      );
      void refrescar();
    },
    onError: (e) => onError(msg(e)),
  });

  const toggleDia = (n: number) => setDs(ds.includes(n) ? ds.filter((x) => x !== n) : [...ds, n].sort());

  return (
    <div className="tarjeta p-4 space-y-4">
      <p className="font-medium">Horarios de {ruta.nombre}</p>
      {aviso && (
        <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">{aviso}</p>
      )}

      {horarios.data?.map((h) => (
        <div key={h.id} className="flex items-center gap-4 text-sm border-b pb-2">
          <span className="font-mono">{h.horaSalida.slice(0, 5)}</span>
          <span className="text-slate-600">{dias(h.diasSemana)}</span>
          <span className="text-slate-500">{h.conductor ?? 'sin conductor'}{h.unidad ? ` · ${h.unidad}` : ''}</span>
          <span className="text-slate-400">
            {h.vigenteDesde ?? '—'}{h.vigenteHasta ? ` → ${h.vigenteHasta}` : ''}
          </span>
          {h.activo
            ? <button className="btn-sutil ml-auto" onClick={() => {
                if (window.confirm('¿Dar de baja este horario?')) bajaHorario(h.id).then(() => void refrescar()).catch((e) => onError(msg(e)));
              }}>baja</button>
            : <span className="ml-auto text-slate-400">baja</span>}
        </div>
      ))}
      {horarios.data?.length === 0 && <p className="text-sm text-slate-400">Sin horarios para esta ruta.</p>}

      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="grid gap-3 sm:grid-cols-2 text-sm border-t pt-3">
        <div className="sm:col-span-2 font-medium">Nuevo horario</div>
        <label>Hora de salida
          <input type="time" value={horaSalida} onChange={(e) => { setHoraSalida(e.target.value); setPasos((p) => ({ ...p, [ruta.paradas[0]!.id]: e.target.value })); }} className="campo mt-1" />
        </label>
        <div>
          <span className="text-slate-500">Días</span>
          <div className="mt-1 flex gap-1">
            {DIAS.map((d, i) => (
              <button key={i} type="button" onClick={() => toggleDia(d.n)}
                className={`w-7 h-7 rounded text-xs ${ds.includes(d.n) ? 'bg-brand-600 text-white' : 'bg-slate-100'}`}>
                {d.t}
              </button>
            ))}
          </div>
        </div>
        <label>Conductor
          <select value={conductorId} onChange={(e) => setConductorId(e.target.value)} className="campo mt-1">
            <option value="">— (opcional) —</option>
            {conductores.data?.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        <label>Unidad
          <select value={unidadId} onChange={(e) => setUnidadId(e.target.value)} className="campo mt-1">
            <option value="">— (opcional) —</option>
            {unidades.data?.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
          </select>
        </label>
        <label>Vigente desde<input type="date" value={vd} onChange={(e) => setVd(e.target.value)} className="campo mt-1" /></label>
        <label>Vigente hasta<input type="date" value={vh} onChange={(e) => setVh(e.target.value)} className="campo mt-1" /></label>

        {ruta.paradas.length > 1 && (
          <div className="sm:col-span-2">
            <span className="text-slate-500">Hora de paso por parada</span>
            <div className="mt-1 grid gap-2 sm:grid-cols-3">
              {ruta.paradas.map((p) => (
                <label key={p.id} className="text-xs">
                  {p.sucursal}
                  <input
                    type="time"
                    value={p.orden === 0 ? horaSalida : (pasos[p.id] ?? horaSalida)}
                    disabled={p.orden === 0}
                    onChange={(e) => setPaso(p.id, e.target.value)}
                    className="mt-0.5 w-full rounded border px-2 py-1 disabled:bg-slate-100"
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <button type="submit" disabled={m.isPending || ds.length === 0} className="btn-primario justify-self-start">
          {m.isPending ? 'Creando…' : 'Crear horario'}
        </button>
      </form>
    </div>
  );
}
