import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import {
  buscarBoletoPorFolio, checklist, detalleBoleto, finalizarViaje, generarManifiestos,
  marcarEnRuta, registrarAbordaje, salidasDelDia,
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
        </div>
      )}
    </Modal>
  );
}
