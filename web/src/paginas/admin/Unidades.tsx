import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import {
  bajaUnidad, crearUnidad, editarUnidad, listarSucursales, listarTiposUnidad,
  listarUnidadesDetalle, type UnidadDetalle,
} from '../../api/admin';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo completar la operación.');

/**
 * CRUD de `core.unidad` — el vehículo físico. `numero_economico` va en el ticket;
 * `tipo_unidad` decide el mapa de asientos (D-7). Cambios inmediatos: una unidad
 * es hardware presente, no una política con fecha.
 */
export function AdminUnidades() {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['admin', 'unidades'], queryFn: listarUnidadesDetalle });
  const tipos = useQuery({ queryKey: ['admin', 'tipos-unidad'], queryFn: listarTiposUnidad });
  const sucursales = useQuery({ queryKey: ['admin', 'sucursales'], queryFn: listarSucursales });
  const refrescar = () => qc.invalidateQueries({ queryKey: ['admin', 'unidades'] });
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<UnidadDetalle | null>(null);

  const opcionesTipo = tipos.data ?? [];
  const opcionesSuc = sucursales.data ?? [];

  return (
    <div className="space-y-5">
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {editando ? (
        <Formulario
          key={editando.id}
          inicial={editando}
          tipos={opcionesTipo}
          sucursales={opcionesSuc}
          onListo={() => { setEditando(null); void refrescar(); }}
          onCancelar={() => setEditando(null)}
          onError={setError}
        />
      ) : (
        <Formulario
          tipos={opcionesTipo}
          sucursales={opcionesSuc}
          onListo={() => void refrescar()}
          onError={setError}
        />
      )}

      {lista.isLoading && <p className="text-sm text-slate-400">Cargando…</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Nº económico</th>
              <th className="px-4 py-2.5">Tipo</th>
              <th className="px-4 py-2.5">Placas</th>
              <th className="px-4 py-2.5">Sucursal base</th>
              <th className="px-4 py-2.5">Estado</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {lista.data?.map((u) => (
              <tr key={u.id} className="border-t border-slate-100 transition hover:bg-brand-50/40">
                <td className="px-4 py-3 font-semibold">{u.numeroEconomico}</td>
                <td className="px-4 py-3 text-slate-500">{u.tipoUnidad}</td>
                <td className="px-4 py-3 text-slate-500">{u.placas ?? '—'}</td>
                <td className="px-4 py-3 text-slate-500">{u.sucursalBase ?? '—'}</td>
                <td className="px-4 py-3">
                  {u.activo ? <span className="chip-ok">activa</span> : <span className="chip-baja">baja</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm">
                  <button className="btn-sutil mr-3" onClick={() => setEditando(u)}>editar</button>
                  {u.activo && (
                    <Accion
                      texto="baja"
                      confirmar={`¿Dar de baja la unidad ${u.numeroEconomico}?`}
                      fn={() => bajaUnidad(u.id)}
                      onListo={() => void refrescar()}
                      onError={setError}
                    />
                  )}
                </td>
              </tr>
            ))}
            {lista.data?.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin unidades. Da de alta la primera.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Accion(
  { texto, confirmar, fn, onListo, onError }:
  { texto: string; confirmar: string; fn: () => Promise<unknown>; onListo: () => void; onError: (m: string) => void },
) {
  const m = useMutation({ mutationFn: fn, onSuccess: onListo, onError: (e) => onError(msg(e)) });
  return (
    <button
      className="btn-sutil mr-3 disabled:opacity-50"
      disabled={m.isPending}
      onClick={() => { if (window.confirm(confirmar)) m.mutate(); }}
    >
      {texto}
    </button>
  );
}

type Tipo = { id: string; clave: string; nombre: string };
type Suc = { id: string; nombre: string; codigo: string };

function Formulario(
  { inicial, tipos, sucursales, onListo, onCancelar, onError }:
  {
    inicial?: UnidadDetalle;
    tipos: Tipo[];
    sucursales: Suc[];
    onListo: () => void;
    onCancelar?: () => void;
    onError: (m: string) => void;
  },
) {
  const editar = inicial !== undefined;
  const [f, setF] = useState({
    numeroEconomico: inicial?.numeroEconomico ?? '',
    placas: inicial?.placas ?? '',
    tipoUnidadId: inicial?.tipoUnidadId ?? '',
    sucursalBaseId: inicial?.sucursalBaseId ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const m = useMutation({
    mutationFn: () => {
      const payload = {
        numeroEconomico: f.numeroEconomico.trim(),
        placas: f.placas.trim() || null,
        tipoUnidadId: f.tipoUnidadId,
        sucursalBaseId: f.sucursalBaseId || null,
      };
      return editar ? editarUnidad(inicial!.id, payload) : crearUnidad(payload);
    },
    onSuccess: () => {
      if (!editar) setF({ numeroEconomico: '', placas: '', tipoUnidadId: f.tipoUnidadId, sucursalBaseId: '' });
      onListo();
    },
    onError: (e) => onError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  const cuerpo = (
    <form onSubmit={enviar} className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
      <label>Nº económico
        <input required value={f.numeroEconomico} onChange={set('numeroEconomico')} className="campo mt-1" />
      </label>
      <label>Placas
        <input value={f.placas} onChange={set('placas')} className="campo mt-1" placeholder="opcional" />
      </label>
      <label>Tipo de unidad
        <select required value={f.tipoUnidadId} onChange={set('tipoUnidadId')} className="campo mt-1">
          <option value="" disabled>Elegir…</option>
          {tipos.map((t) => <option key={t.id} value={t.id}>{t.clave} — {t.nombre}</option>)}
        </select>
      </label>
      <label>Sucursal base
        <select value={f.sucursalBaseId} onChange={set('sucursalBaseId')} className="campo mt-1">
          <option value="">Sin asignar</option>
          {sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} · {s.nombre}</option>)}
        </select>
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={m.isPending} className="btn-primario">
          {m.isPending ? 'Guardando…' : editar ? 'Guardar' : 'Crear unidad'}
        </button>
        {onCancelar && (
          <button type="button" onClick={onCancelar} className="rounded border px-4 py-1.5">Cancelar</button>
        )}
      </div>
    </form>
  );

  if (editar) {
    return (
      <div className="tarjeta p-4">
        <div className="text-sm font-medium">Editar unidad {inicial!.numeroEconomico}</div>
        {cuerpo}
      </div>
    );
  }
  return (
    <details className="tarjeta p-4">
      <summary className="cursor-pointer text-sm font-medium">+ Nueva unidad</summary>
      {cuerpo}
    </details>
  );
}
