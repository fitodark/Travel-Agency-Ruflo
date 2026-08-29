import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import {
  asignarSucursal, bajaUsuario, codigoRevocacion, crearUsuario, editarUsuario, listarSucursales,
  listarUsuarios, quitarSucursal, restablecerPassword, type UsuarioAdmin,
} from '../../api/admin';
import { useModo } from '../../componentes/admin/Modo';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo completar la operación.');
const ROLES = ['vendedor', 'gerente', 'administrador'] as const;

export function AdminUsuarios() {
  const qc = useQueryClient();
  const usuarios = useQuery({ queryKey: ['admin', 'usuarios'], queryFn: listarUsuarios });
  const sucursales = useQuery({ queryKey: ['admin', 'sucursales'], queryFn: listarSucursales });
  const refrescar = () => qc.invalidateQueries({ queryKey: ['admin', 'usuarios'] });
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [edit, setEdit] = useState<UsuarioAdmin | null>(null);
  const [accesos, setAccesos] = useState<UsuarioAdmin | null>(null);

  const sucsActivas = (sucursales.data ?? []).filter((s) => s.activo);

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {banner && (
        <div className="rounded border border-blue-300 bg-blue-50 px-4 py-2 text-sm text-blue-900 flex justify-between">
          <span>{banner}</span>
          <button className="underline" onClick={() => setBanner(null)}>cerrar</button>
        </div>
      )}

      {edit ? (
        <EditarUsuario u={edit} onListo={() => { setEdit(null); void refrescar(); }} onCancelar={() => setEdit(null)} onError={setError} />
      ) : accesos ? (
        <Accesos
          u={accesos} sucursales={sucsActivas}
          onCambio={() => { void qc.invalidateQueries({ queryKey: ['admin', 'usuarios'] }); }}
          onVolver={() => setAccesos(null)} onError={setError}
        />
      ) : (
        <NuevoUsuario
          sucursales={sucsActivas}
          onCreado={(pw) => { setBanner(`Contraseña temporal: ${pw} — comunícala al usuario.`); void refrescar(); }}
          onError={setError}
        />
      )}

      {usuarios.isLoading && <p className="text-sm text-slate-400">Cargando…</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Nombre</th><th className="px-4 py-2.5">Rol</th>
              <th className="px-4 py-2.5">Sucursales</th><th className="px-4 py-2.5">Credencial</th>
              <th className="px-4 py-2.5">Estado</th><th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {usuarios.data?.map((u) => (
              <tr key={u.id} className="border-t border-slate-100 align-top transition hover:bg-brand-50/40">
                <td className="px-4 py-3">{u.nombre}<br /><span className="text-slate-400 text-xs">{u.email}</span></td>
                <td className="px-4 py-3">{u.rol}</td>
                <td className="px-4 py-3">
                  {u.sucursales.filter((s) => s.activa).map((s) => (
                    <span key={s.id} className="inline-block chip-baja mr-1">{s.codigo}</span>
                  ))}
                  {u.sucursales.filter((s) => s.activa).length === 0 && <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-3">
                  {!u.tieneCredencial ? <span className="text-red-600">falta</span>
                    : u.debeCambiarPassword ? <span className="chip-alerta">temporal</span>
                    : 'ok'}
                </td>
                <td className="px-4 py-3">
                  {u.activo
                    ? <span className="chip-ok">alta</span>
                    : <span className="chip-baja">baja</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm">
                  <button className="btn-sutil mr-3" onClick={() => setEdit(u)}>editar</button>
                  <button className="btn-sutil mr-3" onClick={() => setAccesos(u)}>sucursales</button>
                  <AccionFila texto="contraseña" confirmar="¿Generar una contraseña temporal nueva?"
                    fn={() => restablecerPassword(u.id)}
                    onOk={(r) => setBanner(`Nueva contraseña temporal: ${(r as { passwordTemporal: string }).passwordTemporal}`)}
                    onError={setError} />
                  {u.activo && (
                    <AccionFila texto="baja" confirmar="¿Dar de baja este usuario? Se cierra su sesión de inmediato."
                      fn={() => bajaUsuario(u.id)} onOk={() => void refrescar()} onError={setError} />
                  )}
                  <RevocacionBoton u={u} sucursales={u.sucursales} onCodigo={(c) => setBanner(`Dicta este código por teléfono al gerente: ${c}`)} onError={setError} />
                </td>
              </tr>
            ))}
            {usuarios.data?.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin usuarios.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccionFila(
  { texto, confirmar, fn, onOk, onError }:
  { texto: string; confirmar: string; fn: () => Promise<unknown>; onOk: (r: unknown) => void; onError: (m: string) => void },
) {
  const m = useMutation({ mutationFn: fn, onSuccess: onOk, onError: (e) => onError(msg(e)) });
  return (
    <button className="btn-sutil mr-3 disabled:opacity-50" disabled={m.isPending}
      onClick={() => { if (window.confirm(confirmar)) m.mutate(); }}>{texto}</button>
  );
}

function RevocacionBoton(
  { u, sucursales, onCodigo, onError }:
  { u: UsuarioAdmin; sucursales: UsuarioAdmin['sucursales']; onCodigo: (c: string) => void; onError: (m: string) => void },
) {
  const [abierto, setAbierto] = useState(false);
  const [sucursalId, setSucursalId] = useState(sucursales[0]?.id ?? '');
  const m = useMutation({
    mutationFn: () => codigoRevocacion(u.id, sucursalId),
    onSuccess: (r) => { onCodigo(r.codigo); setAbierto(false); },
    onError: (e) => onError(msg(e)),
  });
  if (!abierto) {
    return <button className="btn-sutil" onClick={() => setAbierto(true)}>código revocación</button>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <select value={sucursalId} onChange={(e) => setSucursalId(e.target.value)} className="campo-sm">
        {sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo}</option>)}
      </select>
      <button className="btn-sutil" disabled={m.isPending || !sucursalId} onClick={() => m.mutate()}>generar</button>
      <button className="underline text-slate-400" onClick={() => setAbierto(false)}>×</button>
    </span>
  );
}

function NuevoUsuario(
  { sucursales, onCreado, onError }:
  { sucursales: { id: string; codigo: string; nombre: string }[]; onCreado: (pw: string) => void; onError: (m: string) => void },
) {
  const modo = useModo();
  const [f, setF] = useState({ nombre: '', email: '', rol: 'vendedor', telefono: '' });
  const [sucs, setSucs] = useState<string[]>([]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => crearUsuario({
      nombre: f.nombre, email: f.email, rol: f.rol, ...(f.telefono ? { telefono: f.telefono } : {}),
      sucursalIds: sucs, ...modo.valor(),
    }),
    onSuccess: (r) => { setF({ nombre: '', email: '', rol: 'vendedor', telefono: '' }); setSucs([]); onCreado(r.passwordTemporal); },
    onError: (e) => onError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  return (
    <details className="tarjeta p-4">
      <summary className="cursor-pointer text-sm font-medium">+ Nuevo usuario</summary>
      <form onSubmit={enviar} className="mt-3 grid gap-3 sm:grid-cols-2 text-sm">
        <label>Nombre<input required value={f.nombre} onChange={set('nombre')} className="campo mt-1" /></label>
        <label>Correo<input required type="email" value={f.email} onChange={set('email')} className="campo mt-1" /></label>
        <label>Rol
          <select value={f.rol} onChange={set('rol')} className="campo mt-1">
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label>Teléfono<input value={f.telefono} onChange={set('telefono')} className="campo mt-1" /></label>
        <div className="sm:col-span-2">
          <span className="text-slate-500">Sucursales</span>
          <div className="mt-1 flex flex-wrap gap-3">
            {sucursales.map((s) => (
              <label key={s.id} className="flex items-center gap-1 font-normal">
                <input type="checkbox" checked={sucs.includes(s.id)}
                  onChange={(e) => setSucs(e.target.checked ? [...sucs, s.id] : sucs.filter((x) => x !== s.id))} />
                {s.codigo} {s.nombre}
              </label>
            ))}
            {sucursales.length === 0 && <span className="text-slate-400">no hay sucursales activas</span>}
          </div>
        </div>
        <div className="sm:col-span-2">{modo.nodo}</div>
        <button type="submit" disabled={m.isPending} className="btn-primario justify-self-start">
          {m.isPending ? 'Creando…' : 'Crear'}
        </button>
      </form>
    </details>
  );
}

function EditarUsuario(
  { u, onListo, onCancelar, onError }:
  { u: UsuarioAdmin; onListo: () => void; onCancelar: () => void; onError: (m: string) => void },
) {
  const modo = useModo();
  const [f, setF] = useState({ nombre: u.nombre, rol: u.rol as string, telefono: u.telefono ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => editarUsuario(u.id, { nombre: f.nombre, rol: f.rol, telefono: f.telefono || null, ...modo.valor() }),
    onSuccess: onListo,
    onError: (e) => onError(msg(e)),
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="tarjeta p-4 grid gap-3 sm:grid-cols-2 text-sm">
      <div className="sm:col-span-2 font-medium">Editar {u.nombre}</div>
      <label>Nombre<input value={f.nombre} onChange={set('nombre')} className="campo mt-1" /></label>
      <label>Rol
        <select value={f.rol} onChange={set('rol')} className="campo mt-1">
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label>Teléfono<input value={f.telefono} onChange={set('telefono')} className="campo mt-1" /></label>
      <div className="sm:col-span-2">{modo.nodo}</div>
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" disabled={m.isPending} className="btn-primario">Guardar</button>
        <button type="button" onClick={onCancelar} className="rounded border px-4 py-1.5">Cancelar</button>
      </div>
    </form>
  );
}

function Accesos(
  { u, sucursales, onCambio, onVolver, onError }:
  {
    u: UsuarioAdmin; sucursales: { id: string; codigo: string; nombre: string }[];
    onCambio: () => void; onVolver: () => void; onError: (m: string) => void;
  },
) {
  const qc = useQueryClient();
  const asignadas = new Set(u.sucursales.filter((s) => s.activa).map((s) => s.id));
  const toggle = useMutation({
    mutationFn: ({ id, quitar }: { id: string; quitar: boolean }) =>
      quitar ? quitarSucursal(u.id, id) : asignarSucursal(u.id, id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'usuarios'] }); onCambio(); },
    onError: (e) => onError(msg(e)),
  });
  return (
    <div className="tarjeta p-4 space-y-3">
      <button className="btn-sutil text-sm" onClick={onVolver}>← volver</button>
      <p className="font-medium">Sucursales de {u.nombre}</p>
      <ul className="space-y-1 text-sm">
        {sucursales.map((s) => (
          <li key={s.id} className="flex items-center gap-3">
            <span className="w-48"><b>{s.codigo}</b> {s.nombre}</span>
            <button
              className="btn-sutil disabled:opacity-50"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ id: s.id, quitar: asignadas.has(s.id) })}
            >
              {asignadas.has(s.id) ? 'quitar' : 'asignar'}
            </button>
          </li>
        ))}
        {sucursales.length === 0 && <li className="text-slate-400">No hay sucursales activas.</li>}
      </ul>
    </div>
  );
}
