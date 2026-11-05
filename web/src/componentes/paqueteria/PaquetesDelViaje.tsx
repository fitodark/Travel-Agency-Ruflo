/**
 * Viajes → «Paquetes por enviar» (retro del equipo, 4 nov): los envíos que
 * salen de MI terminal en este viaje, para ver de un vistazo qué debe subirse a
 * la unidad. El folio abre el detalle del envío, donde se marca cada uno en
 * ruta (0089). Una terminal intermedia conserva además el despacho en bloque
 * (0086); el origen lo hace solo al marcar el viaje en ruta.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { despacharEnvios, enviosDeSalida, ESTADO_ENVIO, type Envio } from '../../api/paqueteria';
import { ErrorApi } from '../../api/cliente';
import type { SalidaDelDia } from '../../api/viajes';
import { useSesion } from '../../auth/sesion';
import { Chip } from '../ui';
import { DetalleEnvio } from './DetalleEnvio';
import { mxn } from './comun';

const tono = (e: Envio['estado']) => (e === 'registrado' ? 'alerta' : e === 'en_ruta' ? 'ok' : 'baja');

export function PaquetesDelViaje({ salida }: { salida: SalidaDelDia }) {
  const { sesion } = useSesion();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['paqueteria', 'salida', salida.salidaId],
    queryFn: () => enviosDeSalida(salida.salidaId),
  });
  const despachar = useMutation({
    mutationFn: () => despacharEnvios(salida.salidaId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['paqueteria'] }); },
  });

  // Solo lo que sale de aquí: lo que llega a esta terminal se ve en Paquetería.
  const envios = (q.data ?? []).filter(
    (e) => e.sucursalOrigenId === sesion?.sucursalId && e.estado !== 'cancelado',
  );
  const porSubir = envios.filter((e) => e.estado === 'registrado').length;
  const bultos = envios.reduce((n, e) => n + e.bultos, 0);
  const viajeVivo = salida.estado !== 'finalizada' && salida.estado !== 'cancelada';

  return (
    <div className="rounded border border-slate-200">
      <div className="flex flex-wrap items-center gap-2 border-b bg-slate-50/60 px-3 py-2 text-sm">
        <span className="font-medium">Paquetes por enviar</span>
        <span className="text-xs text-slate-500">
          {envios.length} envío(s) · {bultos} bulto(s){porSubir > 0 && ` · ${porSubir} por subir`}
        </span>
        {!salida.esOrigen && viajeVivo && porSubir > 0 && (
          <button
            onClick={() => despachar.mutate()}
            disabled={despachar.isPending}
            className="ml-auto rounded border px-3 py-1 text-xs disabled:opacity-50"
            title="Pasan a «en ruta» todos los paquetes que salen de aquí"
          >
            Despachar todos
          </button>
        )}
      </div>

      {despachar.data && (
        <p className="px-3 pt-2 text-xs text-green-700">{despachar.data.despachados} paquete(s) despachado(s).</p>
      )}
      {despachar.isError && (
        <p className="px-3 pt-2 text-xs text-red-600">
          {despachar.error instanceof ErrorApi ? despachar.error.message : 'No se pudo despachar.'}
        </p>
      )}

      {q.isLoading ? (
        <p className="px-3 py-3 text-sm text-slate-400">Cargando…</p>
      ) : envios.length === 0 ? (
        <p className="px-3 py-3 text-center text-sm text-slate-400">Sin paquetes que salgan de aquí en este viaje.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-3 py-1">Folio</th>
              <th className="px-3 py-1">Destino</th>
              <th className="px-3 py-1">Recibe</th>
              <th className="px-3 py-1">Contenido</th>
              <th className="px-3 py-1">Estado</th>
              <th className="px-3 py-1 text-right">Por cobrar</th>
            </tr>
          </thead>
          <tbody>
            {envios.map((e) => (
              <tr key={e.envioId} className="border-t">
                <td className="px-3 py-1.5">
                  <button
                    type="button"
                    onClick={() => setAbierto(e.folio)}
                    className="font-mono text-xs text-brand-700 underline underline-offset-2 hover:text-brand-800"
                    title="Ver detalle del envío"
                  >
                    {e.folio}
                  </button>
                </td>
                <td className="px-3 py-1.5">{e.destino}</td>
                <td className="px-3 py-1.5">{e.destinatarioNombre}</td>
                <td className="px-3 py-1.5 text-slate-500">{e.descripcion} ({e.bultos})</td>
                <td className="px-3 py-1.5"><Chip estado={tono(e.estado)}>{ESTADO_ENVIO[e.estado]}</Chip></td>
                <td className="px-3 py-1.5 text-right">{e.porCobrar > 0 ? mxn(e.porCobrar) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {abierto && <DetalleEnvio folio={abierto} onCerrar={() => setAbierto(null)} />}
    </div>
  );
}
