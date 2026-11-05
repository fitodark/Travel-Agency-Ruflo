/**
 * «Por entregar» con historial completo (retro del equipo, 4 nov): lo que
 * espera a que lo recojan y lo ya entregado, para que un envío entregado no
 * desaparezca y solo se pueda consultar por folio. Paginado 20/50/100 como el
 * Historial de cortes; filtros por fecha de entrega, quién envía, quién recibe
 * y folio.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ESTADO_ENVIO, historialEntregas, type EnvioEntregas, type FiltrosEntregas, type VistaEntregas,
} from '../../api/paqueteria';
import { fecha, fechaHora } from '../../lib/fechas';
import { Chip, Tabla } from '../ui';
import { mxn } from './comun';

const TAMANOS = [20, 50, 100] as const;

const filtrosIniciales = (): Required<FiltrosEntregas> => ({
  vista: 'todos', entregaDesde: '', entregaHasta: '', remitente: '', destinatario: '', folio: '',
});

export function HistorialEntregas({ onAbrir }: { onAbrir: (folio: string) => void }) {
  const [filtros, setFiltros] = useState(filtrosIniciales);
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState<20 | 50 | 100>(20);

  const actualizar = (patch: Partial<FiltrosEntregas>) => {
    setFiltros((f) => ({ ...f, ...patch }));
    setPagina(1);
  };

  const q = useQuery({
    queryKey: ['paqueteria', 'destino', 'historial', filtros, pagina, porPagina],
    queryFn: () => historialEntregas({
      ...filtros,
      remitente: filtros.remitente.trim(),
      destinatario: filtros.destinatario.trim(),
      folio: filtros.folio.trim(),
      pagina, porPagina,
    }),
    placeholderData: keepPreviousData,
  });

  const total = q.data?.total ?? 0;
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const primeraFila = total === 0 ? 0 : (pagina - 1) * porPagina + 1;
  const ultimaFila = Math.min(pagina * porPagina, total);
  const hayFiltros = JSON.stringify(filtros) !== JSON.stringify(filtrosIniciales());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 text-sm text-slate-600">
        <label className="flex flex-col gap-1">
          Mostrar
          <select
            value={filtros.vista}
            onChange={(e) => actualizar({ vista: e.target.value as VistaEntregas })}
            className="campo-sm"
          >
            <option value="todos">Todos</option>
            <option value="por_entregar">Por entregar</option>
            <option value="entregados">Entregados</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Entregado desde
          <input type="date" value={filtros.entregaDesde}
                 onChange={(e) => actualizar({ entregaDesde: e.target.value })} className="campo-sm" />
        </label>
        <label className="flex flex-col gap-1">
          Entregado hasta
          <input type="date" value={filtros.entregaHasta}
                 onChange={(e) => actualizar({ entregaHasta: e.target.value })} className="campo-sm" />
        </label>
        <label className="flex flex-col gap-1">
          Envía
          <input value={filtros.remitente} maxLength={120} placeholder="Nombre"
                 onChange={(e) => actualizar({ remitente: e.target.value })} className="campo-sm" />
        </label>
        <label className="flex flex-col gap-1">
          Recibe
          <input value={filtros.destinatario} maxLength={120} placeholder="Nombre"
                 onChange={(e) => actualizar({ destinatario: e.target.value })} className="campo-sm" />
        </label>
        <label className="flex flex-col gap-1">
          Folio
          <input value={filtros.folio} maxLength={20} placeholder="Folio"
                 onChange={(e) => actualizar({ folio: e.target.value })} className="campo-sm w-28 font-mono uppercase" />
        </label>
        {hayFiltros && (
          <button className="btn-sutil text-xs" onClick={() => { setFiltros(filtrosIniciales()); setPagina(1); }}>
            Limpiar filtros
          </button>
        )}
      </div>

      {(filtros.entregaDesde || filtros.entregaHasta) && filtros.vista !== 'entregados' && (
        <p className="text-xs text-slate-500">
          Con fecha de entrega solo aparecen paquetes ya entregados.
        </p>
      )}

      {q.isLoading ? (
        <p className="text-sm text-slate-400">Cargando…</p>
      ) : (
        <Tabla<EnvioEntregas>
          filas={q.data?.filas}
          claveFila={(e) => e.envioId}
          vacio={hayFiltros ? 'Sin paquetes para este filtro.' : 'Todavía no llegan paquetes a esta sucursal.'}
          cols={[
            { clave: 'folio', th: 'Folio', td: (e) => (
              <button className="font-mono font-semibold text-brand-700 underline" onClick={() => onAbrir(e.folio)}>
                {e.folio}
              </button>
            ) },
            { clave: 'origen', th: 'Origen', td: (e) => `${e.origen} · ${fecha(e.fechaOperacion)}` },
            { clave: 'envia', th: 'Envía', td: (e) => e.remitenteNombre },
            { clave: 'recibe', th: 'Recibe', td: (e) => `${e.destinatarioNombre} · ${e.destinatarioTelefono}` },
            { clave: 'contenido', th: 'Contenido', td: (e) => `${e.descripcion} (${e.bultos})` },
            { clave: 'estado', th: 'Estado', td: (e) => (
              <Chip estado={e.estado === 'entregado' ? 'baja' : 'ok'}>{ESTADO_ENVIO[e.estado]}</Chip>
            ) },
            { clave: 'cobro', th: 'Por cobrar', className: 'text-right', td: (e) => (e.porCobrar > 0 ? mxn(e.porCobrar) : '—') },
            { clave: 'entrega', th: 'Entregado', className: 'whitespace-nowrap', td: (e) => (
              e.entregadoEn
                ? <>{fechaHora(e.entregadoEn)}<span className="block text-xs text-slate-500">{e.entregadoPor}</span></>
                : '—'
            ) },
          ]}
        />
      )}

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
          <span>Mostrando {primeraFila}–{ultimaFila} de {total}</span>
          <div className="flex items-center gap-2">
            <select
              value={porPagina}
              onChange={(e) => { setPorPagina(Number(e.target.value) as 20 | 50 | 100); setPagina(1); }}
              className="campo-sm"
              aria-label="Registros por página"
            >
              {TAMANOS.map((t) => <option key={t} value={t}>{t} por página</option>)}
            </select>
            <button className="btn-sutil text-xs disabled:opacity-40" disabled={pagina <= 1}
                    onClick={() => setPagina((p) => p - 1)}>
              Anterior
            </button>
            <span>Página {pagina} de {totalPaginas}</span>
            <button className="btn-sutil text-xs disabled:opacity-40" disabled={pagina >= totalPaginas}
                    onClick={() => setPagina((p) => p + 1)}>
              Siguiente
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
