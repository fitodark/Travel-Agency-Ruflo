/* Mapa de asientos ilustrado — lógica sin framework (ES module). */

/** Planta de la unidad, de frente a cola. 0 = chofer · null = pasillo/hueco */
export const LAYOUTS = {
  18: [[0, null, 18, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, null, 10], [11, 12, null, 13], [14, 15, 16, 17]],
  14: [[0, null, null, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, null, 10], [11, 12, 13, 14]],
  11: [[0, null, null, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, 10, 11]],
};

/** Desfase (px) de los asientos individuales del pasillo — criterio de QA. */
export const OFFSETS = { 4: 18, 7: 12, 10: 6 };

const pad = (n) => String(n).padStart(2, '0');

/** Giro de 90° en contra de las manecillas del reloj: frente a la izquierda, chofer abajo. */
function rotarCCW(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  return Array.from({ length: cols }, (_, i) =>
    rows.map((r) => { const v = r[cols - 1 - i]; return v === undefined ? null : v; }));
}

/**
 * @param {HTMLElement} root  contenedor .sprintermap
 * @param {object} opts { capacidad, orientacion: 'v'|'h', ocupados, maxSeleccion, seleccionados, onChange }
 */
export function createSprinterMap(root, opts = {}) {
  const capacidad = LAYOUTS[opts.capacidad] ? opts.capacidad : 18;
  const ocupados = new Set((opts.ocupados || []).filter((n) => n <= capacidad));
  const maxSeleccion = opts.maxSeleccion ?? 1;
  let orientacion = opts.orientacion === 'h' ? 'h' : 'v';
  let seleccionados = new Set(opts.seleccionados || []);

  const cabin = root.querySelector('.sprintermap__cabin');
  const door = cabin.querySelector('.sprintermap__door');

  function build() {
    root.classList.toggle('sprintermap--v', orientacion === 'v');
    root.classList.toggle('sprintermap--h', orientacion === 'h');
    cabin.querySelectorAll('.sprintermap__row').forEach((el) => el.remove());

    const grid = orientacion === 'h' ? rotarCCW(LAYOUTS[capacidad]) : LAYOUTS[capacidad];
    grid.forEach((row) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'sprintermap__row';
      row.forEach((n) => {
        if (n === null) {
          const sp = document.createElement('span');
          sp.className = 'sprintermap__spacer';
          sp.setAttribute('aria-hidden', 'true');
          rowEl.appendChild(sp);
          return;
        }
        if (n === 0) {
          const dr = document.createElement('span');
          dr.className = 'sprintermap__driver';
          dr.textContent = 'Chofer';
          rowEl.appendChild(dr);
          return;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sprintermap__seat';
        b.dataset.seat = String(n);
        if (OFFSETS[n]) b.dataset.offset = String(OFFSETS[n]);
        b.innerHTML =
          '<span class="sprintermap__arm sprintermap__arm--a"></span>' +
          '<span class="sprintermap__arm sprintermap__arm--b"></span>' +
          '<span class="sprintermap__num">' + pad(n) + '</span>';
        rowEl.appendChild(b);
      });
      cabin.insertBefore(rowEl, door);
    });
    paint();
  }

  function paint() {
    cabin.querySelectorAll('.sprintermap__seat').forEach((b) => {
      const n = Number(b.dataset.seat);
      const occupied = ocupados.has(n);
      const selected = seleccionados.has(n);
      b.classList.toggle('sprintermap__seat--occupied', occupied);
      b.classList.toggle('sprintermap__seat--selected', selected);
      b.disabled = occupied;
      b.setAttribute('aria-pressed', String(selected));
      const estado = occupied ? 'ocupado' : selected ? 'seleccionado' : 'disponible';
      b.setAttribute('aria-label', 'Asiento ' + pad(n) + ' — ' + estado);
      b.title = b.getAttribute('aria-label');
    });
  }

  cabin.addEventListener('click', (e) => {
    const b = e.target.closest('.sprintermap__seat');
    if (!b || b.disabled) return;
    const n = Number(b.dataset.seat);
    if (seleccionados.has(n)) seleccionados.delete(n);
    else if (seleccionados.size < maxSeleccion) seleccionados.add(n);
    else return;
    paint();
    opts.onChange?.([...seleccionados].sort((a, b2) => a - b2));
  });

  build();

  return {
    get seleccionados() { return [...seleccionados].sort((a, b) => a - b); },
    setOrientacion(o) { orientacion = o === 'h' ? 'h' : 'v'; build(); },
    set(list) { seleccionados = new Set(list); paint(); },
    clear() { seleccionados = new Set(); paint(); },
  };
}
