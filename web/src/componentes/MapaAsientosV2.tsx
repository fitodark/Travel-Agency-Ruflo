import type { MapaAsientosSalida } from '../api/ventas';
import { formatoAsiento } from '../lib/asientos';
import { OFFSETS_ASIENTO } from '../lib/asientosOffsets';
import './MapaAsientosV2.css';

/**
 * Mapa de asientos ilustrado (v2) — para comparar contra `MapaAsientos.tsx`
 * en el paso 3 mientras QA decide con el cliente cuál usar.
 *
 * Marcado y clases de `knowledge/sprinter-mapv2/` (export de diseño, Ses. 70):
 * asiento con cojín + descansabrazos, carrocería propia, desfase por asiento
 * (criterio de QA). Igual que `MapaAsientos.tsx`, los renglones salen de
 * `mapa.asientos` (dato real del backend), no de la tabla `LAYOUTS` fija del
 * export — mismas notas sobre el chofer y la puerta de acceso.
 *
 * Solo se implementa la orientación vertical del export (`sprintermap--v`):
 * la horizontal (giro 90°) no se pidió y complicaría la comparación 1:1 con
 * el mapa actual.
 */
export function MapaAsientosV2({
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
  unidadNombre?: string;
}) {
  const ofrSet = new Set(ofrecibles);
  const selSet = new Set(seleccionados);

  const vendibles = mapa.asientos.filter((a) => a.vendible !== false);

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
    <div className="sprintermap sprintermap--v">
      <i className="sprintermap__corner sprintermap__corner--tl" aria-hidden />
      <i className="sprintermap__corner sprintermap__corner--tr" aria-hidden />
      <i className="sprintermap__corner sprintermap__corner--bl" aria-hidden />
      <i className="sprintermap__corner sprintermap__corner--br" aria-hidden />

      <div className="sprintermap__head">
        <span>Frente / cabina</span>
        <span>{unidadNombre ?? 'Sprinter 18 plazas'} — vista de planta (ilustrada)</span>
      </div>

      <div className="sprintermap__scroll">
        <div className="sprintermap__body">
          <div className="sprintermap__nose">
            <span>Cabina</span>
          </div>
          <div className="sprintermap__cabin">
            {filas.map((fila) => {
              const asientosPorCol = new Map(porFila.get(fila)!.map((a): [number, Asiento] => [a.col, a]));
              const slots: Slot[] = Array.from({ length: mapa.columnas }, (_, col) => asientosPorCol.get(col) ?? null);
              if (fila === filaChofer && slots[0] === null) slots[0] = 'chofer';

              return (
                <div className="sprintermap__row" key={fila}>
                  {slots.map((slot, col) => {
                    if (slot === null) {
                      return <span className="sprintermap__spacer" key={col} aria-hidden />;
                    }
                    if (slot === 'chofer') {
                      return (
                        <span className="sprintermap__driver" key={col}>
                          Chofer
                        </span>
                      );
                    }
                    const seleccionado = selSet.has(slot.num);
                    const disponible = ofrSet.has(slot.num);
                    const ocupado = !disponible && !seleccionado;
                    const estado = ocupado ? 'ocupado' : seleccionado ? 'seleccionado' : 'disponible';
                    const desfase = OFFSETS_ASIENTO[slot.num];
                    return (
                      <button
                        key={col}
                        type="button"
                        disabled={ocupado}
                        onClick={() => onToggle(slot.num)}
                        aria-pressed={seleccionado}
                        aria-label={`Asiento ${formatoAsiento(slot.num)} — ${estado}`}
                        title={`Asiento ${formatoAsiento(slot.num)} — ${estado}`}
                        {...(desfase ? { 'data-offset': String(desfase) } : {})}
                        className={`sprintermap__seat${seleccionado ? ' sprintermap__seat--selected' : ''}${
                          ocupado ? ' sprintermap__seat--occupied' : ''
                        }`}
                      >
                        <span className="sprintermap__arm sprintermap__arm--a" aria-hidden />
                        <span className="sprintermap__arm sprintermap__arm--b" aria-hidden />
                        <span className="sprintermap__num">{formatoAsiento(slot.num)}</span>
                      </button>
                    );
                  })}
                  {filasConAcceso.has(fila) && (
                    <>
                      <span className="sprintermap__door" aria-hidden />
                      <span className="sprintermap__doorLabel" aria-hidden>
                        Acceso
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="sprintermap__legend">
        <span className="sprintermap__legendItem">
          <i className="sprintermap__swatch" />
          Disponible
        </span>
        <span className="sprintermap__legendItem">
          <i className="sprintermap__swatch sprintermap__swatch--selected" />
          Seleccionado
        </span>
        <span className="sprintermap__legendItem">
          <i className="sprintermap__swatch sprintermap__swatch--occupied" />
          Ocupado
        </span>
      </div>
    </div>
  );
}
