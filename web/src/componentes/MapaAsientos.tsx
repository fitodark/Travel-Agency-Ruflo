import type { MapaAsientosSalida } from '../api/ventas';
import { formatoAsiento } from '../lib/asientos';
import './MapaAsientos.css';

/**
 * Mapa visual de asientos del paso 3 de Vender (`salida.mapa`, D-7).
 *
 * Marcado y clases tomados de `knowledge/seat-map/` (export real de diseño,
 * Ses. 69): renglones flex de ancho uniforme, hueco = un asiento invisible
 * (no un carril angosto), chofer como un elemento más del primer renglón.
 * A diferencia del export, los renglones/asientos salen de `mapa.asientos`
 * (dato real del backend) y no de una tabla de layouts fija — así una unidad
 * nueva se da de alta con una fila en `core.tipo_unidad`, no con un cambio
 * de código (ver comentario de `src/db/seed/0001_tipo_unidad_sprinter18.sql`).
 *
 * El chofer se asume siempre en la columna 0 del primer renglón — así es en
 * las unidades sembradas hoy (solo la Sprinter de 18 plazas); si llega una
 * unidad con otra disposición al frente, este supuesto hay que revisarlo.
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

  const vendibles = mapa.asientos.filter((a) => a.vendible !== false);
  const plazas = vendibles.length;

  const porFila = new Map<number, typeof vendibles>();
  for (const a of vendibles) {
    const fila = porFila.get(a.fila) ?? [];
    fila.push(a);
    porFila.set(a.fila, fila);
  }
  const filas = [...porFila.keys()].sort((x, y) => x - y);
  const filaChofer = filas[0];
  const filasConAcceso = new Set((mapa.accesos ?? []).map((a) => a.fila));

  type Asiento = (typeof vendibles)[number];
  type Slot = Asiento | 'chofer' | null;

  return (
    <div className="seatmap">
      <i className="seatmap__corner seatmap__corner--tl" aria-hidden />
      <i className="seatmap__corner seatmap__corner--tr" aria-hidden />
      <i className="seatmap__corner seatmap__corner--bl" aria-hidden />
      <i className="seatmap__corner seatmap__corner--br" aria-hidden />

      <div className="seatmap__head">
        <span>Frente / cabina</span>
        <span>{unidadNombre ? `${unidadNombre} — ` : `${plazas} plazas — `}vista de planta</span>
      </div>

      <div className="seatmap__cabinWrap">
        <div className="seatmap__cabin">
          {filas.map((fila) => {
            const asientosPorCol = new Map(porFila.get(fila)!.map((a): [number, Asiento] => [a.col, a]));
            const slots: Slot[] = Array.from({ length: mapa.columnas }, (_, col) => asientosPorCol.get(col) ?? null);
            if (fila === filaChofer && slots[0] === null) slots[0] = 'chofer';

            return (
              <div className="seatmap__row" key={fila}>
                {slots.map((slot, col) => {
                  if (slot === null) {
                    return <span className="seatmap__spacer" key={col} aria-hidden />;
                  }
                  if (slot === 'chofer') {
                    return (
                      <span className="seatmap__driver" key={col}>
                        Chofer
                      </span>
                    );
                  }
                  const seleccionado = selSet.has(slot.num);
                  const disponible = ofrSet.has(slot.num);
                  const ocupado = !disponible && !seleccionado;
                  const estado = ocupado ? 'ocupado' : seleccionado ? 'seleccionado' : 'disponible';
                  return (
                    <button
                      key={col}
                      type="button"
                      disabled={ocupado}
                      onClick={() => onToggle(slot.num)}
                      aria-pressed={seleccionado}
                      aria-label={`Asiento ${formatoAsiento(slot.num)} — ${estado}`}
                      title={`Asiento ${formatoAsiento(slot.num)} — ${estado}`}
                      className={`seatmap__seat${seleccionado ? ' seatmap__seat--selected' : ''}${
                        ocupado ? ' seatmap__seat--occupied' : ''
                      }`}
                    >
                      {formatoAsiento(slot.num)}
                    </button>
                  );
                })}
                {filasConAcceso.has(fila) && (
                  <>
                    <span className="seatmap__door" aria-hidden />
                    <span className="seatmap__doorLabel" aria-hidden>
                      Acceso
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="seatmap__legend">
        <span className="seatmap__legendItem">
          <i className="seatmap__swatch seatmap__swatch--selected" />
          Seleccionado
        </span>
        <span className="seatmap__legendItem">
          <i className="seatmap__swatch seatmap__swatch--occupied" />
          Ocupado
        </span>
        <span className="seatmap__legendItem">
          <i className="seatmap__swatch seatmap__swatch--free" />
          Disponible
        </span>
      </div>
    </div>
  );
}
