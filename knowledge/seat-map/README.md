# Mapa de asientos — export para Front-End

Exportado del mockup **Wizard Reservaciones** (paso 3). Sin dependencias, sin build.

## Archivos

| Archivo | Para qué |
| --- | --- |
| `seat-map.css` | Estilos completos del componente. Único archivo requerido en cualquier framework. |
| `SeatMap.jsx` | Componente React / Next.js (App Router, `"use client"`), controlado o no controlado. |
| `seat-map.html` | Demo en HTML puro con la estructura de marcado de referencia. |
| `seat-map.js` | Lógica vanilla (ES module) que alimenta la demo HTML. |

## Uso en Next.js

```jsx
import SeatMap from "@/components/SeatMap";

<SeatMap
  capacidad={18}                  // 18 | 14 | 11
  ocupados={[3, 4, 9, 16]}        // del backend
  maxSeleccion={pasajeros}        // tope = personas que viajan
  value={asientos}                // controlado
  onChange={setAsientos}
/>
```

Requiere las fuentes Barlow y Barlow Condensed (`next/font/google` o `<link>`).

## Uso en HTML / otros frameworks

Copia el bloque marcado `<!-- COMPONENTE -->` de `seat-map.html`, enlaza `seat-map.css` y llama a
`createSeatMap(root, { capacidad, ocupados, maxSeleccion, onChange })`. Los renglones se generan en runtime
desde `LAYOUTS`.

## Modelo de datos

`LAYOUTS` describe la planta de la unidad renglón por renglón, de frente a cola:

- `número` → asiento seleccionable con ese folio.
- `0` → lugar del conductor (informativo, no seleccionable).
- `null` → pasillo o hueco; conserva la alineación de la retícula.

```js
18: [[0, null, 18, 1], [2, 3, null, 4], [5, 6, null, 7],
     [8, 9, null, 10], [11, 12, null, 13], [14, 15, 16, 17]]
```

Para otra unidad, agrega una llave nueva con su matriz; no hay que tocar el CSS.

## Estados

| Estado | Clase | Comportamiento |
| --- | --- | --- |
| Disponible | `.seatmap__seat` | Seleccionable; hover y `:focus-visible` con el acento. |
| Seleccionado | `.seatmap__seat--selected` | Relleno acento; clic para deseleccionar. |
| Ocupado | `.seatmap__seat--occupied` + `disabled` | No seleccionable, cursor `not-allowed`. |
| Conductor | `.seatmap__driver` | Borde punteado, no interactivo. |
| Hueco / pasillo | `.seatmap__spacer` | Invisible, `pointer-events: none`. |

Al alcanzar `maxSeleccion` los asientos libres dejan de agregarse (primero hay que liberar uno).

## Personalización

Todo pasa por variables CSS en `.seatmap` — sobrescríbelas con los tokens de tu design system:

```css
.seatmap {
  --sm-accent: var(--color-accent);
  --sm-accent-ink: var(--color-accent-700);
  --sm-ink: var(--color-text);
  --sm-divider: var(--color-divider);
  --sm-seat-size: 52px;   /* 44px en móvil por media query */
  --sm-seat-gap: 12px;
  --sm-seat-radius: 4px;
}
```

## Accesibilidad

Botones nativos con `aria-pressed`, `aria-label` (“Asiento 04 — disponible”), `disabled` real en ocupados,
anillo de foco `:focus-visible` de 2 px y `prefers-reduced-motion` respetado. Área táctil de 52 px (44 px en móvil).
