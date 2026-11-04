import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import { cobradoEnCorresponsal, corteDetalle, movimientosCorteDetalle } from '../api/caja';
import { useSesion } from '../auth/sesion';
import { fechaHora } from '../lib/fechas';

const dinero = (n: number | null) => (n === null ? '—' : `$${n}`);
const METODO: Record<string, string> = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', corresponsal: 'Corresponsal',
};

function Cifra({ etiqueta, valor }: { etiqueta: string; valor: number }) {
  return (
    <div className="tarjeta p-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{etiqueta}</div>
      <div className="mt-1 text-base">${valor}</div>
    </div>
  );
}

/**
 * Detalle de un corte (0077): quién lo abrió/cerró, saldos, y sus movimientos
 * con método de pago y pasajeros/folios (abonos incluidos) cuando el ingreso
 * viene de un boleto. Separado de "Historial de cortes" (la lista).
 */
export function HistorialCorteMovimientos() {
  const { puede } = useSesion();
  const { id } = useParams<{ id: string }>();
  const corteId = id ?? '';

  const corte = useQuery({
    queryKey: ['caja', 'historial', 'detalle', corteId],
    queryFn: () => corteDetalle(corteId),
  });
  const movs = useQuery({
    queryKey: ['caja', 'historial', 'movimientos', corteId],
    queryFn: () => movimientosCorteDetalle(corteId),
  });
  const corresponsal = useQuery({
    queryKey: ['caja', 'corresponsal', corteId],
    queryFn: () => cobradoEnCorresponsal(corteId),
  });

  if (!puede('dashboard.ver')) {
    return (
      <p className="text-sm text-slate-500">
        El historial de cortes es solo para administradores y gerentes.
      </p>
    );
  }

  if (corte.isLoading) return <p className="text-sm text-slate-400">Cargando…</p>;
  if (corte.isError || !corte.data) {
    return (
      <p className="text-sm text-red-600">
        {corte.error instanceof ErrorApi && corte.error.status === 403
          ? 'No tienes permiso para ver este corte.'
          : 'No se pudo cargar el corte.'}
      </p>
    );
  }

  const c = corte.data;
  const dif = c.diferencia;

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Movimientos del corte</h1>
        <Link to="/historial" className="btn-sutil text-xs">volver al historial</Link>
      </div>

      <div className="tarjeta grid grid-cols-2 gap-3 p-4 text-sm sm:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">Sucursal</div>
          {c.sucursal}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">Abrió</div>
          {c.usuarioApertura} · {fechaHora(c.abiertoEn)}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">Estado</div>
          {c.cerradoEn ? `cerrado · ${fechaHora(c.cerradoEn)}` : <span className="chip-ok">abierto</span>}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">Diferencia</div>
          <span className={dif && dif !== 0 ? 'text-red-700' : ''}>
            {dif === null ? '—' : `$${dif}${dif > 0 ? ' (sobra)' : dif < 0 ? ' (falta)' : ''}`}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cifra etiqueta="Inicial" valor={c.saldoInicial} />
        <Cifra etiqueta="Ingresos" valor={c.ingresos} />
        <Cifra etiqueta="Egresos" valor={c.egresos} />
        <Cifra etiqueta="Efectivo esperado" valor={c.efectivoCalculado} />
      </div>
      {c.transferencia > 0 && (
        <p className="text-xs text-slate-500">
          Transferencias verificadas: ${c.transferencia} — suman al corte (total ${c.saldoCalculado})
          pero no son efectivo físico en la terminal.
        </p>
      )}
      {c.saldoDeclarado !== null && (
        <p className="text-sm text-slate-600">
          Declarado al cerrar: {dinero(c.saldoDeclarado)}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-600">Movimientos</h2>
        {movs.isLoading ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : movs.isError ? (
          <p className="text-sm text-slate-500">
            {movs.error instanceof ErrorApi && movs.error.status === 403
              ? 'No tienes permiso para ver el detalle de este corte.'
              : 'No se pudieron cargar los movimientos.'}
          </p>
        ) : !movs.data?.length ? (
          <p className="text-sm text-slate-400">Sin movimientos.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Fecha</th>
                  <th className="px-4 py-2.5">Tipo</th>
                  <th className="px-4 py-2.5">Concepto</th>
                  <th className="px-4 py-2.5">Pago</th>
                  <th className="px-4 py-2.5">Pasajeros</th>
                  <th className="px-3 py-2 text-right">Monto</th>
                </tr>
              </thead>
              <tbody>
                {movs.data.map((m) => (
                  <tr key={m.id} className={`border-t border-slate-100 ${m.activo ? '' : 'text-slate-400 line-through'}`}>
                    <td className="px-4 py-3 whitespace-nowrap">{fechaHora(m.registradoEn)}</td>
                    <td className="px-4 py-3">{m.tipo}</td>
                    <td className="px-4 py-3">{m.descripcion ?? m.origenTipo}</td>
                    <td className="px-4 py-3">
                      {m.metodoPago ? (
                        <>
                          {METODO[m.metodoPago] ?? m.metodoPago}
                          {m.esAbono && ' (abono)'}
                          {m.metodoPago === 'transferencia' && m.referenciaTransferencia && (
                            <span className="block text-xs text-slate-400">
                              ref. {m.referenciaTransferencia}
                            </span>
                          )}
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {m.pasajeros?.length
                        ? m.pasajeros.map((p) => `${p.folio} · ${p.pasajero}`).join(', ')
                        : m.envio
                          ? `Envío ${m.envio.folio} · ${m.envio.bultos} bulto(s) → ${m.envio.destino} · recibe ${m.envio.destinatario}`
                          : '—'}
                    </td>
                    <td className="px-3 py-3 text-right">${m.monto}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!!corresponsal.data && corresponsal.data.conteo > 0 && (
        <section className="rounded border border-arena-200 bg-arena-50/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-arena-800">
            Cobrado en corresponsal — {corresponsal.data.conteo} pago(s), ${corresponsal.data.suma}
            {' '}(no entra al efectivo)
          </p>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1 pr-4">Fecha</th><th className="py-1 pr-4">Folio</th>
                <th className="py-1 pr-4">Pasajero</th><th className="py-1 pr-4">Sucursal de cobro</th>
                <th className="py-1 text-right">Monto</th>
              </tr>
            </thead>
            <tbody>
              {corresponsal.data.detalle.map((d) => (
                <tr key={d.pagoId} className="border-t border-slate-200">
                  <td className="py-1 pr-4 whitespace-nowrap">{fechaHora(d.pagadoEn)}</td>
                  <td className="py-1 pr-4 font-mono">{d.folio ?? '—'}</td>
                  <td className="py-1 pr-4">{d.pasajero ?? '—'}</td>
                  <td className="py-1 pr-4">{d.sucursalCobro}</td>
                  <td className="py-1 text-right">${d.monto}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
