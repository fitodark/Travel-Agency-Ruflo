import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../../api/cliente';
import {
  bajaPunto, crearPunto, editarPunto, listarPuntos,
  type PuntoRuta,
} from '../../api/admin';

const msg = (e: unknown) => (e instanceof ErrorApi ? e.message : 'No se pudo completar la operación.');

/**
 * Catálogo de puntos de ruta (`core.punto_ruta`).
 *
 *   - Terminal — una sucursal real. Crear una aquí solo "asegura" su punto
 *     (idempotente): sirve para tenerla disponible al armar rutas.
 *   - Parada — un lugar de descenso sobre carretera. No es sucursal: lleva
 *     nombre, referencia y su propia zona horaria.
 */
export function AdminPuntos() {
  const qc = useQueryClient();
  const puntos = useQuery({ queryKey: ['admin', 'puntos'], queryFn: listarPuntos });
  const refrescar = () => qc.invalidateQueries({ queryKey: ['admin', 'puntos'] });
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<PuntoRuta | null>(null);

  const paradas = (puntos.data ?? []).filter((p) => p.tipo === 'parada');
  const terminales = (puntos.data ?? []).filter((p) => p.tipo === 'terminal');

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        Una <b>parada</b> es un punto de solo descenso sobre carretera (no es sucursal).
        Las <b>terminales</b> salen de las sucursales dadas de alta.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {editando
        ? <EditarParada key={editando.id} punto={editando} onListo={() => { setEditando(null); void refrescar(); }} onCancelar={() => setEditando(null)} onError={setError} />
        : <NuevaParada onCreada={() => void refrescar()} onError={setError} />}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-600">Paradas ({paradas.length})</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Nombre</th><th className="px-4 py-2.5">Municipio</th>
                <th className="px-4 py-2.5">Referencia</th><th className="px-4 py-2.5">Zona horaria</th>
                <th className="px-4 py-2.5">Estado</th><th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {paradas.map((p) => (
                <tr key={p.id} className="border-t border-slate-100 hover:bg-brand-50/40">
                  <td className="px-4 py-3 font-medium">{p.nombre}</td>
                  <td className="px-4 py-3 text-slate-600">{p.municipio ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-500">{p.referencia ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-500">{p.zonaHoraria}</td>
                  <td className="px-4 py-3">
                    {!p.activo ? <span className="chip-baja">baja</span>
                      : p.enUso ? <span className="chip-ok">en ruta</span>
                      : <span className="chip">libre</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {p.activo && (
                      <>
                        <button className="btn-sutil mr-3" onClick={() => setEditando(p)}>editar</button>
                        {!p.enUso && (
                          <button
                            className="btn-sutil"
                            onClick={() => {
                              if (window.confirm(`¿Dar de baja la parada "${p.nombre}"?`)) {
                                bajaPunto(p.id).then(() => void refrescar()).catch((e) => setError(msg(e)));
                              }
                            }}
                          >
                            baja
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {paradas.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin paradas.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-600">Terminales ({terminales.length})</h2>
        <p className="text-xs text-slate-400">
          {terminales.map((t) => t.nombre).join(' · ') || 'Ninguna — aparecen al usarlas en una ruta.'}
        </p>
      </div>
    </div>
  );
}

function NuevaParada({ onCreada, onError }: { onCreada: () => void; onError: (m: string) => void }) {
  const [nombre, setNombre] = useState('');
  const [municipio, setMunicipio] = useState('');
  const [referencia, setReferencia] = useState('');
  const [zonaHoraria, setZonaHoraria] = useState('America/Mexico_City');

  const m = useMutation({
    mutationFn: () => crearPunto({ tipo: 'parada', nombre, municipio, referencia, zonaHoraria }),
    onSuccess: () => { setNombre(''); setMunicipio(''); setReferencia(''); onCreada(); },
    onError: (e) => onError(msg(e)),
  });
  const enviar = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  return (
    <details className="tarjeta p-4">
      <summary className="cursor-pointer text-sm font-medium">+ Nueva parada</summary>
      <form onSubmit={enviar} className="mt-3 grid gap-3 sm:grid-cols-2 text-sm">
        <label>Nombre<input required value={nombre} onChange={(e) => setNombre(e.target.value)} className="campo mt-1" /></label>
        <label>Municipio<input value={municipio} onChange={(e) => setMunicipio(e.target.value)} className="campo mt-1" /></label>
        <label className="sm:col-span-2">Referencia
          <input value={referencia} onChange={(e) => setReferencia(e.target.value)} placeholder="p. ej. sobre carretera, a la altura del Home Depot" className="campo mt-1" />
        </label>
        <label>Zona horaria<input required value={zonaHoraria} onChange={(e) => setZonaHoraria(e.target.value)} className="campo mt-1" /></label>
        <button type="submit" disabled={m.isPending || !nombre.trim()} className="btn-primario justify-self-start self-end">
          {m.isPending ? 'Creando…' : 'Crear parada'}
        </button>
      </form>
    </details>
  );
}

function EditarParada(
  { punto, onListo, onCancelar, onError }:
  { punto: PuntoRuta; onListo: () => void; onCancelar: () => void; onError: (m: string) => void },
) {
  const [nombre, setNombre] = useState(punto.nombre);
  const [municipio, setMunicipio] = useState(punto.municipio ?? '');
  const [referencia, setReferencia] = useState(punto.referencia ?? '');
  const [zonaHoraria, setZonaHoraria] = useState(punto.zonaHoraria);

  const m = useMutation({
    mutationFn: () => editarPunto(punto.id, {
      nombre, municipio: municipio || null, referencia: referencia || null, zonaHoraria,
    }),
    onSuccess: onListo,
    onError: (e) => onError(msg(e)),
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="tarjeta grid gap-3 p-4 sm:grid-cols-2 text-sm">
      <div className="sm:col-span-2 font-medium">Editar {punto.tipo === 'terminal' ? 'terminal' : 'parada'}: {punto.nombre}</div>
      <label>Nombre<input required value={nombre} onChange={(e) => setNombre(e.target.value)} className="campo mt-1" disabled={punto.tipo === 'terminal'} /></label>
      <label>Municipio<input value={municipio} onChange={(e) => setMunicipio(e.target.value)} className="campo mt-1" /></label>
      <label className="sm:col-span-2">Referencia<input value={referencia} onChange={(e) => setReferencia(e.target.value)} className="campo mt-1" /></label>
      <label>Zona horaria<input required value={zonaHoraria} onChange={(e) => setZonaHoraria(e.target.value)} className="campo mt-1" /></label>
      {punto.tipo === 'terminal' && (
        <p className="sm:col-span-2 text-xs text-slate-400">
          El nombre de una terminal se cambia en Sucursales. Aquí solo su zona horaria operativa.
        </p>
      )}
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" disabled={m.isPending} className="btn-primario">{m.isPending ? 'Guardando…' : 'Guardar'}</button>
        <button type="button" onClick={onCancelar} className="rounded border px-4 py-1.5">Cancelar</button>
      </div>
    </form>
  );
}
