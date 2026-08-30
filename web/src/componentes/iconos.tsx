/**
 * Iconos SVG en línea (sin dependencia externa — la terminal opera offline).
 * Trazo de 1.6, 24x24, `currentColor`.
 */
import type { ReactElement, SVGProps } from 'react';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const RUTAS: Record<string, ReactElement> = {
  inicio: <><path d="M4 11.5 12 4l8 7.5M6 10v10h12V10" {...P} /><path d="M10 20v-6h4v6" {...P} /></>,
  vender: <><path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5z" {...P} /><path d="m3 8.5 9 4.5 9-4.5M12 13v7" {...P} /></>,
  caja: <><rect x="3" y="6" width="18" height="12" rx="2" {...P} /><path d="M3 10h18M7 15h3" {...P} /></>,
  viajes: <><rect x="4" y="4" width="16" height="13" rx="2" {...P} /><path d="M4 11h16M8 21v-1M16 21v-1M7 17v1M17 17v1" {...P} /><circle cx="8" cy="14" r="1" fill="currentColor" /><circle cx="16" cy="14" r="1" fill="currentColor" /></>,
  tablero: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" {...P} /></>,
  sync: <><path d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4" {...P} /></>,
  clientes: <><circle cx="9" cy="8" r="3" {...P} /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 8a3 3 0 0 1 0 6M17 19a5.5 5.5 0 0 0-3-4.9" {...P} /></>,
  sucursales: <><path d="M4 21V7l8-4 8 4v14M4 21h16" {...P} /><path d="M9 21v-5h6v5M9 10h1M14 10h1M9 13h1M14 13h1" {...P} /></>,
  usuarios: <><circle cx="10" cy="8" r="3.2" {...P} /><path d="M3.5 20a6.5 6.5 0 0 1 13 0" {...P} /><path d="M17.5 13.5v3M16 15h3" {...P} /></>,
  rutas: <><circle cx="6" cy="7" r="2" {...P} /><circle cx="18" cy="17" r="2" {...P} /><path d="M8 7h6a3 3 0 0 1 0 6H10a3 3 0 0 0 0 6h6" {...P} /></>,
  unidades: <><path d="M3 13l1.5-5A2 2 0 0 1 6.4 6.5h11.2a2 2 0 0 1 1.9 1.5L21 13v5h-2M3 18v-5m0 5h2m14 0h-8" {...P} /><circle cx="7.5" cy="18" r="1.6" {...P} /><circle cx="16.5" cy="18" r="1.6" {...P} /></>,
  conductores: <><circle cx="12" cy="7" r="3" {...P} /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" {...P} /><circle cx="12" cy="13.5" r="6.5" {...P} /></>,
  impresoras: <><path d="M7 9V4h10v5" {...P} /><rect x="4" y="9" width="16" height="8" rx="2" {...P} /><path d="M7 14h10v6H7z" {...P} /><circle cx="17" cy="12" r="0.9" fill="currentColor" /></>,
  ticket: <><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 6v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-6z" {...P} /><path d="M14 4v16" strokeDasharray="1.5 2.5" {...P} /></>,
  tarifas: <><circle cx="12" cy="12" r="8" {...P} /><path d="M15 9a3 3 0 0 0-3-2c-1.7 0-3 1-3 2.3 0 3 6 1.7 6 4.7C15 17.2 13.7 18 12 18a3 3 0 0 1-3-2M12 6v1.5M12 16.5V18" {...P} /></>,
  salir: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" {...P} /></>,
  panel: <><path d="M9 5 4 12l5 7M20 12H5" {...P} /></>,
};

export function Icono({ nombre, ...rest }: SVGProps<SVGSVGElement> & { nombre: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden {...rest}>
      {RUTAS[nombre] ?? RUTAS['panel']}
    </svg>
  );
}
