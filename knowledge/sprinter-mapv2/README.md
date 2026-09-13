# Mapa de asientos ilustrado (Sprinter 18) — export para Front-End

Exportado del mockup **Wizard Reservaciones**, paso 3, vista *Sprinter 18*. Sin dependencias, sin build.
El export esquemático anterior sigue vigente en `../seat-map/`.

## Archivos

| Archivo | Para qué |
| --- | --- |
| `sprinter-map.css` | Estilos completos (asiento ilustrado, carrocería, acceso, desfases, leyenda). |
| `SprinterMap.jsx` | Componente React / Next.js (App Router), controlado o no controlado. |
| `sprinter-map.html` | Demo en HTML puro con el marcado de referencia y el selector de orientación. |
| `sprinter-map.js` | Lógica vanilla (ES module) que alimenta la demo. |

## Uso en Next.js

```jsx
import SprinterMap from "@/components/SprinterMap";

<SprinterMap
  capacidad={18}
  orientacion={vista}          // "v" | "h"
  ocupados={[3, 4, 9, 16, 17]}
  maxSeleccion={pasajeros}
  value={asientos}
  onChange={setAsientos}
/>
```

Fuentes requeridas: Barlow y Barlow Condensed (`next/font/google` o `<link>`).

## Orientaciones

- `.sprintermap--v` — vista de planta, frente arriba.
- `.sprintermap--h` — **giro de 90° en contra de las manecillas del reloj**: frente a la izquierda y
  lugar del chofer abajo. La matriz se rota con `rotarCCW()`: `nuevo[i][j] = viejo[j][cols-1-i]`.

Toda la diferencia visual vive en el CSS de cada modificador; el marcado es idéntico.

## Modelo de datos

```js
LAYOUTS[18] = [[0, null, 18, 1], [2, 3, null, 4], [5, 6, null, 7],
               [8, 9, null, 10], [11, 12, null, 13], [14, 15, 16, 17]]
```

- `número` → asiento seleccionable.
- `0` → lugar del conductor (no interactivo).
- `null` → pasillo o hueco; conserva la alineación.

### Desfase de los asientos del pasillo (criterio de QA)

```js
OFFSETS = { 4: 18, 7: 12, 10: 6 }   // px; de 11/12 - 13 en adelante alinean
```

El render escribe `data-offset` en el asiento y el CSS lo traduce a `translateY` (vertical) o
`translateX` (horizontal). Para otra unidad basta cambiar el mapa `OFFSETS` y, si usas valores nuevos,
agregar la regla `[data-offset="N"]` correspondiente.

## Estados

| Estado | Clase | Comportamiento |
| --- | --- | --- |
| Disponible | `.sprintermap__seat` | Respaldo blanco + cojín acento; seleccionable. |
| Seleccionado | `.sprintermap__seat--selected` | Relleno acento oscuro, texto blanco; clic para liberar. |
| Ocupado | `.sprintermap__seat--occupied` + `disabled` | Gris, cursor `not-allowed`, no seleccionable. |
| Conductor | `.sprintermap__driver` | Borde punteado, no interactivo. |
| Hueco / pasillo | `.sprintermap__spacer` | Invisible, `pointer-events: none`. |

Al alcanzar `maxSeleccion` deja de agregar asientos: primero hay que liberar uno.

## Personalización

Variables CSS en `.sprintermap` — mapéalas a tus tokens:

```css
.sprintermap {
  --sp-accent: var(--color-accent);
  --sp-accent-300: var(--color-accent-300);   /* cojín */
  --sp-accent-600: var(--color-accent-600);   /* descansabrazos */
  --sp-accent-700: var(--color-accent-700);   /* seleccionado */
  --sp-shell: #e9eaeb;                        /* carrocería */
  --sp-seat: 52px; --sp-seat-short: 46px; --sp-gap: 14px;
}
```

Nota: `.sprintermap__scroll` reserva `padding-bottom: 38px` para la etiqueta *Acceso* de la vista
horizontal; si la mueves, ajusta ese espacio o se recorta.

## Accesibilidad

Botones nativos con `aria-pressed`, `aria-label` (“Asiento 04 — disponible”), `disabled` real en ocupados,
foco `:focus-visible` de 2 px y `prefers-reduced-motion` respetado. Área táctil de 52 × 46 px (46 × 40 px en móvil).
