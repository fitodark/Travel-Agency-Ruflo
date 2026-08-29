import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import {
  bajaConductor, crearConductor, editarConductor, listarConductoresDetalle,
  listarTiposUnidad, listarUnidadesDetalle,
  type ConductorDetalle, type UnidadDetalle,
} from '../../api/admin';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo completar la operación.');

/**
 * CRUD de `core.conductor` (D-7 / P11): el conductor es el portador de la relación
 * con el tipo de unidad y el esquema. `tipo_unidad` es OBLIGATORIO; `unidad
 * habitual` es opcional y, si se pone, debe ser de ese mismo tipo (la lista se
 * filtra sola).
 */
export function AdminConductores() {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['admin', 'conductores'], queryFn: listarConductoresDetalle });
  const tipos = useQuery({ queryKey: ['admin', 'tipos-unidad'], queryFn: listarTiposUnidad });
  const unidades = useQuery({ queryKey: ['admin', 'unidades'], queryFn: listarUnidadesDetalle });
  const refrescar = () => qc.invalidateQueries({ queryKey: ['admin', 'conductores'] });
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<ConductorDetalle | null>(null);

  return (
    <div className="space-y-5">
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {editando ? (
        <Formulario
          key={editando.id}
          inicial={editando}
          tipos={tipos.data ?? []}
          unidades={unidades.data ?? []}
          onListo={() => { setEditando(null); void refrescar(); }}
          onCancelar={() => setEditando(null)}
          onError={setError}
        />
      ) : (
        <Formulario
          tipos={tipos.data ?? []}
          unidades={unidades.data ?? []}
          onListo={() => void refrescar()}
          onError={setError}
        />
      )}

      {lista.isLoading && <p className="text-sm text-slate-400">Cargando…</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Nombre</th>
              <th className="px-4 py-2.5">Teléfono</th>
              <th className="px-4 py-2.5">Tipo de unidad</th>
              <th className="px-4 py-2.5">Unidad habitual</th>
              <th className="px-4 py-2.5">Estado</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {lista.data?.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 transition hover:bg-brand-50/40">
                <td className="px-4 py-3 font-semibold">{c.nombre}</td>
                <td className="px-4 py-3 text-slate-500">{c.telefono ?? '—'}</td>
                <td className="px-4 py-3 text-slate-500">{c.tipoUnidad}</td>
                <td className="px-4 py-3 text-slate-500">{c.unidadHabitual ?? '—'}</td>
                <td className="px-4 py-3">
                  {c.activo ? <span className="chip-ok">activo</span> : <span className="chip-baja">baja</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm">
                  <button className="btn-sutil mr-3" onClick={() => setEditando(c)}>editar</button>
                  {c.activo && (
                    <Accion
                      texto="baja"
                      confirmar={`¿Dar de baja al conductor ${c.nombre}?`}
                      fn={() => bajaConductor(c.id)}
                      onListo={() => void refrescar()}
                      onError={setError}
                    />
                  )}
                </td>
              </tr>
            ))}
            {lista.data?.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin conductores. Da de alta el primero.</td></tr>
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

function Formulario(
  { inicial, tipos, unidades, onListo, onCancelar, onError }:
  {
    inicial?: ConductorDetalle;
    tipos: Tipo[];
    unidades: UnidadDetalle[];
    onListo: () => void;
    onCancelar?: () => void;
    onError: (m: string) => void;
  },
) {
  const editar = inicial !== undefined;
  const [f, setF] = useState({
    nombre: inicial?.nombre ?? '',
    telefono: inicial?.telefono ?? '',
    ineNumero: inicial?.ineNumero ?? '',
    contactoNombre: inicial?.contactoNombre ?? '',
    contactoTelefono: inicial?.contactoTelefono ?? '',
    tipoUnidadId: inicial?.tipoUnidadId ?? '',
    unidadHabitualId: inicial?.unidadHabitualId ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  // La unidad habitual solo puede ser del tipo elegido (el trigger lo exige).
  const unidadesDelTipo = useMemo(
    () => unidades.filter((u) => u.activo && u.tipoUnidadId === f.tipoUnidadId),
    [unidades, f.tipoUnidadId],
  );
  const unidadFueraDeTipo = f.unidadHabitualId !== '' && !unidadesDelTipo.some((u) => u.id === f.unidadHabitualId);

  const setTipo = (e: { target: { value: string } }) => {
    // Al cambiar el tipo, se limpia la unidad si ya no encaja.
    const nuevoTipo = e.target.value;
    const sigueValida = unidades.some((u) => u.id === f.unidadHabitualId && u.tipoUnidadId === nuevoTipo);
    setF({ ...f, tipoUnidadId: nuevoTipo, unidadHabitualId: sigueValida ? f.unidadHabitualId : '' });
  };

  const m = useMutation({
    mutationFn: () => {
      const payload = {
        nombre: f.nombre.trim(),
        telefono: f.telefono.trim() || null,
        ineNumero: f.ineNumero.trim() || null,
        contactoNombre: f.contactoNombre.trim() || null,
        contactoTelefono: f.contactoTelefono.trim() || null,
        tipoUnidadId: f.tipoUnidadId,
        unidadHabitualId: f.unidadHabitualId || null,
      };
      return editar ? editarConductor(inicial!.id, payload) : crearConductor(payload);
    },
    onSuccess: () => {
      if (!editar) {
        setF({
          nombre: '', telefono: '', ineNumero: '', contactoNombre: '', contactoTelefono: '',
          tipoUnidadId: f.tipoUnidadId, unidadHabitualId: '',
        });
      }
      onListo();
    },
    onError: (e) => onError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  const cuerpo = (
    <form onSubmit={enviar} className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
      <label>Nombre
        <input required value={f.nombre} onChange={set('nombre')} className="campo mt-1" />
      </label>
      <label>Teléfono
        <input value={f.telefono} onChange={set('telefono')} className="campo mt-1" placeholder="opcional" />
      </label>
      <label>Nº de INE
        <input value={f.ineNumero} onChange={set('ineNumero')} className="campo mt-1" placeholder="opcional" />
      </label>
      <label>Contacto de emergencia
        <input value={f.contactoNombre} onChange={set('contactoNombre')} className="campo mt-1" placeholder="opcional" />
      </label>
      <label>Teléfono del contacto
        <input value={f.contactoTelefono} onChange={set('contactoTelefono')} className="campo mt-1" placeholder="opcional" />
      </label>
      <div />
      <label>Tipo de unidad que maneja
        <select required value={f.tipoUnidadId} onChange={setTipo} className="campo mt-1">
          <option value="" disabled>Elegir…</option>
          {tipos.map((t) => <option key={t.id} value={t.id}>{t.clave} — {t.nombre}</option>)}
        </select>
      </label>
      <label>Unidad habitual
        <select
          value={f.unidadHabitualId}
          onChange={set('unidadHabitualId')}
          disabled={f.tipoUnidadId === ''}
          className="campo mt-1 disabled:opacity-50"
        >
          <option value="">Sin unidad fija</option>
          {unidadesDelTipo.map((u) => <option key={u.id} value={u.id}>{u.numeroEconomico}{u.placas ? ` · ${u.placas}` : ''}</option>)}
          {unidadFueraDeTipo && inicial?.unidadHabitualId && (
            <option value={inicial.unidadHabitualId}>{inicial.unidadHabitual} (otro tipo)</option>
          )}
        </select>
        {f.tipoUnidadId !== '' && unidadesDelTipo.length === 0 && (
          <span className="mt-1 block text-xs text-slate-400">No hay unidades de ese tipo. Se puede dejar sin unidad fija.</span>
        )}
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={m.isPending} className="btn-primario">
          {m.isPending ? 'Guardando…' : editar ? 'Guardar' : 'Crear conductor'}
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
        <div className="text-sm font-medium">Editar conductor: {inicial!.nombre}</div>
        {cuerpo}
      </div>
    );
  }
  return (
    <details className="tarjeta p-4">
      <summary className="cursor-pointer text-sm font-medium">+ Nuevo conductor</summary>
      {cuerpo}
    </details>
  );
}
