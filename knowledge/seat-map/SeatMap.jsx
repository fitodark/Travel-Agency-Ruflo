"use client";

import { useCallback, useMemo, useState } from "react";
import "./seat-map.css";

/** 0 = conductor · null = pasillo/hueco (mantiene la retícula alineada) */
export const LAYOUTS = {
  18: [[0, null, 18, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, null, 10], [11, 12, null, 13], [14, 15, 16, 17]],
  14: [[0, null, null, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, null, 10], [11, 12, 13, 14]],
  11: [[0, null, null, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, 10, 11]],
};

const pad = (n) => String(n).padStart(2, "0");

/**
 * SeatMap — mapa de asientos de unidad tipo Suburban.
 *
 * @param {number}   capacidad      18 | 14 | 11 (default 18)
 * @param {number[]} ocupados       asientos no seleccionables
 * @param {number}   maxSeleccion   tope de asientos seleccionables (= pasajeros)
 * @param {number[]} value          controlado: asientos seleccionados
 * @param {Function} onChange       (asientos: number[]) => void
 * @param {string}   unidadNombre   texto de la cabecera derecha
 */
export default function SeatMap({
  capacidad = 18,
  ocupados = [],
  maxSeleccion = 1,
  value,
  defaultValue = [],
  onChange,
  unidadNombre,
}) {
  const cap = LAYOUTS[capacidad] ? capacidad : 18;
  const rows = LAYOUTS[cap];
  const [inner, setInner] = useState(defaultValue);
  const seleccionados = value ?? inner;

  const occ = useMemo(
    () => new Set(ocupados.filter((n) => n <= cap)),
    [ocupados, cap]
  );

  const toggle = useCallback(
    (n) => {
      const has = seleccionados.includes(n);
      let next;
      if (has) next = seleccionados.filter((x) => x !== n);
      else if (seleccionados.length < maxSeleccion) next = [...seleccionados, n].sort((a, b) => a - b);
      else return;
      if (value === undefined) setInner(next);
      onChange?.(next);
    },
    [seleccionados, maxSeleccion, onChange, value]
  );

  return (
    <section className="seatmap" aria-label="Mapa de asientos de la unidad">
      <i className="seatmap__corner seatmap__corner--tl" />
      <i className="seatmap__corner seatmap__corner--tr" />
      <i className="seatmap__corner seatmap__corner--bl" />
      <i className="seatmap__corner seatmap__corner--br" />

      <div className="seatmap__head">
        <span>Frente / cabina</span>
        <span>{unidadNombre ?? `Suburban ${cap} plazas`} — vista de planta</span>
      </div>

      <div className="seatmap__cabinWrap">
        <div className="seatmap__cabin">
          {rows.map((row, ri) => (
            <div className="seatmap__row" key={ri}>
              {row.map((n, ci) => {
                if (n === null)
                  return <span className="seatmap__spacer" key={ci} aria-hidden="true" />;
                if (n === 0)
                  return <span className="seatmap__driver" key={ci}>Chofer</span>;

                const occupied = occ.has(n);
                const selected = seleccionados.includes(n);
                const estado = occupied ? "ocupado" : selected ? "seleccionado" : "disponible";

                return (
                  <button
                    key={ci}
                    type="button"
                    className={[
                      "seatmap__seat",
                      selected && "seatmap__seat--selected",
                      occupied && "seatmap__seat--occupied",
                    ].filter(Boolean).join(" ")}
                    disabled={occupied}
                    aria-pressed={selected}
                    aria-label={`Asiento ${pad(n)} — ${estado}`}
                    title={`Asiento ${pad(n)} — ${estado}`}
                    onClick={() => toggle(n)}
                  >
                    {pad(n)}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="seatmap__door" aria-hidden="true" />
          <div className="seatmap__doorLabel" aria-hidden="true">Acceso</div>
        </div>
      </div>

      <div className="seatmap__legend">
        <span className="seatmap__legendItem"><i className="seatmap__swatch seatmap__swatch--selected" />Seleccionado</span>
        <span className="seatmap__legendItem"><i className="seatmap__swatch seatmap__swatch--occupied" />Ocupado</span>
        <span className="seatmap__legendItem"><i className="seatmap__swatch seatmap__swatch--free" />Disponible</span>
      </div>
    </section>
  );
}
