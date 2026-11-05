import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cortesUsuariosVisibles, historialCortes, type CorteHistorial } from '../api/caja';
import { useSesion } from '../auth/sesion';
import { fechaHora, hoyLocal } from '../lib/fechas';

const dinero = (n: number | null) => (n === null ? '—' : `$${n}`);
const TAMANOS = [20, 50, 100] as const;

interface Filtros {
  desde: string;
  hasta: string;
  estado: '' | 'abierto' | 'cerrado';
  sucursalId: string;
  usuarioAperturaId: string;
}

const filtrosIniciales = (): Filtros => ({
  desde: hoyLocal(), hasta: hoyLocal(), estado: '', sucursalId: '', usuarioAperturaId: '',
});

/**
 * Historial de cortes (0077), pantalla propia (admin/gerente): separado de
 * "Caja", que solo muestra el corte activo. Filtra por fecha/estado/sucursal/
 * usuario que abrió, paginado 20/50/100. El detalle de movimientos vive en
 * `/historial/:id/movimientos`.
 */
export function HistorialCortes() {
  const { sesion, puede } = useSesion();
  const esAdmin = sesion?.rol === 'administrador';
  const esGerente = sesion?.rol === 'gerente';
  const sinSucursal = !sesion?.sucursalId;
  const necesitaElegirSucursal = sinSucursal && esGerente;

  const [filtros, setFiltros] = useState<Filtros>(filtrosIniciales);
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState<20 | 50 | 100>(20);

  const actualizar = (patch: Partial<Filtros>) => {
    setFiltros((f) => ({ ...f, ...patch, ...(('sucursalId' in patch) ? { usuarioAperturaId: '' } : {}) }));
    setPagina(1);
  };

  const filtrosQuery = {
    desde: filtros.desde || undefined,
    hasta: filtros.hasta || undefined,
    estado: filtros.estado || undefined,
    sucursalId: filtros.sucursalId || undefined,
  };
  const habilitada = !necesitaElegirSucursal || !!filtros.sucursalId;

  const usuarios = useQuery({
    queryKey: ['caja', 'historial', 'usuarios', filtrosQuery],
    queryFn: () => cortesUsuariosVisibles(filtrosQuery),
    enabled: habilitada,
  });

  const q = useQuery({
    queryKey: ['caja', 'historial', filtrosQuery, filtros.usuarioAperturaId, pagina, porPagina],
    queryFn: () => historialCortes({
      ...filtrosQuery,
      usuarioAperturaId: filtros.usuarioAperturaId || undefined,
      pagina, porPagina,
    }),
    enabled: habilitada,
  });

  if (!puede('dashboard.ver')) {
    return (
      <p className="text-sm text-slate-500">
        El historial de cortes es solo para administradores y gerentes.
      </p>
    );
  }

  const total = q.data?.total ?? 0;
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const primeraFila = total === 0 ? 0 : (pagina - 1) * porPagina + 1;
  const ultimaFila = Math.min(pagina * porPagina, total);

  return (
    <div className="w-full space-y-4">
      <h1 className="text-xl font-semibold">Historial de cortes</h1>

      <div className="flex flex-wrap items-end gap-3 text-sm text-slate-600">
        <label className="flex flex-col gap-1">
          Desde
          <input
            type="date" value={filtros.desde}
            onChange={(e) => actualizar({ desde: e.target.value })}
            className="campo-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          Hasta
          <input
            type="date" value={filtros.hasta}
            onChange={(e) => actualizar({ hasta: e.target.value })}
            className="campo-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          Estado
          <select
            value={filtros.estado}
            onChange={(e) => actualizar({ estado: e.target.value as Filtros['estado'] })}
            className="campo-sm"
          >
            <option value="">Todos</option>
            <option value="abierto">Abierto</option>
            <option value="cerrado">Cerrado</option>
          </select>
        </label>
        {sinSucursal && (esAdmin || esGerente) && (
          <label className="flex flex-col gap-1">
            Sucursal
            <select
              value={filtros.sucursalId}
              onChange={(e) => actualizar({ sucursalId: e.target.value })}
              className="campo-sm"
              aria-label="Sucursal a consultar"
            >
              {esAdmin && <option value="">Todas las sucursales</option>}
              {esGerente && <option value="">Elige una sucursal…</option>}
              {sesion!.sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          Abrió
          <select
            value={filtros.usuarioAperturaId}
            onChange={(e) => actualizar({ usuarioAperturaId: e.target.value })}
            className="campo-sm"
            disabled={!habilitada}
          >
            <option value="">Todos</option>
            {usuarios.data?.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
          </select>
        </label>
      </div>

      {necesitaElegirSucursal && !filtros.sucursalId ? (
        <p className="text-sm text-slate-400">Elige una sucursal para ver su historial.</p>
      ) : q.isLoading ? (
        <p className="text-sm text-slate-400">Cargando…</p>
      ) : total === 0 ? (
        <p className="text-sm text-slate-400">Sin cortes para este filtro.</p>
      ) : (
        <>
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
                  <th className="px-3 py-2 text-right">Transfer.</th>
                  <th className="px-3 py-2 text-right">Efectivo esp.</th>
                  <th className="px-3 py-2 text-right">Declarado</th>
                  <th className="px-3 py-2 text-right">Diferencia</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {q.data!.filas.map((c) => <FilaHistorial key={c.corteId} c={c} esAdmin={esAdmin} />)}
              </tbody>
            </table>
          </div>

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
              <button
                className="btn-sutil text-xs disabled:opacity-40"
                disabled={pagina <= 1}
                onClick={() => setPagina((p) => p - 1)}
              >
                Anterior
              </button>
              <span>Página {pagina} de {totalPaginas}</span>
              <button
                className="btn-sutil text-xs disabled:opacity-40"
                disabled={pagina >= totalPaginas}
                onClick={() => setPagina((p) => p + 1)}
              >
                Siguiente
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FilaHistorial({ c, esAdmin }: { c: CorteHistorial; esAdmin: boolean }) {
  const dif = c.diferencia;
  return (
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
      <td className="px-3 py-3 text-right">{c.transferencia ? `$${c.transferencia}` : '—'}</td>
      <td className="px-3 py-3 text-right">${c.efectivoCalculado}</td>
      <td className="px-3 py-3 text-right">{dinero(c.saldoDeclarado)}</td>
      <td className={`px-3 py-3 text-right ${dif && dif !== 0 ? 'text-red-700' : ''}`}>
        {dif === null ? '—' : `$${dif}${dif > 0 ? ' (sobra)' : dif < 0 ? ' (falta)' : ''}`}
      </td>
      <td className="px-4 py-3 text-right">
        <Link to={`/historial/${c.corteId}/movimientos`} className="btn-sutil text-xs">
          movimientos
        </Link>
      </td>
    </tr>
  );
}
