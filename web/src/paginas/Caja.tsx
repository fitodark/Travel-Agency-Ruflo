import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import {
  abrirCorte, anularMovimiento, cerrarCorte, corteAbierto, movimientos, registrarEgreso,
  type CierreCorte,
} from '../api/caja';
import { useSesion } from '../auth/sesion';

function Cifra({ etiqueta, valor, fuerte }: { etiqueta: string; valor: number; fuerte?: boolean }) {
  return (
    <div className="tarjeta p-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{etiqueta}</div>
      <div className={`mt-1 ${fuerte ? 'text-lg font-semibold' : 'text-base'}`}>${valor}</div>
    </div>
  );
}

export function Caja() {
  const qc = useQueryClient();
  const { puede } = useSesion();
  const [error, setError] = useState<string | null>(null);

  const corte = useQuery({ queryKey: ['caja', 'corte'], queryFn: corteAbierto });

  const invalidar = () => qc.invalidateQueries({ queryKey: ['caja'] });
  const alError = (e: unknown) =>
    setError(e instanceof ErrorApi ? e.message : 'Operación fallida.');

  if (corte.isLoading) return <p className="text-sm text-slate-400">Cargando…</p>;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">Caja</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!corte.data ? (
        <AbrirCorte onListo={() => { setError(null); void invalidar(); }} onError={alError} />
      ) : (
        <CorteAbiertoVista
          corteId={corte.data.corteId}
          saldo={corte.data}
          puedeAnular={puede('movimiento.anular')}
          onCambio={() => { setError(null); void invalidar(); }}
          onError={alError}
        />
      )}
    </div>
  );
}

function AbrirCorte({ onListo, onError }: { onListo: () => void; onError: (e: unknown) => void }) {
  const [saldo, setSaldo] = useState('0');
  const m = useMutation({
    mutationFn: () => abrirCorte(Number(saldo)),
    onSuccess: onListo,
    onError,
  });
  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}
      className="tarjeta p-4 space-y-3"
    >
      <p className="text-sm text-slate-500">No hay corte abierto en esta sucursal.</p>
      <label className="block text-sm">
        Saldo inicial (efectivo para dar cambio)
        <input
          type="number"
          min={0}
          value={saldo}
          onChange={(e) => setSaldo(e.target.value)}
          className="mt-1 w-48 rounded border px-3 py-2"
        />
      </label>
      <button
        type="submit"
        disabled={m.isPending}
        className="btn-primario"
      >
        Abrir corte
      </button>
    </form>
  );
}

function CorteAbiertoVista({
  corteId, saldo, puedeAnular, onCambio, onError,
}: {
  corteId: string;
  saldo: { saldoInicial: number; ingresos: number; egresos: number; saldoCalculado: number };
  puedeAnular: boolean;
  onCambio: () => void;
  onError: (e: unknown) => void;
}) {
  const movs = useQuery({
    queryKey: ['caja', 'movimientos', corteId],
    queryFn: () => movimientos(corteId),
  });

  const [monto, setMonto] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [declarado, setDeclarado] = useState('');
  const [cierre, setCierre] = useState<CierreCorte | null>(null);

  const egreso = useMutation({
    mutationFn: () => registrarEgreso(corteId, { monto: Number(monto), descripcion }),
    onSuccess: () => { setMonto(''); setDescripcion(''); onCambio(); },
    onError,
  });

  const anular = useMutation({
    mutationFn: (id: string) => anularMovimiento(id, 'anulado desde caja'),
    onSuccess: onCambio,
    onError,
  });

  const cerrar = useMutation({
    mutationFn: () => cerrarCorte(corteId, Number(declarado)),
    onSuccess: (c) => { setCierre(c); onCambio(); },
    onError,
  });

  if (cierre) {
    return (
      <div className="rounded border border-green-300 bg-green-50 p-4 text-sm space-y-1">
        <div className="font-semibold">Corte cerrado</div>
        <div>Calculado: ${cierre.saldoCalculado} · declarado: ${cierre.saldoDeclarado}</div>
        <div className={cierre.diferencia === 0 ? '' : 'text-red-700'}>
          Diferencia: ${cierre.diferencia}
          {cierre.diferencia > 0 && ' (sobra)'}
          {cierre.diferencia < 0 && ' (falta)'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-3">
        <Cifra etiqueta="Inicial" valor={saldo.saldoInicial} />
        <Cifra etiqueta="Ingresos" valor={saldo.ingresos} />
        <Cifra etiqueta="Egresos" valor={saldo.egresos} />
        <Cifra etiqueta="En caja" valor={saldo.saldoCalculado} fuerte />
      </div>

      <form
        onSubmit={(e: FormEvent) => { e.preventDefault(); egreso.mutate(); }}
        className="tarjeta p-4 flex gap-3 items-end"
      >
        <label className="text-sm">
          Monto
          <input
            type="number" min={0.01} step="0.01" required
            value={monto} onChange={(e) => setMonto(e.target.value)}
            className="mt-1 w-28 rounded border px-3 py-2"
          />
        </label>
        <label className="text-sm flex-1">
          Descripción del gasto
          <input
            required maxLength={500}
            value={descripcion} onChange={(e) => setDescripcion(e.target.value)}
            className="campo mt-1"
          />
        </label>
        <button
          type="submit"
          disabled={egreso.isPending}
          className="btn-primario"
        >
          Registrar egreso
        </button>
      </form>

      <div>
        <h2 className="text-sm font-semibold text-slate-600 mb-2">Movimientos</h2>
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Tipo</th>
              <th className="px-4 py-2.5">Concepto</th>
              <th className="px-3 py-2 text-right">Monto</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {movs.data?.map((m) => (
              <tr key={m.id} className={`border-t ${m.activo ? '' : 'text-slate-400 line-through'}`}>
                <td className="px-4 py-3">{m.tipo}</td>
                <td className="px-4 py-3">{m.descripcion ?? m.origenTipo}</td>
                <td className="px-4 py-3 text-right">${m.monto}</td>
                <td className="px-4 py-3 text-right">
                  {m.activo && m.tipo === 'egreso' && puedeAnular && (
                    <button
                      onClick={() => anular.mutate(m.id)}
                      className="text-xs text-red-600 underline"
                    >
                      anular
                    </button>
                  )}
                  {!m.activo && <span className="text-xs">anulado</span>}
                </td>
              </tr>
            ))}
            {movs.data?.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Sin movimientos.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <form
        onSubmit={(e: FormEvent) => { e.preventDefault(); cerrar.mutate(); }}
        className="tarjeta p-4 flex gap-3 items-end"
      >
        <label className="text-sm">
          Saldo declarado (efectivo contado)
          <input
            type="number" min={0} step="0.01" required
            value={declarado} onChange={(e) => setDeclarado(e.target.value)}
            className="mt-1 w-40 rounded border px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={cerrar.isPending}
          className="rounded border border-slate-900 px-4 py-2 text-sm disabled:opacity-50"
        >
          Cerrar corte / turno
        </button>
      </form>
    </div>
  );
}
