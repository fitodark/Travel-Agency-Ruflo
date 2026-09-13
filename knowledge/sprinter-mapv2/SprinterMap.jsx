"use client";

import { useCallback, useMemo, useState } from "react";
import "./sprinter-map.css";

/** Planta de la unidad, de frente a cola. 0 = chofer · null = pasillo/hueco */
export const LAYOUTS = {
  18: [[0, null, 18, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, null, 10], [11, 12, null, 13], [14, 15, 16, 17]],
  14: [[0, null, null, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, null, 10], [11, 12, 13, 14]],
  11: [[0, null, null, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, 10, 11]],
};

/** Desfase (px) de los asientos individuales del pasillo — criterio de QA. */
export const OFFSETS = { 4: 18, 7: 12, 10: 6 };

const pad = (n) => String(n).padStart(2, "0");

/** Giro de 90° en contra de las manecillas del reloj: frente a la izquierda, chofer abajo. */
function rotarCCW(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  return Array.from({ length: cols }, (_, i) =>
    rows.map((r) => (r[cols - 1 - i] === undefined ? null : r[cols - 1 - i])));
}

/**
 * SprinterMap — mapa de asientos ilustrado, vertical u horizontal.
 *
 * @param {number}   capacidad     18 | 14 | 11
 * @param {"v"|"h"}  orientacion   "v" planta · "h" giro 90° CCW
 * @param {number[]} ocupados      asientos no seleccionables
 * @param {number}   maxSeleccion  tope de asientos (= pasajeros)
 * @param {number[]} value         controlado
 * @param {Function} onChange      (asientos: number[]) => void
 */
export default function SprinterMap({
  capacidad = 18,
  orientacion = "v",
  ocupados = [],
  maxSeleccion = 1,
  value,
  defaultValue = [],
  onChange,
  unidadNombre,
}) {
  const cap = LAYOUTS[capacidad] ? capacidad : 18;
  const hz = orientacion === "h";
  const rows = useMemo(() => (hz ? rotarCCW(LAYOUTS[cap]) : LAYOUTS[cap]), [cap, hz]);
  const occ = useMemo(() => new Set(ocupados.filter((n) => n <= cap)), [ocupados, cap]);

  const [inner, setInner] = useState(defaultValue);
  const seleccionados = value ?? inner;

  const toggle = useCallback((n) => {
    const has = seleccionados.includes(n);
    let next;
    if (has) next = seleccionados.filter((x) => x !== n);
    else if (seleccionados.length < maxSeleccion) next = [...seleccionados, n].sort((a, b) => a - b);
    else return;
    if (value === undefined) setInner(next);
    onChange?.(next);
  }, [seleccionados, maxSeleccion, onChange, value]);

  return (
    <section className={`sprintermap sprintermap--${hz ? "h" : "v"}`} aria-label="Mapa de asientos de la unidad">
      <i className="sprintermap__corner sprintermap__corner--tl" />
      <i className="sprintermap__corner sprintermap__corner--tr" />
      <i className="sprintermap__corner sprintermap__corner--bl" />
      <i className="sprintermap__corner sprintermap__corner--br" />

      <div className="sprintermap__head">
        <span>{hz ? "Frente ←" : "Frente / cabina"}</span>
        <span>
          {unidadNombre ?? `Suburban ${cap} plazas`} — {hz ? "vista lateral (horizontal)" : "vista de planta (vertical)"}
        </span>
      </div>

      <div className="sprintermap__scroll">
        <div className="sprintermap__body">
          <div className="sprintermap__nose"><span>Cabina</span></div>
          <div className="sprintermap__cabin">
            {rows.map((row, ri) => (
              <div className="sprintermap__row" key={ri}>
                {row.map((n, ci) => {
                  if (n === null) return <span className="sprintermap__spacer" key={ci} aria-hidden="true" />;
                  if (n === 0) return <span className="sprintermap__driver" key={ci}>Chofer</span>;

                  const occupied = occ.has(n);
                  const selected = seleccionados.includes(n);
                  const estado = occupied ? "ocupado" : selected ? "seleccionado" : "disponible";

                  return (
                    <button
                      key={ci}
                      type="button"
                      className={[
                        "sprintermap__seat",
                        selected && "sprintermap__seat--selected",
                        occupied && "sprintermap__seat--occupied",
                      ].filter(Boolean).join(" ")}
                      data-offset={OFFSETS[n] || undefined}
                      disabled={occupied}
                      aria-pressed={selected}
                      aria-label={`Asiento ${pad(n)} — ${estado}`}
                      title={`Asiento ${pad(n)} — ${estado}`}
                      onClick={() => toggle(n)}
                    >
                      <span className="sprintermap__arm sprintermap__arm--a" />
                      <span className="sprintermap__arm sprintermap__arm--b" />
                      <span className="sprintermap__num">{pad(n)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="sprintermap__door" aria-hidden="true" />
            <div className="sprintermap__doorLabel" aria-hidden="true">Acceso</div>
          </div>
        </div>
      </div>

      <div className="sprintermap__legend">
        <span className="sprintermap__legendItem"><i className="sprintermap__swatch" />Disponible</span>
        <span className="sprintermap__legendItem"><i className="sprintermap__swatch sprintermap__swatch--selected" />Seleccionado</span>
        <span className="sprintermap__legendItem"><i className="sprintermap__swatch sprintermap__swatch--occupied" />Ocupado</span>
      </div>
    </section>
  );
}
