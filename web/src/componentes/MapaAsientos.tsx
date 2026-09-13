import type { MapaAsientosSalida } from '../api/ventas';
import { formatoAsiento } from '../lib/asientos';

/**
 * Mapa visual de asientos del paso 3 de Vender (layout real de la unidad,
 * `salida.mapa` — D-7). Un asiento vendible que no viene en `ofrecibles` se
 * pinta como ocupado: puede en realidad estar libre pero fuera del cupo de
 * esta sucursal (offline / nodo degradado, 01b §3.4) — se prefiere no
 * ofrecerlo a arriesgar una sobreventa entre sucursales.
 */
export function MapaAsientos({
  mapa,
  ofrecibles,
  seleccionados,
  onToggle,
  unidadNombre,
}: {
  mapa: MapaAsientosSalida;
  ofrecibles: readonly number[];
  seleccionados: readonly number[];
  onToggle: (num: number) => void;
  /** `core.tipo_unidad.nombre` (ya incluye la capacidad, p. ej. "... 18 plazas"). */
  unidadNombre?: string;
}) {
  const ofrSet = new Set(ofrecibles);
  const selSet = new Set(seleccionados);
  const pasillo = mapa.pasillo_despues_columna;
  // Columna 1 es la del chofer (decorativa, no viene en `mapa.asientos`); los
  // asientos empiezan en la columna 2, con el pasillo insertado después de ella.
  const colGrid = (col: number) => (col <= pasillo ? col + 2 : col + 3);
  const spacerCol = pasillo + 3;
  const totalCols = mapa.columnas + 2;
  const gridTemplateColumns = Array.from({ length: totalCols }, (_, i) =>
    i + 1 === spacerCol ? '1.25rem' : '2.75rem',
  ).join(' ');

  const plazas = mapa.asientos.filter((a) => a.vendible !== false).length;

  return (
    <div className="rounded-sm border border-slate-200 bg-slate-50/60 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-medium uppercase tracking-wide text-slate-400">
        <span>Frente / cabina</span>
        <span>{unidadNombre ? `${unidadNombre} — ` : `${plazas} plazas — `}vista de planta</span>
      </div>
      <div className="mx-auto inline-grid gap-2" style={{ gridTemplateColumns }}>
        <div
          style={{ gridColumn: 1, gridRow: 1 }}
          className="flex h-11 w-11 items-center justify-center rounded-sm border border-dashed border-slate-300 text-[9px] font-semibold uppercase tracking-wide text-slate-400"
        >
          Chofer
        </div>
        {mapa.asientos
          .filter((a) => a.vendible !== false)
          .map((a) => {
            const seleccionado = selSet.has(a.num);
            const disponible = ofrSet.has(a.num);
            const ocupado = !disponible && !seleccionado;
            return (
              <button
                key={a.num}
                type="button"
                disabled={ocupado}
                onClick={() => onToggle(a.num)}
                style={{ gridColumn: colGrid(a.col), gridRow: a.fila + 1 }}
                title={ocupado ? `Asiento ${a.num} — no disponible` : `Asiento ${a.num}`}
                className={`flex h-11 w-11 items-center justify-center rounded-sm border text-sm font-medium transition ${
                  seleccionado
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : ocupado
                      ? 'cursor-not-allowed border-slate-200 bg-slate-200 text-slate-400'
                      : 'border-slate-300 bg-white hover:border-brand-400 hover:bg-brand-50'
                }`}
              >
                {formatoAsiento(a.num)}
              </button>
            );
          })}
        {(mapa.accesos ?? []).map((acceso) => (
          <span
            key={acceso.fila}
            aria-hidden
            style={{ gridColumn: spacerCol, gridRow: acceso.fila + 1, writingMode: 'vertical-rl' }}
            className="flex items-center justify-center text-[10px] font-bold uppercase tracking-widest text-brand-500"
          >
            {acceso.etiqueta}
          </span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border border-brand-600 bg-brand-600" /> Seleccionado
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border border-slate-200 bg-slate-200" /> Ocupado
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border border-slate-300 bg-white" /> Disponible
        </span>
      </div>
    </div>
  );
}
