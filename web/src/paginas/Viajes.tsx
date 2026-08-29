import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorApi } from '../api/cliente';
import {
  checklist, finalizarViaje, generarManifiestos, marcarEnRuta, registrarAbordaje,
  salidasDelDia, type ManifiestosEncolados, type SalidaDelDia,
} from '../api/viajes';

const hoyIso = (): string => new Date().toISOString().slice(0, 10);

const hora = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
