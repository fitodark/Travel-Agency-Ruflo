import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import {
  abrirCorte, anularMovimiento, cerrarCorte, corteAbierto, historialCortes, movimientos,
  registrarEgreso, type CierreCorte, type CorteHistorial,
} from '../api/caja';
import { useSesion } from '../auth/sesion';
import { fechaHora } from '../lib/fechas';

const dinero = (n: number | null) => (n === null ? '—' : `$${n}`);

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
  // `RequiereCorte` manda aquí desde `/vender` cuando no hay corte abierto.
  const vinoDeVender = (useLocation().state as { avisoCorte?: boolean } | null)?.avisoCorte === true;

  const corte = useQuery({ queryKey: ['caja', 'corte'], queryFn: corteAbierto });

  const invalidar = () => qc.invalidateQueries({ queryKey: ['caja'] });
  const alError = (e: unknown) =>
    setError(e instanceof ErrorApi ? e.message : 'Operación fallida.');

  if (corte.isLoading) return <p className="text-sm text-slate-400">Cargando…</p>;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">Caja</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {vinoDeVender && !corte.data && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Para vender boletos primero abre el corte de caja del día.
        </p>
      )}

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

      <HistorialCortes />
    </div>
  );
}

/**
 * Historial de cortes. La API filtra por rol según la sesión: el administrador
 * ve todas las sucursales; el gerente, la suya; el vendedor, solo los que abrió.
 */
function HistorialCortes() {
  const { sesion } = useSesion();
  const esAdmin = sesion?.rol === 'administrador';
  const q = useQuery({ queryKey: ['caja', 'historial'], queryFn: () => historialCortes() });
  const [abierto, setAbierto] = useState<string | null>(null);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-600">Historial de cortes</h2>
      {q.isLoading && <p className="text-sm text-slate-400">Cargando…</p>}
      {q.data?.length === 0 && (
        <p className="text-sm text-slate-400">Aún no hay cortes que puedas ver.</p>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              {esAdmin && <th className="px-4 py-2.5">Sucursal</th>}
              <th className="px-4 py-2.5">Abierto</th>
              <th className="px-4 py-2.5">Cerrado</th>
              <th className="px-4 py-2.5">Abrió</th>
              <th className="px-3 py-2 text-right">Inicial</th>
              <th className="px-3 py-2 text-right">Ingresos</th>
              <th className="px-3 py-2 text-right">Egresos</th>
              <th className="px-3 py-2 text-right">Calculado</th>
              <th className="px-3 py-2 text-right">Declarado</th>
              <th className="px-3 py-2 text-right">Diferencia</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {q.data?.map((c) => (
              <FilaCorte
                key={c.corteId}
                c={c}
                esAdmin={esAdmin}
                abierto={abierto === c.corteId}
                onToggle={() => setAbierto((a) => (a === c.corteId ? null : c.corteId))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FilaCorte({
  c, esAdmin, abierto, onToggle,
}: { c: CorteHistorial; esAdmin: boolean; abierto: boolean; onToggle: () => void }) {
  const cols = esAdmin ? 11 : 10;
  const dif = c.diferencia;
  return (
    <>
      <tr className="border-t border-slate-100">
        {esAdmin && <td className="px-4 py-3">{c.sucursal}</td>}
        <td className="px-4 py-3 whitespace-nowrap">{fechaHora(c.abiertoEn)}</td>
        <td className="px-4 py-3 whitespace-nowrap">
          {c.cerradoEn ? fechaHora(c.cerradoEn) : <span className="chip-ok">abierto</span>}
        </td>
        <td className="px-4 py-3">{c.usuarioApertura}</td>
        <td className="px-3 py-3 text-right">${c.saldoInicial}</td>
        <td className="px-3 py-3 text-right">${c.ingresos}</td>
        <td className="px-3 py-3 text-right">${c.egresos}</td>
        <td className="px-3 py-3 text-right">${c.saldoCalculado}</td>
        <td className="px-3 py-3 text-right">{dinero(c.saldoDeclarado)}</td>
        <td className={`px-3 py-3 text-right ${dif && dif !== 0 ? 'text-red-700' : ''}`}>
          {dif === null ? '—' : `$${dif}${dif > 0 ? ' (sobra)' : dif < 0 ? ' (falta)' : ''}`}
        </td>
        <td className="px-4 py-3 text-right">
          <button className="btn-sutil text-xs" onClick={onToggle}>
            {abierto ? 'ocultar' : 'movimientos'}
          </button>
        </td>
      </tr>
      {abierto && (
        <tr>
          <td colSpan={cols} className="bg-slate-50/60 px-4 py-3">
            <MovimientosDeCorte corteId={c.corteId} />
          </td>
        </tr>
      )}
    </>
  );
}

function MovimientosDeCorte({ corteId }: { corteId: string }) {
  const q = useQuery({
    queryKey: ['caja', 'movimientos', corteId],
    queryFn: () => movimientos(corteId),
  });

  if (q.isLoading) return <p className="text-sm text-slate-400">Cargando…</p>;
  if (q.isError) {
    return (
      <p className="text-sm text-slate-500">
        {q.error instanceof ErrorApi && q.error.status === 403
          ? 'No tienes permiso para ver el detalle de este corte.'
          : 'No se pudieron cargar los movimientos.'}
      </p>
    );
  }
  if (!q.data?.length) return <p className="text-sm text-slate-400">Sin movimientos.</p>;

  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
        <tr>
          <th className="py-1.5 pr-4">Fecha</th>
          <th className="py-1.5 pr-4">Tipo</th>
          <th className="py-1.5 pr-4">Concepto</th>
          <th className="py-1.5 text-right">Monto</th>
        </tr>
      </thead>
      <tbody>
        {q.data.map((m) => (
          <tr key={m.id} className={`border-t border-slate-200 ${m.activo ? '' : 'text-slate-400 line-through'}`}>
            <td className="py-1.5 pr-4 whitespace-nowrap">{fechaHora(m.registradoEn)}</td>
            <td className="py-1.5 pr-4">{m.tipo}</td>
            <td className="py-1.5 pr-4">{m.descripcion ?? m.origenTipo}</td>
            <td className="py-1.5 text-right">${m.monto}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
        {movs.isError ? (
          <p className="text-sm text-slate-500">
            {movs.error instanceof ErrorApi && movs.error.status === 403
              ? 'El detalle de movimientos lo ve quien abrió el corte, un gerente o un administrador.'
              : 'No se pudieron cargar los movimientos.'}
          </p>
        ) : (
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
        )}
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
