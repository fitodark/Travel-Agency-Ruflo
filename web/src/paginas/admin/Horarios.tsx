import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import {
  bajaHorario, bajaRuta, crearHorario, crearPunto, crearRuta, editarHorario,
  listarConductores, listarHorarios, listarPuntos, listarRutasDetalle, listarSucursales,
  listarUnidades, reemplazarRuta,
  type BoletoHuerfano, type HorarioDetalle, type ParadaNueva, type RutaDetalle,
} from '../../api/admin';
import { Modal } from '../../componentes/ui';

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

  const [reemplazar, setReemplazar] = useState<RutaDetalle | null>(null);
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
                <td className="px-4 py-3 font-medium">
                  {r.nombre}
                  {r.vigenteHasta && <span className="ml-2 text-xs text-amber-600">hasta {r.vigenteHasta}</span>}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {r.paradas.map((p) => (
                    <span key={p.id}>
                      {p.orden > 0 && ' → '}
                      {p.sucursal}
                      {p.tipo === 'parada' && <span className="text-xs text-slate-400"> (baja)</span>}
                    </span>
                  ))}
                </td>
                <td className="px-4 py-3">
                  {r.activo
                    ? <span className="chip-ok">activa</span>
                    : <span className="chip-baja">baja</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm">
                  <button className="btn-sutil mr-3" onClick={() => setSel(sel === r.id ? null : r.id)}>
                    {sel === r.id ? 'ocultar horarios' : 'horarios'}
                  </button>
                  {r.activo && !r.vigenteHasta && (
                    <button className="btn-sutil mr-3" onClick={() => setReemplazar(r)}>reemplazar</button>
                  )}
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

      {reemplazar && (
        <ReemplazarRuta
          ruta={reemplazar}
          onCerrar={() => setReemplazar(null)}
          onHecho={() => void refrescarRutas()}
          onError={setError}
        />
      )}
    </div>
  );
}

function ReemplazarRuta(
  { ruta, onCerrar, onHecho, onError }:
  { ruta: RutaDetalle; onCerrar: () => void; onHecho: () => void; onError: (m: string) => void },
) {
  const sucursales = useQuery({ queryKey: ['admin', 'sucursales'], queryFn: listarSucursales });
  const puntos = useQuery({ queryKey: ['admin', 'puntos'], queryFn: listarPuntos });
  const [nombre, setNombre] = useState(`${ruta.nombre} (v2)`);
  const [vigenteDesde, setVigenteDesde] = useState('');
  // Arranca con las mismas paradas que la ruta vieja.
  const [filas, setFilas] = useState<FilaParada[]>(
    ruta.paradas.map((p) => ({
      sel: p.tipo === 'terminal' && p.sucursalId ? `t:${p.sucursalId}` : `p:${p.puntoId}`,
      permiteAscenso: p.permiteAscenso, permiteDescenso: p.permiteDescenso,
    })),
  );
  const [resultado, setResultado] = useState<{ huerfanos: BoletoHuerfano[]; vigenteHasta: string } | null>(null);

  const sucs = (sucursales.data ?? []).filter((s) => s.activo);
  const paradasDisp = (puntos.data ?? []).filter((p) => p.tipo === 'parada' && p.activo);
  const set = (i: number, patch: Partial<FilaParada>) =>
    setFilas(filas.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const completo = nombre.trim() !== '' && vigenteDesde !== '' && filas.every((f) => f.sel !== '');

  const m = useMutation({
    mutationFn: async () => reemplazarRuta(ruta.id, {
      nombre, vigenteDesde, paradas: await resolverParadas(filas),
    }),
    onSuccess: (r) => {
      setResultado({ huerfanos: r.huerfanos, vigenteHasta: r.rutaViejaVigenteHasta });
      onHecho();
    },
    onError: (e) => onError(msg(e)),
  });

  return (
    <Modal titulo={`Reemplazar ruta · ${ruta.nombre}`} onCerrar={onCerrar}>
      {resultado ? (
        <div className="space-y-3 text-sm">
          <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-brand-800">
            Ruta nueva creada. La actual queda vigente hasta <b>{resultado.vigenteHasta}</b>.
          </p>
          {resultado.huerfanos.length === 0 ? (
            <p className="text-slate-500">No hay boletos vendidos para viajar después de esa fecha.</p>
          ) : (
            <>
              <p className="font-medium text-amber-700">
                {resultado.huerfanos.length} boleto(s) huérfano(s) — reubícalos a mano (cancelar + reemitir):
              </p>
              <div className="max-h-64 overflow-y-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-2 py-1">Folio</th><th className="px-2 py-1">Pasajero</th>
                      <th className="px-2 py-1">Contacto</th><th className="px-2 py-1">Fecha</th>
                      <th className="px-2 py-1">Tramo</th><th className="px-2 py-1">Pago</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.huerfanos.map((h) => (
                      <tr key={h.boletoId} className="border-t">
                        <td className="px-2 py-1 font-mono">{h.folio}</td>
                        <td className="px-2 py-1">{h.pasajero}</td>
                        <td className="px-2 py-1">{h.contacto}</td>
                        <td className="px-2 py-1">{h.fechaOperacion}</td>
                        <td className="px-2 py-1">{h.origen} → {h.destino}</td>
                        <td className="px-2 py-1">{h.estatusPago}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <button className="btn-primario" onClick={onCerrar}>Listo</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-3 text-sm">
          <p className="text-xs text-slate-500">
            Crea una ruta nueva con paradas distintas y da de baja la actual por vigencia.
            La fecha debe ser futura y sin traslape con los horarios de la ruta actual.
          </p>
          <label className="block">Nombre de la ruta nueva
            <input required value={nombre} onChange={(e) => setNombre(e.target.value)} className="campo mt-1" />
          </label>
          <label className="block">Primer día operativo
            <input type="date" required value={vigenteDesde} onChange={(e) => setVigenteDesde(e.target.value)} className="campo mt-1" />
          </label>
          <div className="space-y-2">
            <span className="text-slate-500">Paradas de la ruta nueva</span>
            {filas.map((f, i) => {
              const extremo = i === 0 || i === filas.length - 1;
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-slate-100 bg-slate-50/50 p-2">
                  <span className="w-6 text-slate-400">{i + 1}.</span>
                  <select
                    value={f.sel}
                    onChange={(e) => {
                      const esParada = e.target.value.startsWith('p:');
                      set(i, { sel: e.target.value, permiteAscenso: !esParada, permiteDescenso: true });
                    }}
                    className="rounded border px-2 py-1"
                  >
                    <option value="">— elige —</option>
                    <optgroup label="Terminales">
                      {sucs.map((s) => <option key={s.id} value={`t:${s.id}`}>{s.codigo} {s.nombre}</option>)}
                    </optgroup>
                    {!extremo && paradasDisp.length > 0 && (
                      <optgroup label="Paradas de descenso">
                        {paradasDisp.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.nombre}</option>)}
                      </optgroup>
                    )}
                  </select>
                  {!extremo && (
                    <>
                      <label className="flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={f.permiteAscenso} disabled={f.sel.startsWith('p:')}
                          onChange={(e) => set(i, { permiteAscenso: e.target.checked })} /> ascenso
                      </label>
                      <button type="button" className="ml-auto text-slate-400 underline"
                        onClick={() => setFilas(filas.filter((_, j) => j !== i))}>quitar</button>
                    </>
                  )}
                </div>
              );
            })}
            <button type="button" className="btn-sutil"
              onClick={() => setFilas([...filas.slice(0, -1), filaVacia(false), filas[filas.length - 1]!])}>
              + parada intermedia
            </button>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={m.isPending || !completo} className="btn-primario">
              {m.isPending ? 'Reemplazando…' : 'Reemplazar'}
            </button>
            <button type="button" onClick={onCerrar} className="rounded border px-4 py-1.5">Cancelar</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

interface FilaParada {
  /** `` = sin elegir. Formato `t:<sucursalId>` para terminal, `p:<puntoId>` para parada. */
  sel: string;
  permiteAscenso: boolean;
  permiteDescenso: boolean;
}

const filaVacia = (extremo: boolean): FilaParada => ({ sel: '', permiteAscenso: true, permiteDescenso: extremo });

/**
 * Resuelve el arreglo de filas al contrato `paradas` de `crearRuta`: cada terminal
 * se "asegura" (crearPunto idempotente) para obtener su `puntoId`.
 */
async function resolverParadas(filas: FilaParada[]): Promise<ParadaNueva[]> {
  return Promise.all(filas.map(async (f) => {
    const [tipo, id] = f.sel.split(':');
    const puntoId = tipo === 't'
      ? (await crearPunto({ tipo: 'terminal', sucursalId: id })).id
      : id!;
    return { puntoId, permiteAscenso: f.permiteAscenso, permiteDescenso: f.permiteDescenso };
  }));
}

function NuevaRuta({ onCreada, onError }: { onCreada: () => void; onError: (m: string) => void }) {
  const sucursales = useQuery({ queryKey: ['admin', 'sucursales'], queryFn: listarSucursales });
  const puntos = useQuery({ queryKey: ['admin', 'puntos'], queryFn: listarPuntos });
  const [nombre, setNombre] = useState('');
  const [filas, setFilas] = useState<FilaParada[]>([filaVacia(true), filaVacia(true)]);
  const sucs = (sucursales.data ?? []).filter((s) => s.activo);
  const paradasDisp = (puntos.data ?? []).filter((p) => p.tipo === 'parada' && p.activo);

  const m = useMutation({
    mutationFn: async () => crearRuta({ nombre, paradas: await resolverParadas(filas) }),
    onSuccess: () => { setNombre(''); setFilas([filaVacia(true), filaVacia(true)]); onCreada(); },
    onError: (e) => onError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  const set = (i: number, patch: Partial<FilaParada>) =>
    setFilas(filas.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const completo = nombre.trim() !== '' && filas.every((f) => f.sel !== '');

  return (
    <details className="tarjeta p-4">
      <summary className="cursor-pointer text-sm font-medium">+ Nueva ruta</summary>
      <form onSubmit={enviar} className="mt-3 space-y-3 text-sm">
        <label className="block">Nombre
          <input required value={nombre} onChange={(e) => setNombre(e.target.value)} className="mt-1 w-full max-w-sm rounded border px-2 py-1" />
        </label>
        <div className="space-y-2">
          <span className="text-slate-500">
            Paradas en orden. El <b>origen</b> y el <b>destino</b> deben ser terminales;
            las intermedias pueden ser paradas de solo descenso.
          </span>
          {filas.map((f, i) => {
            const extremo = i === 0 || i === filas.length - 1;
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-slate-100 bg-slate-50/50 p-2">
                <span className="w-6 text-slate-400">{i + 1}.</span>
                <select
                  value={f.sel}
                  onChange={(e) => {
                    const esParada = e.target.value.startsWith('p:');
                    set(i, {
                      sel: e.target.value,
                      // Una parada de descenso no permite ascenso; una terminal, ambas.
                      permiteAscenso: !esParada,
                      permiteDescenso: true,
                    });
                  }}
                  className="rounded border px-2 py-1"
                >
                  <option value="">— elige —</option>
                  <optgroup label="Terminales (sucursales)">
                    {sucs.map((s) => <option key={s.id} value={`t:${s.id}`}>{s.codigo} {s.nombre}</option>)}
                  </optgroup>
                  {!extremo && paradasDisp.length > 0 && (
                    <optgroup label="Paradas de descenso">
                      {paradasDisp.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.nombre}</option>)}
                    </optgroup>
                  )}
                </select>
                {extremo
                  ? <span className="text-xs text-slate-400">ascenso + descenso</span>
                  : (
                    <span className="flex gap-3 text-xs">
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={f.permiteAscenso}
                          disabled={f.sel.startsWith('p:')}
                          onChange={(e) => set(i, { permiteAscenso: e.target.checked })} />
                        ascenso
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={f.permiteDescenso}
                          onChange={(e) => set(i, { permiteDescenso: e.target.checked })} />
                        descenso
                      </label>
                    </span>
                  )}
                {!extremo && (
                  <button type="button" className="ml-auto text-slate-400 underline"
                    onClick={() => setFilas(filas.filter((_, j) => j !== i))}>quitar</button>
                )}
              </div>
            );
          })}
          <button type="button" className="btn-sutil"
            onClick={() => setFilas([...filas.slice(0, -1), filaVacia(false), filas[filas.length - 1]!])}>
            + parada intermedia
          </button>
        </div>
        <button type="submit" disabled={m.isPending || !completo} className="btn-primario">
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

  // Las paradas de solo descenso viajan sin hora — no llevan "paso" en el horario.
  const conAscenso = useMemo(() => ruta.paradas.filter((p) => p.permiteAscenso), [ruta.paradas]);
  const sinAscenso = ruta.paradas.filter((p) => !p.permiteAscenso);

  const [horaSalida, setHoraSalida] = useState('07:00');
  const [ds, setDs] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [conductorId, setConductorId] = useState('');
  const [unidadId, setUnidadId] = useState('');
  const [vd, setVd] = useState('');
  const [vh, setVh] = useState('');
  // Hora de paso por parada: por defecto la de salida; el usuario ajusta las intermedias.
  const [pasos, setPasos] = useState<Record<string, string>>(() =>
    Object.fromEntries(conAscenso.map((p) => [p.id, '07:00'])),
  );
  const setPaso = (id: string, v: string) => setPasos({ ...pasos, [id]: v });

  const m = useMutation({
    mutationFn: () => crearHorario({
      rutaId: ruta.id, horaSalida, diasSemana: ds,
      ...(conductorId ? { conductorId } : {}),
      ...(unidadId ? { unidadId } : {}),
      ...(vd ? { vigenteDesde: vd } : {}),
      ...(vh ? { vigenteHasta: vh } : {}),
      pasos: conAscenso.map((p) => ({ rutaParadaId: p.id, orden: p.orden, horaPaso: p.orden === 0 ? horaSalida : (pasos[p.id] ?? horaSalida) })),
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
        <FilaHorario
          key={h.id}
          h={h}
          conductores={conductores.data ?? []}
          unidades={unidades.data ?? []}
          onGuardado={(a) => { setAviso(a); void refrescar(); }}
          onBaja={() => {
            if (window.confirm('¿Dar de baja este horario? Se cancelan sus salidas futuras sin boletos.')) {
              bajaHorario(h.id)
                .then((r) => {
                  setAviso(r.salidasCanceladas > 0
                    ? `Horario dado de baja — ${r.salidasCanceladas} salidas canceladas.`
                    : 'Horario dado de baja.');
                  void refrescar();
                })
                .catch((e) => onError(msg(e)));
            }
          }}
          onError={onError}
        />
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

        {conAscenso.length > 1 && (
          <div className="sm:col-span-2">
            <span className="text-slate-500">Hora de paso por parada de ascenso</span>
            <div className="mt-1 grid gap-2 sm:grid-cols-3">
              {conAscenso.map((p) => (
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
            {sinAscenso.length > 0 && (
              <p className="mt-1 text-xs text-slate-400">
                Sin hora (solo descenso): {sinAscenso.map((p) => p.sucursal).join(', ')}
              </p>
            )}
          </div>
        )}

        <p className="sm:col-span-2 text-xs text-slate-400">
          Sin conductor el horario se guarda pero no genera salidas (no se puede
          vender). Puedes asignarlo ahora o después con "editar".
        </p>
        <button type="submit" disabled={m.isPending || ds.length === 0} className="btn-primario justify-self-start">
          {m.isPending ? 'Creando…' : 'Crear horario'}
        </button>
      </form>
    </div>
  );
}

type Opcion = { id: string; nombre: string };

function FilaHorario(
  { h, conductores, unidades, onGuardado, onBaja, onError }:
  {
    h: HorarioDetalle;
    conductores: Opcion[];
    unidades: Opcion[];
    onGuardado: (aviso: string) => void;
    onBaja: () => void;
    onError: (m: string) => void;
  },
) {
  const [abierto, setAbierto] = useState(false);
  const [verParadas, setVerParadas] = useState(false);
  const [conductorId, setConductorId] = useState(h.conductorId ?? '');
  const [unidadId, setUnidadId] = useState(h.unidadId ?? '');
  const [vd, setVd] = useState(h.vigenteDesde ?? '');
  const [vh, setVh] = useState(h.vigenteHasta ?? '');
  const sinConductor = !h.conductorId;

  const abrir = () => {
    setConductorId(h.conductorId ?? '');
    setUnidadId(h.unidadId ?? '');
    setVd(h.vigenteDesde ?? '');
    setVh(h.vigenteHasta ?? '');
    setAbierto(true);
  };

  const m = useMutation({
    mutationFn: () => editarHorario(h.id, {
      conductorId: conductorId || null,
      unidadId: unidadId || null,
      vigenteDesde: vd || null,
      vigenteHasta: vh || null,
    }),
    onSuccess: (r) => {
      setAbierto(false);
      onGuardado(
        r.avisoMaterializacion
          ? `Horario guardado. Salidas pendientes: ${r.avisoMaterializacion}`
          : r.salidasCreadas > 0
            ? `Horario guardado — ${r.salidasCreadas} salidas generadas.`
            : 'Horario guardado.',
      );
    },
    onError: (e) => onError(msg(e)),
  });

  return (
    <div className="border-b pb-2 text-sm">
      <div className="flex items-center gap-4">
        <span className="font-mono">{h.horaSalida.slice(0, 5)}</span>
        <span className="text-slate-600">{dias(h.diasSemana)}</span>
        <span className={sinConductor ? 'text-amber-600' : 'text-slate-500'}>
          {h.conductor ?? 'sin conductor — no se vende'}{h.unidad ? ` · ${h.unidad}` : ''}
        </span>
        <span className="text-slate-400">
          {h.vigenteDesde ?? '—'}{h.vigenteHasta ? ` → ${h.vigenteHasta}` : ''}
        </span>
        <span className="ml-auto flex gap-3">
          {h.pasos.length > 2 && (
            <button className="btn-sutil" onClick={() => setVerParadas(true)}>paradas</button>
          )}
          {h.activo && <button className="btn-sutil" onClick={abierto ? () => setAbierto(false) : abrir}>{abierto ? 'cerrar' : 'editar'}</button>}
          {h.activo
            ? <button className="btn-sutil" onClick={onBaja}>baja</button>
            : <span className="text-slate-400">baja</span>}
        </span>
      </div>

      {verParadas && (
        <Modal titulo={`Horas de paso · salida ${h.horaSalida.slice(0, 5)}`} onCerrar={() => setVerParadas(false)}>
          <ol className="space-y-2">
            {[...h.pasos].sort((a, b) => a.orden - b.orden).map((p, i) => (
              <li key={p.orden} className="flex items-center gap-3 text-sm">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                  i === 0 || i === h.pasos.length - 1 ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500'
                }`}>
                  {p.orden + 1}
                </span>
                <span className="flex-1">
                  {p.sucursal}
                  {i === 0 && <span className="ml-1 text-xs text-slate-400">(origen)</span>}
                  {i === h.pasos.length - 1 && <span className="ml-1 text-xs text-slate-400">(destino)</span>}
                </span>
                <span className="font-mono text-slate-700">{p.horaPaso.slice(0, 5)}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-slate-400">
            Hora local de cada sucursal. El cierre de venta se aplica antes de cada paso.
          </p>
        </Modal>
      )}

      {abierto && (
        <form
          onSubmit={(e) => { e.preventDefault(); m.mutate(); }}
          className="mt-2 grid gap-3 rounded-lg bg-slate-50/60 p-3 sm:grid-cols-2"
        >
          <label>Conductor
            <select value={conductorId} onChange={(e) => setConductorId(e.target.value)} className="campo mt-1">
              <option value="">— sin conductor —</option>
              {conductores.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </label>
          <label>Unidad
            <select value={unidadId} onChange={(e) => setUnidadId(e.target.value)} className="campo mt-1">
              <option value="">— sin unidad —</option>
              {unidades.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
            </select>
          </label>
          <label>Vigente desde<input type="date" value={vd} onChange={(e) => setVd(e.target.value)} className="campo mt-1" /></label>
          <label>Vigente hasta<input type="date" value={vh} onChange={(e) => setVh(e.target.value)} className="campo mt-1" /></label>
          <div className="sm:col-span-2 flex gap-2">
            <button type="submit" disabled={m.isPending} className="btn-primario">
              {m.isPending ? 'Guardando…' : 'Guardar'}
            </button>
            <button type="button" onClick={() => setAbierto(false)} className="rounded border px-4 py-1.5">Cancelar</button>
          </div>
        </form>
      )}
    </div>
  );
}
