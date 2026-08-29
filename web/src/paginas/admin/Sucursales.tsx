import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import {
  bajaSucursal, crearSucursal, editarSucursal, listarSucursales, regenerarHotp,
  type SucursalAdmin,
} from '../../api/admin';
import { useModo } from '../../componentes/admin/Modo';

const fecha = (s: string | null) => (s ? new Date(s).toLocaleString('es-MX') : '—');
const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo completar la operación.');

export function AdminSucursales() {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['admin', 'sucursales'], queryFn: listarSucursales });
  const refrescar = () => qc.invalidateQueries({ queryKey: ['admin', 'sucursales'] });
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<SucursalAdmin | null>(null);

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {editando ? (
        <EditarSucursal
          s={editando}
          onListo={() => { setEditando(null); void refrescar(); }}
          onCancelar={() => setEditando(null)}
          onError={setError}
        />
      ) : (
        <NuevaSucursal onCreada={() => void refrescar()} onError={setError} />
      )}

      {lista.isLoading && <p className="text-sm text-slate-400">Cargando…</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Cód.</th><th className="px-4 py-2.5">Nombre</th>
              <th className="px-4 py-2.5">Zona</th><th className="px-4 py-2.5">Vigencia</th>
              <th className="px-4 py-2.5">Estado</th><th className="px-4 py-2.5">HOTP</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {lista.data?.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 transition hover:bg-brand-50/40">
                <td className="px-4 py-3 font-semibold">{s.codigo}</td>
                <td className="px-4 py-3">{s.nombre}</td>
                <td className="px-4 py-3 text-slate-500">{s.zonaHoraria}</td>
                <td className="px-4 py-3 text-slate-500">
                  {fecha(s.effectiveFrom)}{s.effectiveUntil ? ` → ${fecha(s.effectiveUntil)}` : ''}
                </td>
                <td className="px-4 py-3">
                  {s.activo
                    ? <span className="chip-ok">activa</span>
                    : <span className="chip-baja">baja</span>}
                </td>
                <td className="px-4 py-3">{s.tieneHotp ? 'sí' : <span className="text-red-600">falta</span>}</td>
                <td className="px-4 py-3 whitespace-nowrap text-sm">
                  <button className="btn-sutil mr-3" onClick={() => setEditando(s)}>editar</button>
                  {s.activo && (
                    <AccionFila
                      texto="baja" confirmar="¿Dar de baja esta sucursal? (efecto inmediato)"
                      fn={() => bajaSucursal(s.id)} onListo={() => void refrescar()} onError={setError}
                    />
                  )}
                  <AccionFila
                    texto="regenerar HOTP"
                    confirmar="Regenerar la semilla invalida los códigos de revocación viejos. ¿Continuar?"
                    fn={() => regenerarHotp(s.id)} onListo={() => void refrescar()} onError={setError}
                  />
                </td>
              </tr>
            ))}
            {lista.data?.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Sin sucursales.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccionFila(
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

function NuevaSucursal({ onCreada, onError }: { onCreada: () => void; onError: (m: string) => void }) {
  const modo = useModo();
  const [f, setF] = useState({ nombre: '', direccionCompleta: '', telefonoPrincipal: '', zonaHoraria: 'America/Mexico_City', codigo: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => crearSucursal({
      nombre: f.nombre, direccionCompleta: f.direccionCompleta, telefonoPrincipal: f.telefonoPrincipal,
      zonaHoraria: f.zonaHoraria, ...(f.codigo ? { codigo: f.codigo } : {}), ...modo.valor(),
    }),
    onSuccess: () => { setF({ ...f, nombre: '', direccionCompleta: '', telefonoPrincipal: '', codigo: '' }); onCreada(); },
    onError: (e) => onError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  return (
    <details className="tarjeta p-4">
      <summary className="cursor-pointer text-sm font-medium">+ Nueva sucursal</summary>
      <form onSubmit={enviar} className="mt-3 grid gap-3 sm:grid-cols-2 text-sm">
        <label>Nombre<input required value={f.nombre} onChange={set('nombre')} className="campo mt-1" /></label>
        <label>Dirección completa<input required value={f.direccionCompleta} onChange={set('direccionCompleta')} className="campo mt-1" /></label>
        <label>Teléfono<input required value={f.telefonoPrincipal} onChange={set('telefonoPrincipal')} className="campo mt-1" /></label>
        <label>Zona horaria<input value={f.zonaHoraria} onChange={set('zonaHoraria')} className="campo mt-1" /></label>
        <label>Código (opcional)<input maxLength={1} placeholder="auto" value={f.codigo} onChange={set('codigo')} className="campo mt-1" /></label>
        <div className="sm:col-span-2">{modo.nodo}</div>
        <button type="submit" disabled={m.isPending} className="btn-primario justify-self-start">
          {m.isPending ? 'Creando…' : 'Crear'}
        </button>
      </form>
    </details>
  );
}

function EditarSucursal(
  { s, onListo, onCancelar, onError }:
  { s: SucursalAdmin; onListo: () => void; onCancelar: () => void; onError: (m: string) => void },
) {
  const modo = useModo();
  const [f, setF] = useState({
    nombre: s.nombre, direccionCompleta: s.direccionCompleta ?? '',
    telefonoPrincipal: s.telefonoPrincipal ?? '', zonaHoraria: s.zonaHoraria,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => editarSucursal(s.id, { ...f, ...modo.valor() }),
    onSuccess: onListo,
    onError: (e) => onError(msg(e)),
  });

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); m.mutate(); }}
      className="tarjeta p-4 grid gap-3 sm:grid-cols-2 text-sm"
    >
      <div className="sm:col-span-2 font-medium">Editar sucursal {s.codigo}</div>
      <label>Nombre<input value={f.nombre} onChange={set('nombre')} className="campo mt-1" /></label>
      <label>Dirección<input value={f.direccionCompleta} onChange={set('direccionCompleta')} className="campo mt-1" /></label>
      <label>Teléfono<input value={f.telefonoPrincipal} onChange={set('telefonoPrincipal')} className="campo mt-1" /></label>
      <label>Zona horaria<input value={f.zonaHoraria} onChange={set('zonaHoraria')} className="campo mt-1" /></label>
      <div className="sm:col-span-2">{modo.nodo}</div>
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" disabled={m.isPending} className="btn-primario">Guardar</button>
        <button type="button" onClick={onCancelar} className="rounded border px-4 py-1.5">Cancelar</button>
      </div>
    </form>
  );
}
