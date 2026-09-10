import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import { listarPuntos } from '../api/catalogos';
import { buscarSalidas, type SalidaDisponible } from '../api/ventas';
import {
  boletosReubicables, buscarBoletoPorFolio, cancelarBoleto, checklist, detalleBoleto,
  finalizarViaje, generarManifiestos, marcarEnRuta, registrarAbordaje, reimprimirBoleto,
  reubicarBoleto, reubicarVentaHuerfana, salidasDelDia,
  type BoletoPorFolio, type ManifiestosEncolados, type SalidaDelDia,
} from '../api/viajes';
import { Modal } from '../componentes/ui';
import { fechaHora, hora } from '../lib/fechas';

const mxn = (n: number): string =>
  n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

const hoyIso = (): string => new Date().toISOString().slice(0, 10);

const CHIP: Record<string, string> = {
  programada: 'bg-slate-100 text-slate-600',
  en_ruta: 'bg-blue-100 text-blue-700',
  finalizada: 'bg-green-100 text-green-700',
  cancelada: 'bg-red-100 text-red-700',
};

export function Viajes() {
  const [fecha, setFecha] = useState(hoyIso());
  const [abierta, setAbierta] = useState<string | null>(null);

  const salidas = useQuery({
    queryKey: ['viajes', fecha],
    queryFn: () => salidasDelDia(fecha),
  });

  const irAlViaje = (s: { fechaOperacion: string; salidaId: string }) => {
    setFecha(s.fechaOperacion);
    setAbierta(s.salidaId);
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Viajes</h1>
        <label className="text-sm text-slate-500">
          Fecha{' '}
          <input
            type="date"
            value={fecha}
            onChange={(e) => { setFecha(e.target.value); setAbierta(null); }}
            className="rounded border px-2 py-1"
          />
        </label>
      </div>

      <BuscarPorFolio onIrAlViaje={irAlViaje} />

      {salidas.isError && (
        <p className="text-sm text-red-600">No se pudo cargar el listado.</p>
      )}
      {salidas.data?.length === 0 && (
        <p className="text-sm text-slate-400">Sin salidas para esta fecha.</p>
      )}

      <div className="space-y-2">
        {salidas.data?.map((s) => (
          <SalidaFila
            key={s.salidaId}
            salida={s}
            abierta={abierta === s.salidaId}
            onToggle={() => setAbierta(abierta === s.salidaId ? null : s.salidaId)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Búsqueda de un boleto por su folio. El folio es un STRING de 6 caracteres
 * (código de sucursal + contador base32), no un consecutivo numérico — se
 * teclea/dicta tal cual viene impreso. Sirve para capturar el abordaje de un
 * pasajero que llega con su boleto sin buscar su viaje a mano.
 */
function BuscarPorFolio(
  { onIrAlViaje }: { onIrAlViaje: (s: { fechaOperacion: string; salidaId: string }) => void },
) {
  const [folio, setFolio] = useState('');
  const [resultado, setResultado] = useState<BoletoPorFolio | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buscar = useMutation({
    mutationFn: () => buscarBoletoPorFolio(folio),
    onSuccess: (b) => { setResultado(b); setError(null); },
    onError: (e) => {
      setResultado(null);
      setError(e instanceof ErrorApi ? e.message : 'No se pudo buscar el folio.');
    },
  });

  const abordaje = useMutation({
    mutationFn: (abordo: boolean) => registrarAbordaje(resultado!.boletoId, abordo),
    onSuccess: () => buscar.mutate(),
    onError: (e) => setError(e instanceof ErrorApi ? e.message : 'No se pudo capturar el abordaje.'),
  });

  const enviar = (e: FormEvent) => { e.preventDefault(); if (folio.trim()) buscar.mutate(); };

  return (
    <div className="rounded border bg-white p-4 space-y-3">
      <form onSubmit={enviar} className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex-1 min-w-[12rem]">
          <span className="text-slate-500">Buscar por folio</span>
          <input
            value={folio}
            onChange={(e) => setFolio(e.target.value.toUpperCase())}
            placeholder="p. ej. 1AB2C"
            className="campo mt-1 font-mono tracking-wider"
            maxLength={12}
          />
        </label>
        <button type="submit" disabled={buscar.isPending} className="btn-primario">
          {buscar.isPending ? 'Buscando…' : 'Buscar'}
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {resultado && (
        <div className="rounded-lg bg-slate-50/70 p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-base font-semibold tracking-wider">{resultado.folio}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${CHIP[resultado.salida.estado] ?? 'bg-slate-100'}`}>
              {resultado.salida.estado}
            </span>
          </div>
          <div className="mt-1 text-slate-600">
            {resultado.pasajeroNombre} · asiento {resultado.asientoNum} · tramo {resultado.tramos}
            {resultado.conflicto && <span className="ml-1 text-xs text-red-600">conflicto</span>}
          </div>
          <div className="mt-1 text-slate-500">
            {resultado.salida.fechaOperacion} · {hora(resultado.salida.horaSalida)} ·{' '}
            {resultado.salida.origen} → {resultado.salida.destino}
            {resultado.salida.conductor ? ` · ${resultado.salida.conductor}` : ''}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(['abordo', 'no_presento'] as const).map((quiere) => {
              const activo = resultado.estadoAbordaje === quiere;
              return (
                <button
                  key={quiere}
                  disabled={abordaje.isPending}
                  onClick={() => abordaje.mutate(quiere === 'abordo')}
                  className={`rounded px-3 py-1 text-xs ${
                    activo
                      ? quiere === 'abordo' ? 'bg-green-600 text-white' : 'bg-slate-600 text-white'
                      : 'border text-slate-600'
                  }`}
                >
                  {quiere === 'abordo' ? 'abordó' : 'no se presentó'}
                </button>
              );
            })}
            <button
              onClick={() => onIrAlViaje(resultado.salida)}
              className="ml-auto text-xs text-brand-700 underline"
            >
              ver viaje completo →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SalidaFila({
  salida, abierta, onToggle,
}: {
  salida: SalidaDelDia;
  abierta: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded border bg-white">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm"
      >
        <span className="font-mono">{hora(salida.horaSalida)}</span>
        <span className="flex-1">
          {salida.origen} → {salida.destino}
          <span className="text-slate-400"> · {salida.conductor ?? 'sin conductor'}</span>
        </span>
        <span className="text-slate-500">{salida.boletos} boletos</span>
        <span className={`rounded px-2 py-0.5 text-xs ${CHIP[salida.estado] ?? 'bg-slate-100'}`}>
          {salida.estado}
        </span>
      </button>
      {abierta && <DetalleViaje salida={salida} />}
    </div>
  );
}

function DetalleViaje({ salida }: { salida: SalidaDelDia }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [manifiestos, setManifiestos] = useState<ManifiestosEncolados | null>(null);
  const [boletoDetalle, setBoletoDetalle] = useState<string | null>(null);

  const lista = useQuery({
    queryKey: ['viajes', 'checklist', salida.salidaId],
    queryFn: () => checklist(salida.salidaId),
  });

  const invalidar = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ['viajes'] });
  };
  const alError = (e: unknown) =>
    setError(e instanceof ErrorApi ? e.message : 'Operación fallida.');

  const abordaje = useMutation({
    mutationFn: (v: { boletoId: string; abordo: boolean }) =>
      registrarAbordaje(v.boletoId, v.abordo),
    onSuccess: invalidar,
    onError: alError,
  });
  const manifiesto = useMutation({
    mutationFn: () => generarManifiestos(salida.salidaId),
    onSuccess: (m) => { setManifiestos(m); invalidar(); },
    onError: alError,
  });
  const enRuta = useMutation({
    mutationFn: () => marcarEnRuta(salida.salidaId),
    onSuccess: invalidar,
    onError: alError,
  });
  const finalizar = useMutation({
    mutationFn: () => finalizarViaje(salida.salidaId),
    onSuccess: invalidar,
    onError: alError,
  });

  return (
    <div className="border-t px-4 py-3 space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => manifiesto.mutate()}
          disabled={manifiesto.isPending}
          className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Generar manifiestos
        </button>
        {salida.estado === 'programada' && (
          <button
            onClick={() => enRuta.mutate()}
            disabled={enRuta.isPending}
            className="btn-primario px-3 py-1.5"
          >
            Marcar en ruta
          </button>
        )}
        {salida.estado === 'en_ruta' && (
          <button
            onClick={() => finalizar.mutate()}
            disabled={finalizar.isPending}
            className="rounded border border-slate-900 px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Finalizar viaje
          </button>
        )}
      </div>

      {manifiestos && (
        <p className="text-xs text-green-700">
          Manifiestos encolados para imprimir: conductor ({manifiestos.conductor.pasajeros} pas.),
          terminal ({manifiestos.terminal.pasajeros} pas.).
        </p>
      )}

      <table className="w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="py-1">Asiento</th>
            <th className="py-1">Folio</th>
            <th className="py-1">Pasajero</th>
            <th className="py-1">Tramo</th>
            <th className="py-1">Abordaje</th>
          </tr>
        </thead>
        <tbody>
          {lista.data?.map((f) => (
            <tr key={f.boletoId} className={`border-t ${f.conflicto ? 'bg-red-50' : ''}`}>
              <td className="py-1.5">{f.asientoNum}</td>
              <td className="py-1.5">
                <button
                  type="button"
                  onClick={() => setBoletoDetalle(f.boletoId)}
                  className="font-mono text-xs text-brand-700 underline underline-offset-2 hover:text-brand-800"
                  title="Ver detalle del boleto"
                >
                  {f.folio}
                </button>
              </td>
              <td className="py-1.5">
                {f.pasajeroNombre}
                {f.conflicto && <span className="ml-1 text-xs text-red-600">conflicto</span>}
              </td>
              <td className="py-1.5 text-slate-500">{f.tramos}</td>
              <td className="py-1.5">
                <div className="inline-flex gap-1">
                  {(['abordo', 'no_presento'] as const).map((quiere) => {
                    const activo = f.estadoAbordaje === quiere;
                    return (
                      <button
                        key={quiere}
                        onClick={() =>
                          abordaje.mutate({ boletoId: f.boletoId, abordo: quiere === 'abordo' })}
                        className={`rounded px-2 py-0.5 text-xs ${
                          activo
                            ? quiere === 'abordo'
                              ? 'bg-green-600 text-white'
                              : 'bg-slate-600 text-white'
                            : 'border text-slate-600'
                        }`}
                      >
                        {quiere === 'abordo' ? 'abordó' : 'no se presentó'}
                      </button>
                    );
                  })}
                </div>
              </td>
            </tr>
          ))}
          {lista.data?.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-slate-400">Sin boletos.</td>
            </tr>
          )}
        </tbody>
      </table>

      {boletoDetalle && (
        <ModalDetalleBoleto
          boletoId={boletoDetalle}
          onCerrar={() => setBoletoDetalle(null)}
        />
      )}
    </div>
  );
}

/**
 * Detalle completo del boleto vendido: quién lo vendió y con qué rol, en qué
 * sucursal, cuándo (formato 24 h), el costo y el tramo origen → destino.
 */
function ModalDetalleBoleto({
  boletoId, onCerrar,
}: {
  boletoId: string;
  onCerrar: () => void;
}) {
  const detalle = useQuery({
    queryKey: ['viajes', 'boleto-detalle', boletoId],
    queryFn: () => detalleBoleto(boletoId),
  });

  const qc = useQueryClient();
  const reimprimir = useMutation({
    mutationFn: () => reimprimirBoleto(boletoId),
  });
  const cancelar = useMutation({
    mutationFn: (motivo: string) => cancelarBoleto(boletoId, motivo || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['viajes'] });
      void detalle.refetch();
    },
  });
  const reubicar = useMutation({
    mutationFn: (d: {
      salidaNuevaId: string; origenOrden: number; destinoOrden: number; asientoNum: number;
    }) => reubicarBoleto(boletoId, d),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['viajes'] });
      void detalle.refetch();
    },
  });
  const reubicarVenta = useMutation({
    mutationFn: (d: {
      salidaNuevaId: string; origenOrden: number; destinoOrden: number;
      asientos: Array<{ boletoViejoId: string; asientoNum: number }>;
    }) => reubicarVentaHuerfana(detalle.data!.venta.ventaId, d),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['viajes'] });
      void detalle.refetch();
    },
  });

  const puedeMover =
    detalle.data?.estado === 'emitido'
    && !cancelar.isSuccess && !reubicar.isSuccess && !reubicarVenta.isSuccess;

  return (
    <Modal titulo="Detalle del boleto" onCerrar={onCerrar}>
      {detalle.isPending && <p className="text-sm text-slate-400">Cargando…</p>}
      {detalle.isError && (
        <p className="text-sm text-red-600">No se pudo cargar el detalle del boleto.</p>
      )}

      {detalle.data && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-lg font-semibold tracking-wider">
              {detalle.data.folio}
            </span>
            <span className="text-slate-500">
              {detalle.data.pasajeroNombre} · asiento {detalle.data.asientoNum}
              {detalle.data.conflicto && (
                <span className="ml-1 text-xs text-red-600">conflicto</span>
              )}
            </span>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-slate-500">Ruta</dt>
            <dd>
              {detalle.data.ruta.origen} → {detalle.data.ruta.destino}
              <span className="text-slate-400">
                {' '}· {hora(detalle.data.ruta.origenHora)}–{hora(detalle.data.ruta.destinoHora)}
              </span>
            </dd>

            <dt className="text-slate-500">Costo del boleto</dt>
            <dd className="font-medium">{mxn(detalle.data.importe)}</dd>

            <dt className="text-slate-500">Vendido por</dt>
            <dd>
              {detalle.data.vendedor.nombre}{' '}
              <span className="text-slate-400">({detalle.data.vendedor.rol})</span>
            </dd>

            <dt className="text-slate-500">Sucursal de venta</dt>
            <dd>{detalle.data.sucursalVenta}</dd>

            <dt className="text-slate-500">Fecha y hora de venta</dt>
            <dd>{fechaHora(detalle.data.vendidoEn)}</dd>

            <dt className="text-slate-500">Tipo</dt>
            <dd>
              {detalle.data.venta.esReservacion ? 'Reservación' : 'Venta'}
              {detalle.data.venta.boletosEnLaVenta > 1 && (
                <span className="text-slate-400">
                  {' '}· {detalle.data.venta.boletosEnLaVenta} boletos, total{' '}
                  {mxn(detalle.data.venta.importeTotal)}
                </span>
              )}
            </dd>

            <dt className="text-slate-500">Contacto</dt>
            <dd>
              {detalle.data.venta.contactoTelefono}
              {detalle.data.venta.clienteNombre && (
                <span className="text-slate-400"> · {detalle.data.venta.clienteNombre}</span>
              )}
            </dd>
          </dl>

          <p className="border-t pt-2 text-xs text-slate-500">
            Salida {detalle.data.salida.fechaOperacion}
            {detalle.data.salida.conductor ? ` · ${detalle.data.salida.conductor}` : ''}
            {detalle.data.impresoEn
              ? ` · impreso ${fechaHora(detalle.data.impresoEn)}`
              : ' · sin imprimir'}
          </p>

          <div className="border-t pt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => reimprimir.mutate()}
              disabled={
                reimprimir.isPending || reimprimir.isSuccess
                || detalle.data.estado === 'cancelado' || detalle.data.estado === 'reasignado'
              }
              className="btn"
            >
              {reimprimir.isPending ? 'Reimprimiendo…' : 'Reimprimir boleto'}
            </button>
            {puedeMover && (
              <CancelarBoleto
                pending={cancelar.isPending}
                onConfirmar={(m) => cancelar.mutate(m)}
              />
            )}
            {puedeMover && (
              <ReubicarBoleto
                ventaId={detalle.data.venta.ventaId}
                multiBoleto={detalle.data.venta.boletosEnLaVenta > 1}
                pending={reubicar.isPending || reubicarVenta.isPending}
                onConfirmar={(d) => reubicar.mutate(d)}
                onConfirmarVenta={(d) => reubicarVenta.mutate(d)}
              />
            )}
          </div>

          {reimprimir.isSuccess && (
            <p className="text-xs text-green-700">
              Reimpresión encolada (nº {reimprimir.data.reimpresiones}).
            </p>
          )}
          {reimprimir.isError && (
            <p className="text-xs text-red-600">
              {reimprimir.error instanceof ErrorApi ? reimprimir.error.message : 'No se pudo reimprimir.'}
            </p>
          )}
          {cancelar.isSuccess && (
            <p className="text-xs text-green-700">
              Boleto cancelado{cancelar.data.ventaCancelada ? ' (la venta completa)' : ''}.
              {cancelar.data.reembolsoPendienteEn
                ? ` El reembolso de ${mxn(cancelar.data.reembolsoMonto ?? 0)} se hace a mano en ${cancelar.data.reembolsoPendienteEn} (donde se cobró).`
                : cancelar.data.reembolsoMonto != null
                  ? ` Se registró un reembolso de ${mxn(cancelar.data.reembolsoMonto)} en el corte.`
                  : ' No había pago que reembolsar.'}
            </p>
          )}
          {cancelar.isError && (
            <p className="text-xs text-red-600">
              {cancelar.error instanceof ErrorApi ? cancelar.error.message : 'No se pudo cancelar.'}
            </p>
          )}
          {reubicar.isSuccess && (
            <p className="text-xs text-green-700">
              Reubicado. Nuevo folio{' '}
              <span className="font-mono">{reubicar.data.folioNuevo}</span>.{' '}
              {reubicar.data.precioMantenido
                ? `Se mantuvo el precio ya pagado (${mxn(reubicar.data.importe)}).`
                : `Tarifa vigente de la ruta nueva: ${mxn(reubicar.data.importe)}${
                    reubicar.data.saldoPendiente > 0
                      ? ` · saldo pendiente ${mxn(reubicar.data.saldoPendiente)}.`
                      : '.'
                  }`}
              {reubicar.data.printJobs > 0 && ` ${reubicar.data.printJobs} boleto(s) reimpreso(s).`}
            </p>
          )}
          {reubicar.isError && (
            <p className="text-xs text-red-600">
              {reubicar.error instanceof ErrorApi ? reubicar.error.message : 'No se pudo reubicar.'}
            </p>
          )}
          {reubicarVenta.isSuccess && (
            <p className="text-xs text-green-700">
              Venta reubicada: {reubicarVenta.data.boletos.length} boleto(s) (folios{' '}
              <span className="font-mono">
                {reubicarVenta.data.boletos.map((b) => b.folio).join(', ')}
              </span>).{' '}
              {reubicarVenta.data.precioMantenido
                ? `Se mantuvo el precio ya pagado (${mxn(reubicarVenta.data.importeTotal)}).`
                : `Tarifa vigente de la ruta nueva: ${mxn(reubicarVenta.data.importeTotal)}${
                    reubicarVenta.data.saldoPendiente > 0
                      ? ` · saldo pendiente ${mxn(reubicarVenta.data.saldoPendiente)}.`
                      : '.'
                  }`}
              {reubicarVenta.data.printJobs > 0 && ` ${reubicarVenta.data.printJobs} boleto(s) reimpreso(s).`}
            </p>
          )}
          {reubicarVenta.isError && (
            <p className="text-xs text-red-600">
              {reubicarVenta.error instanceof ErrorApi ? reubicarVenta.error.message : 'No se pudo reubicar la venta.'}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function CancelarBoleto({ pending, onConfirmar }: { pending: boolean; onConfirmar: (motivo: string) => void }) {
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState('');
  if (!abierto) {
    return (
      <button type="button" className="btn-sutil text-red-600" onClick={() => setAbierto(true)}>
        Cancelar boleto
      </button>
    );
  }
  return (
    <div className="w-full rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm">
      <p className="text-red-800">
        Se libera el asiento y, si hubo pago en efectivo o transferencia verificada, se registra el
        reembolso en el corte abierto. Hasta 1 h antes de la salida.
      </p>
      <input
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="Motivo (opcional)"
        className="campo mt-2"
      />
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn-primario" disabled={pending}
          onClick={() => onConfirmar(motivo)}>
          {pending ? 'Cancelando…' : 'Confirmar cancelación'}
        </button>
        <button type="button" className="rounded border px-3 py-1.5" onClick={() => setAbierto(false)}>
          No
        </button>
      </div>
    </div>
  );
}

interface DatosReubicar {
  salidaNuevaId: string;
  origenOrden: number;
  destinoOrden: number;
  asientoNum: number;
}

interface DatosReubicarVenta {
  salidaNuevaId: string;
  origenOrden: number;
  destinoOrden: number;
  asientos: Array<{ boletoViejoId: string; asientoNum: number }>;
}

/**
 * Asistente para reubicar un huérfano (D12/N-14): el operador busca una salida de
 * la ruta nueva por fecha + origen/destino, elige asiento(s) y confirma. El
 * backend cancela el/los boleto(s) viejo(s) y reemite; si ya pagó mantiene el
 * precio, si no cobra la tarifa vigente. Una venta de un boleto usa el flujo
 * simple; una venta multi-boleto (familia) se reubica completa, un asiento por
 * pasajero, todos en el mismo tramo.
 */
function ReubicarBoleto({
  ventaId, multiBoleto, pending, onConfirmar, onConfirmarVenta,
}: {
  ventaId: string;
  multiBoleto: boolean;
  pending: boolean;
  onConfirmar: (d: DatosReubicar) => void;
  onConfirmarVenta: (d: DatosReubicarVenta) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [fecha, setFecha] = useState(hoyIso());
  const [origen, setOrigen] = useState('');
  const [destino, setDestino] = useState('');
  const [salida, setSalida] = useState<SalidaDisponible | null>(null);
  // Un asiento por boleto viejo (multi) o el único asiento (simple, clave '').
  const [asientos, setAsientos] = useState<Record<string, number>>({});

  const puntos = useQuery({ queryKey: ['puntos'], queryFn: listarPuntos });
  const reubicables = useQuery({
    queryKey: ['viajes', 'reubicables', ventaId],
    queryFn: () => boletosReubicables(ventaId),
    enabled: abierto && multiBoleto,
  });
  const busqueda = useMutation({
    mutationFn: () =>
      buscarSalidas({
        fecha, origen, destino,
        personas: multiBoleto ? (reubicables.data?.length ?? 1) : 1,
        conConexion: false,
      }),
    onSuccess: () => { setSalida(null); setAsientos({}); },
  });

  const pasajeros = multiBoleto
    ? (reubicables.data ?? []).map((b) => ({ key: b.boletoId, etiqueta: `${b.pasajeroNombre} (asiento ${b.asientoNum})` }))
    : [{ key: '', etiqueta: 'Pasajero' }];
  const tomados = new Set(Object.values(asientos));
  const listo = pasajeros.every((p) => asientos[p.key] != null);

  const confirmar = () => {
    if (!salida) return;
    if (multiBoleto) {
      onConfirmarVenta({
        salidaNuevaId: salida.salidaId,
        origenOrden: salida.origenOrden,
        destinoOrden: salida.destinoOrden,
        asientos: (reubicables.data ?? []).map((b) => ({
          boletoViejoId: b.boletoId, asientoNum: asientos[b.boletoId]!,
        })),
      });
    } else {
      onConfirmar({
        salidaNuevaId: salida.salidaId,
        origenOrden: salida.origenOrden,
        destinoOrden: salida.destinoOrden,
        asientoNum: asientos['']!,
      });
    }
  };

  if (!abierto) {
    return (
      <button type="button" className="btn-sutil text-brand-700" onClick={() => setAbierto(true)}>
        Reubicar {multiBoleto ? 'la venta' : ''} a otra ruta
      </button>
    );
  }

  return (
    <div className="w-full space-y-3 rounded-lg border border-brand-200 bg-brand-50/50 p-3 text-sm">
      <p className="text-slate-600">
        {multiBoleto
          ? 'Reubica a toda la venta en una salida de la ruta nueva (un asiento por pasajero, mismo tramo). '
          : 'Reubica al pasajero en una salida de la ruta nueva. '}
        Si ya pagó, se mantiene el precio; si no, se cobra la tarifa vigente de la ruta nueva.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          Fecha
          <input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="campo mt-1"
          />
        </label>
        <div />
        <label className="block">
          Origen
          <select value={origen} onChange={(e) => setOrigen(e.target.value)} className="campo mt-1">
            <option value="">—</option>
            {puntos.data?.filter((p) => p.puedeOriginar).map((p) => (
              <option key={p.id} value={p.id}>{p.nombre}</option>
            ))}
          </select>
        </label>
        <label className="block">
          Destino
          <select value={destino} onChange={(e) => setDestino(e.target.value)} className="campo mt-1">
            <option value="">—</option>
            {puntos.data?.filter((p) => p.id !== origen).map((p) => (
              <option key={p.id} value={p.id}>{p.nombre}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="btn"
          disabled={!origen || !destino || busqueda.isPending}
          onClick={() => busqueda.mutate()}
        >
          {busqueda.isPending ? 'Buscando…' : 'Buscar salidas'}
        </button>
        <button
          type="button"
          className="rounded border px-3 py-1.5"
          onClick={() => setAbierto(false)}
        >
          Cerrar
        </button>
      </div>

      {busqueda.isError && (
        <p className="text-xs text-red-600">
          {busqueda.error instanceof ErrorApi ? busqueda.error.message : 'No se pudo buscar.'}
        </p>
      )}
      {busqueda.data?.length === 0 && (
        <p className="text-xs text-slate-500">No hay salidas para ese tramo y fecha.</p>
      )}

      {busqueda.data && busqueda.data.length > 0 && !salida && (
        <ul className="space-y-1">
          {busqueda.data.map((s) => (
            <li key={s.salidaId}>
              <button
                type="button"
                disabled={!s.seleccionable}
                onClick={() => { setSalida(s); setAsientos({}); }}
                className={`w-full rounded border p-2 text-left text-xs ${
                  s.seleccionable ? 'bg-white hover:bg-slate-50' : 'bg-slate-100 text-slate-400'
                }`}
              >
                <div className="flex justify-between">
                  <span className="font-medium">{fechaHora(s.horaSalidaOrigen)}</span>
                  <span>{s.importe === null ? 'sin tarifa' : mxn(s.importe)}</span>
                </div>
                <div className="text-slate-500">
                  {[s.origenNombre, ...s.escalas, s.destinoNombre].join(' → ')} · {s.disponibles} disp.
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {salida && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>
              {fechaHora(salida.horaSalidaOrigen)} · {salida.origenNombre} → {salida.destinoNombre}
            </span>
            <button
              type="button"
              className="underline"
              onClick={() => { setSalida(null); setAsientos({}); }}
            >
              cambiar salida
            </button>
          </div>

          {pasajeros.map((p) => (
            <div key={p.key} className="space-y-1">
              {multiBoleto && <p className="text-xs text-slate-600">{p.etiqueta}</p>}
              <div className="flex flex-wrap gap-1.5">
                {salida.asientosOfrecibles.map((n) => {
                  const mio = asientos[p.key] === n;
                  const ajeno = !mio && tomados.has(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      disabled={ajeno}
                      onClick={() => setAsientos((prev) => ({ ...prev, [p.key]: n }))}
                      className={`h-9 w-9 rounded border text-xs ${
                        mio
                          ? 'border-brand-600 bg-brand-600 text-white'
                          : ajeno
                            ? 'cursor-not-allowed bg-slate-100 text-slate-300'
                            : 'bg-white hover:bg-brand-50'
                      }`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <button
            type="button"
            className="btn-primario"
            disabled={!listo || pending}
            onClick={confirmar}
          >
            {pending ? 'Reubicando…' : multiBoleto ? 'Reubicar la venta' : 'Reubicar'}
          </button>
        </div>
      )}
    </div>
  );
}
