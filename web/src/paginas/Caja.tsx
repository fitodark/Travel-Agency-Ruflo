import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import {
  abrirCorte, anularMovimiento, cerrarCorte,
  confirmarTransferencia, corteAbierto,
  movimientos, registrarEgreso, transferenciasPorVerificar,
  type CierreCorte, type CorteAbierto,
} from '../api/caja';
import { RequiereSucursal } from '../componentes/RequiereSucursal';
import { useSesion } from '../auth/sesion';
import { fechaHora } from '../lib/fechas';

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
  const { sesion, puede } = useSesion();
  const [error, setError] = useState<string | null>(null);
  // `RequiereCorte` manda aquí desde `/vender` cuando no hay corte abierto.
  const vinoDeVender = (useLocation().state as { avisoCorte?: boolean } | null)?.avisoCorte === true;
  const sinSucursal = !sesion?.sucursalId;

  const corte = useQuery({
    queryKey: ['caja', 'corte'], queryFn: corteAbierto, enabled: !sinSucursal,
  });

  const invalidar = () => qc.invalidateQueries({ queryKey: ['caja'] });
  const alError = (e: unknown) =>
    setError(e instanceof ErrorApi ? e.message : 'Operación fallida.');

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">Caja</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {sinSucursal ? (
        <RequiereSucursal>{null}</RequiereSucursal>
      ) : corte.isLoading ? (
        <p className="text-sm text-slate-400">Cargando…</p>
      ) : (
        <>
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

          <TransferenciasPorVerificar
            hayCorte={!!corte.data}
            onCambio={() => { setError(null); void invalidar(); }}
            onError={alError}
          />
        </>
      )}
    </div>
  );
}

/**
 * Cola del encargado (0065): transferencias registradas en esta sucursal cuyo
 * comprobante aún no se confirma. Al confirmar, el monto entra al corte abierto
 * en ese momento (no al de cuando se vendió) — de ahí que necesite un corte
 * abierto. La puede confirmar quien vendió o un gerente/administrador.
 */
function TransferenciasPorVerificar({
  hayCorte, onCambio, onError,
}: { hayCorte: boolean; onCambio: () => void; onError: (e: unknown) => void }) {
  const q = useQuery({
    queryKey: ['caja', 'transferencias'],
    queryFn: transferenciasPorVerificar,
  });
  const confirmar = useMutation({
    mutationFn: (pagoId: string) => confirmarTransferencia(pagoId),
    onSuccess: onCambio,
    onError,
  });

  if (!q.data || q.data.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-600">
        Transferencias por verificar ({q.data.length})
      </h2>
      {!hayCorte && (
        <p className="text-xs text-amber-700">
          Abre el corte de caja para poder confirmar: el monto entra al corte abierto.
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Registrada</th>
              <th className="px-4 py-2.5">Folio</th>
              <th className="px-4 py-2.5">Pasajero</th>
              <th className="px-4 py-2.5">Vendió</th>
              <th className="px-4 py-2.5">Referencia</th>
              <th className="px-3 py-2 text-right">Monto</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {q.data.map((t) => (
              <tr key={t.pagoId} className="border-t border-slate-100">
                <td className="px-4 py-3 whitespace-nowrap">{fechaHora(t.registradoEn)}</td>
                <td className="px-4 py-3 font-mono">{t.folio ?? '—'}</td>
                <td className="px-4 py-3">{t.pasajero ?? '—'}</td>
                <td className="px-4 py-3">{t.vendedor}</td>
                <td className="px-4 py-3">{t.referencia ?? '—'}</td>
                <td className="px-3 py-3 text-right">${t.monto}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    className="btn-primario px-3 py-1 text-xs"
                    disabled={!hayCorte || confirmar.isPending}
                    onClick={() => confirmar.mutate(t.pagoId)}
                  >
                    Confirmar pago
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
  saldo: CorteAbierto;
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
        <div>
          Efectivo esperado: ${cierre.efectivoCalculado} · declarado: ${cierre.saldoDeclarado}
        </div>
        <div className={cierre.diferencia === 0 ? '' : 'text-red-700'}>
          Diferencia: ${cierre.diferencia}
          {cierre.diferencia > 0 && ' (sobra)'}
          {cierre.diferencia < 0 && ' (falta)'}
        </div>
        {cierre.transferencia > 0 && (
          <div className="text-slate-600">
            Transferencias (suman al corte, no al efectivo): ${cierre.transferencia} ·
            total del corte ${cierre.saldoCalculado}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cifra etiqueta="Inicial" valor={saldo.saldoInicial} />
        <Cifra etiqueta="Ingresos efectivo" valor={saldo.ingresosEfectivo} />
        <Cifra etiqueta="Egresos" valor={saldo.egresos} />
        <Cifra etiqueta="Efectivo esperado" valor={saldo.efectivoCalculado} fuerte />
      </div>
      {saldo.ingresosTransferencia > 0 && (
        <p className="text-xs text-slate-500">
          Transferencias verificadas: ${saldo.ingresosTransferencia} — suman al corte
          (total ${saldo.saldoCalculado}) pero no son efectivo físico en la terminal.
        </p>
      )}

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
