import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { crearCliente, listarClientes } from '../api/clientes';
import { ErrorApi } from '../api/cliente';

export function Clientes() {
  const qc = useQueryClient();
  const [busqueda, setBusqueda] = useState('');
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const lista = useQuery({
    queryKey: ['clientes', busqueda],
    queryFn: () => listarClientes(busqueda || undefined),
  });

  const alta = useMutation({
    mutationFn: crearCliente,
    onSuccess: () => {
      setNombre('');
      setTelefono('');
      setEmail('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['clientes'] });
    },
    onError: (e) => {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo registrar el cliente.');
    },
  });

  const registrar = (e: FormEvent) => {
    e.preventDefault();
    alta.mutate({
      nombre: nombre.trim(),
      ...(telefono.trim() ? { telefono: telefono.trim() } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
    });
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-xl font-semibold">Clientes</h1>

      <form onSubmit={registrar} className="rounded border bg-white p-4 grid grid-cols-4 gap-3 items-end">
        <label className="text-sm col-span-1">
          Nombre
          <input
            required
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        <label className="text-sm col-span-1">
          Teléfono
          <input
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        <label className="text-sm col-span-1">
          Correo
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={alta.isPending}
          className="rounded bg-slate-900 text-white py-2 text-sm disabled:opacity-50"
        >
          {alta.isPending ? 'Guardando…' : 'Registrar'}
        </button>
        {error && <p className="col-span-4 text-sm text-red-600">{error}</p>}
      </form>

      <div>
        <input
          placeholder="Buscar por nombre…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          className="w-full max-w-sm rounded border px-3 py-2 text-sm mb-3"
        />

        {lista.isLoading && <p className="text-sm text-slate-400">Cargando…</p>}
        {lista.isError && <p className="text-sm text-red-600">No se pudo cargar la lista.</p>}

        <table className="w-full text-sm bg-white rounded border overflow-hidden">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Teléfono</th>
              <th className="px-3 py-2">Correo</th>
              <th className="px-3 py-2">Registrado</th>
            </tr>
          </thead>
          <tbody>
            {lista.data?.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="px-3 py-2">{c.nombre}</td>
                <td className="px-3 py-2">{c.telefono ?? '—'}</td>
                <td className="px-3 py-2">{c.email ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400">
                  {new Date(c.creadoEn).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {lista.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-slate-400">
                  Sin resultados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
