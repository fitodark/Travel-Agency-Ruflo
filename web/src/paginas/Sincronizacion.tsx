import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { estadoSync, excepcionesSync, forzarCiclo } from '../api/sync';

function Dato({ etiqueta, valor, alerta }: { etiqueta: string; valor: string; alerta?: boolean }) {
  return (
    <div className="rounded border bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{etiqueta}</div>
      <div className={`mt-1 text-lg font-semibold ${alerta ? 'text-red-600' : ''}`}>{valor}</div>
    </div>
  );
}

const hace = (iso: string | null): string => {
  if (!iso) return 'nunca';
  const seg = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seg < 60) return `hace ${seg} s`;
  if (seg < 3600) return `hace ${Math.round(seg / 60)} min`;
  return `hace ${Math.round(seg / 3600)} h`;
};

export function Sincronizacion() {
  const qc = useQueryClient();

  const estado = useQuery({
    queryKey: ['sync', 'estado'],
    queryFn: estadoSync,
    refetchInterval: 3000,
  });

  const excepciones = useQuery({
    queryKey: ['sync', 'excepciones'],
    queryFn: excepcionesSync,
    refetchInterval: 5000,
  });

  const ciclo = useMutation({
    mutationFn: forzarCiclo,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['sync'] });
    },
  });

  const s = estado.data;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sincronización</h1>
        <button
          onClick={() => ciclo.mutate()}
          disabled={ciclo.isPending}
          className="rounded bg-slate-900 text-white px-4 py-2 text-sm disabled:opacity-50"
        >
          {ciclo.isPending ? 'Sincronizando…' : 'Forzar ciclo'}
        </button>
      </div>

      {ciclo.data && (
        <div
          className={`rounded border p-3 text-sm ${
            ciclo.data.ok ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'
          }`}
        >
          {ciclo.data.ok
            ? 'Ciclo completo: push y pull ejecutados.'
            : `El ciclo falló: ${ciclo.data.error}`}
        </div>
      )}

      {estado.isError && (
        <p className="text-sm text-red-600">No se pudo leer el estado del motor.</p>
      )}

      {s && (
        <>
          {s.degradado && (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              Modo degradado: la terminal lleva demasiado tiempo sin sincronizar.
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Dato etiqueta="Última sync" valor={hace(s.ultimaSyncExitosa)} alerta={s.degradado} />
            <Dato
              etiqueta="Outbox pendiente"
              valor={String(s.outboxPendiente)}
              alerta={s.outboxPendiente > 0}
            />
            <Dato
              etiqueta="Outbox atascado"
              valor={String(s.outboxAtascado)}
              alerta={s.outboxAtascado > 0}
            />
            <Dato
              etiqueta="Deriva de reloj"
              valor={s.derivaRelojSeg === null ? '—' : `${s.derivaRelojSeg} s`}
              alerta={s.derivaRelojSeg !== null && Math.abs(s.derivaRelojSeg) > 120}
            />
            <Dato etiqueta="Más viejo sin subir" valor={hace(s.outboxMasAntiguoEn)} />
            <Dato etiqueta="Aplicador de config" valor={hace(s.ultimaPasadaAplicador)} />
            <Dato etiqueta="Versión de esquema" valor={s.versionEsquema ?? '—'} />
            <Dato
              etiqueta="Excepciones críticas"
              valor={String(s.excepcionesAbiertas.critica)}
              alerta={s.excepcionesAbiertas.critica > 0}
            />
          </div>
        </>
      )}

      <div>
        <h2 className="text-sm font-semibold text-slate-600 mb-2">Excepciones abiertas</h2>
        {excepciones.data && excepciones.data.length === 0 && (
          <p className="text-sm text-slate-400">Ninguna.</p>
        )}
        <ul className="space-y-2">
          {excepciones.data?.map((e) => (
            <li key={e.id} className="rounded border bg-white p-3 text-sm">
              <span
                className={`inline-block rounded px-2 py-0.5 text-xs font-medium mr-2 ${
                  e.severidad === 'critica'
                    ? 'bg-red-100 text-red-700'
                    : e.severidad === 'alta'
                      ? 'bg-orange-100 text-orange-700'
                      : 'bg-slate-100 text-slate-600'
                }`}
              >
                {e.severidad}
              </span>
              <span className="font-medium">{e.tipo}</span>
              {e.sucursal && <span className="text-slate-500"> · {e.sucursal}</span>}
              <span className="text-slate-400"> · {hace(e.creadoEn)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
