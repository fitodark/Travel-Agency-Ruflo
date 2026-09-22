import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { crearCliente, listarClientes, type Cliente } from '../../api/clientes';
import { ErrorApi } from '../../api/cliente';

/**
 * Buscar o dar de alta al cliente que deja un anticipo (Ses. 71): el nombre
 * que etiqueta el abono, que no necesariamente es quien viaja. Reusa el
 * catálogo `core.cliente` (F2c) — no hay entidad nueva aquí, solo el widget.
 */
export function SelectorCliente({
  clienteId,
  clienteNombre,
  onSeleccionar,
  telefonoSugerido,
}: {
  clienteId: string | null;
  clienteNombre: string;
  onSeleccionar: (cliente: Cliente | null) => void;
  /** Teléfono ya capturado en el paso (contacto), para precargar el alta rápida. */
  telefonoSugerido?: string;
}) {
  const qc = useQueryClient();
  const [busqueda, setBusqueda] = useState('');
  const [error, setError] = useState<string | null>(null);

  const resultados = useQuery({
    queryKey: ['clientes', 'buscar', busqueda],
    queryFn: () => listarClientes(busqueda),
    enabled: busqueda.trim().length >= 2,
  });

  const alta = useMutation({
    mutationFn: crearCliente,
    onSuccess: (c) => {
      onSeleccionar(c);
      setBusqueda('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['clientes'] });
    },
    onError: (e) => {
      setError(e instanceof ErrorApi ? e.message : 'No se pudo registrar el cliente.');
    },
  });

  if (clienteId) {
    return (
      <div className="flex items-center justify-between rounded-sm border border-slate-300 bg-slate-50 px-3 py-2 text-sm">
        <span className="font-medium text-slate-800">{clienteNombre}</span>
        <button
          type="button"
          onClick={() => onSeleccionar(null)}
          className="text-xs text-slate-500 underline"
        >
          Cambiar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <input
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder="Buscar cliente por nombre…"
        className="campo rounded-sm"
      />
      {busqueda.trim().length >= 2 && (
        <div className="max-h-40 overflow-y-auto rounded-sm border border-slate-200 bg-white text-sm shadow-sm">
          {resultados.isLoading && <p className="px-3 py-2 text-slate-400">Buscando…</p>}
          {resultados.data?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSeleccionar(c)}
              className="block w-full px-3 py-2 text-left hover:bg-brand-50"
            >
              {c.nombre}{c.telefono ? ` · ${c.telefono}` : ''}
            </button>
          ))}
          {resultados.data?.length === 0 && (
            <button
              type="button"
              disabled={alta.isPending}
              onClick={() => alta.mutate({
                nombre: busqueda.trim(),
                ...(telefonoSugerido?.trim() ? { telefono: telefonoSugerido.trim() } : {}),
              })}
              className="block w-full px-3 py-2 text-left text-brand-700 hover:bg-brand-50"
            >
              {alta.isPending ? 'Registrando…' : `+ Registrar "${busqueda.trim()}" como nuevo cliente`}
            </button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
