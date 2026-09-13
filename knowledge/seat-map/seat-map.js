/* Mapa de asientos — lógica sin framework (HTML puro).
   Para React/Next usa SeatMap.jsx; este archivo alimenta seat-map.html. */

// Distribución real de la unidad. 0 = conductor, null = pasillo/hueco.
export const LAYOUTS = {
  18: [[0, null, 18, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, null, 10], [11, 12, null, 13], [14, 15, 16, 17]],
  14: [[0, null, null, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, null, 10], [11, 12, 13, 14]],
  11: [[0, null, null, 1], [2, 3, null, 4], [5, 6, null, 7], [8, 9, 10, 11]],
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * Renderiza el mapa y devuelve un controlador.
 * @param {HTMLElement} root  contenedor con class="seatmap"
 * @param {object} opts { capacidad, ocupados, maxSeleccion, seleccionados, onChange }
 */
export function createSeatMap(root, opts = {}) {
  const capacidad = LAYOUTS[opts.capacidad] ? opts.capacidad : 18;
  const ocupados = new Set((opts.ocupados || []).filter((n) => n <= capacidad));
  const maxSeleccion = opts.maxSeleccion ?? 1;
  let seleccionados = new Set(opts.seleccionados || []);

  const cabin = root.querySelector('.seatmap__cabin');
  cabin.querySelectorAll('.seatmap__row').forEach((el) => el.remove());

  const door = cabin.querySelector('.seatmap__door');
  LAYOUTS[capacidad].forEach((row) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'seatmap__row';
    row.forEach((n) => {
      if (n === null) {
        const sp = document.createElement('span');
        sp.className = 'seatmap__spacer';
        sp.setAttribute('aria-hidden', 'true');
        rowEl.appendChild(sp);
        return;
      }
      if (n === 0) {
        const dr = document.createElement('span');
        dr.className = 'seatmap__driver';
        dr.textContent = 'Chofer';
        rowEl.appendChild(dr);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seatmap__seat';
      b.dataset.seat = String(n);
      b.textContent = pad(n);
      rowEl.appendChild(b);
    });
    cabin.insertBefore(rowEl, door);
  });

  function paint() {
    cabin.querySelectorAll('.seatmap__seat').forEach((b) => {
      const n = Number(b.dataset.seat);
      const occupied = ocupados.has(n);
      const selected = seleccionados.has(n);
      b.classList.toggle('seatmap__seat--occupied', occupied);
      b.classList.toggle('seatmap__seat--selected', selected);
      b.disabled = occupied;
      b.setAttribute('aria-pressed', String(selected));
      b.setAttribute('aria-label',
        'Asiento ' + pad(n) + ' — ' + (occupied ? 'ocupado' : selected ? 'seleccionado' : 'disponible'));
      b.title = b.getAttribute('aria-label');
    });
  }

  cabin.addEventListener('click', (e) => {
    const b = e.target.closest('.seatmap__seat');
    if (!b || b.disabled) return;
    const n = Number(b.dataset.seat);
    if (seleccionados.has(n)) seleccionados.delete(n);
    else if (seleccionados.size < maxSeleccion) seleccionados.add(n);
    else return;                                  // tope alcanzado
    paint();
    opts.onChange?.([...seleccionados].sort((a, b2) => a - b2));
  });

  paint();

  return {
    get seleccionados() { return [...seleccionados].sort((a, b) => a - b); },
    set(list) { seleccionados = new Set(list); paint(); },
    clear() { seleccionados = new Set(); paint(); },
  };
}
