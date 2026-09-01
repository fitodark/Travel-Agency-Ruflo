import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import {
  buscarBoletoPorFolio, checklist, finalizarViaje, generarManifiestos, marcarEnRuta,
  registrarAbordaje, salidasDelDia,
  type BoletoPorFolio, type ManifiestosEncolados, type SalidaDelDia,
} from '../api/viajes';
import { hora } from '../lib/fechas';

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
              <td className="py-1.5 font-mono text-xs">{f.folio}</td>
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
    </div>
  );
}
