/**
 * Primitivas de interfaz compartidas. Un solo lenguaje visual para toda la SPA
 * en vez de repetir `rounded border px-3 py-2` en cada pantalla.
 */
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes, InputHTMLAttributes } from 'react';

type Variante = 'primario' | 'fantasma' | 'peligro';

export function Boton({
  variante = 'primario',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variante?: Variante }) {
  const cls = { primario: 'btn-primario', fantasma: 'btn-fantasma', peligro: 'btn-peligro' }[variante];
  return <button className={`${cls} ${className}`} {...props} />;
}

export function BotonSutil({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`btn-sutil ${className}`} {...props} />;
}

export function Tarjeta({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`tarjeta ${className}`}>{children}</div>;
}

/** Encabezado de sección: título + subtítulo + acciones a la derecha. */
export function EncabezadoPagina({
  titulo,
  descripcion,
  acciones,
}: {
  titulo: string;
  descripcion?: string;
  acciones?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-tinta">{titulo}</h1>
        {descripcion && <p className="mt-0.5 max-w-2xl text-sm text-slate-500">{descripcion}</p>}
      </div>
      {acciones && <div className="flex items-center gap-2">{acciones}</div>}
    </div>
  );
}

export function Campo({
  etiqueta,
  className = '',
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { etiqueta: string; hint?: string }) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block font-medium text-slate-700">{etiqueta}</span>
      <input className="campo" {...props} />
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export function CampoSelect({
  etiqueta,
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { etiqueta: string }) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block font-medium text-slate-700">{etiqueta}</span>
      <select className="campo" {...props}>{children}</select>
    </label>
  );
}

type EstadoChip = 'ok' | 'baja' | 'alerta' | 'error';
export function Chip({ estado = 'ok', children }: { estado?: EstadoChip; children: ReactNode }) {
  const cls = { ok: 'chip-ok', baja: 'chip-baja', alerta: 'chip-alerta', error: 'chip-error' }[estado];
  return <span className={cls}>{children}</span>;
}

/** Tabla con cabecera, zebra sutil y hover. `cols` define encabezado + celdas. */
export interface Columna<T> {
  clave: string;
  th: ReactNode;
  td: (fila: T) => ReactNode;
  className?: string;
}
export function Tabla<T>({
  cols,
  filas,
  claveFila,
  vacio = 'Sin datos.',
}: {
  cols: Columna<T>[];
  filas: T[] | undefined;
  claveFila: (fila: T) => string;
  vacio?: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200/80 bg-white shadow-tarjeta">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            {cols.map((c) => (
              <th key={c.clave} className={`px-4 py-2.5 ${c.className ?? ''}`}>{c.th}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filas?.map((f) => (
            <tr key={claveFila(f)} className="transition hover:bg-brand-50/40">
              {cols.map((c) => (
                <td key={c.clave} className={`px-4 py-3 align-top ${c.className ?? ''}`}>{c.td(f)}</td>
              ))}
            </tr>
          ))}
          {filas?.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="px-4 py-10 text-center text-sm text-slate-400">{vacio}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Aviso({
  tono = 'info',
  children,
  onCerrar,
}: {
  tono?: 'info' | 'alerta' | 'error';
  children: ReactNode;
  onCerrar?: () => void;
}) {
  const cls = {
    info: 'border-brand-200 bg-brand-50 text-brand-900',
    alerta: 'border-arena-300 bg-arena-50 text-arena-900',
    error: 'border-red-200 bg-red-50 text-red-800',
  }[tono];
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm ${cls}`}>
      <div>{children}</div>
      {onCerrar && (
        <button onClick={onCerrar} className="shrink-0 text-xs underline underline-offset-2">cerrar</button>
      )}
    </div>
  );
}

export function Cargando({ texto = 'Cargando…' }: { texto?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-400">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" />
      {texto}
    </div>
  );
}
