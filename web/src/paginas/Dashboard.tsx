import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  excepciones, gastos, reporteCortes, reporteVentas, saludSucursales, ventasVsCaja,
  type Rango, type Severidad,
} from '../api/reportes';
import { useSesion } from '../auth/sesion';

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const rangoInicial = (): Rango => {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - 29 * 86_400_000);
  return { desde: iso(desde), hasta: iso(hasta) };
};

const money = (n: number): string =>
  n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

const TABS = ['Ventas', 'Ventas vs. caja', 'Cortes', 'Gastos', 'Salud', 'Excepciones'] as const;
type Tab = (typeof TABS)[number];

const SEV_COLOR: Record<Severidad, string> = {
  critica: 'bg-red-100 text-red-700',
  alta: 'bg-orange-100 text-orange-700',
  media: 'bg-amber-100 text-amber-700',
  baja: 'bg-slate-100 text-slate-600',
};

export function Dashboard() {
  const { puede } = useSesion();
  const [rango, setRango] = useState<Rango>(rangoInicial);
  const [tab, setTab] = useState<Tab>('Ventas');

  if (!puede('dashboard.ver')) {
    return <p className="text-sm text-slate-500">El tablero es solo para administradores.</p>;
  }

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Tablero</h1>
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <input
            type="date" value={rango.desde}
            onChange={(e) => setRango((r) => ({ ...r, desde: e.target.value }))}
            className="rounded border px-2 py-1"
          />
          <span>—</span>
          <input
            type="date" value={rango.hasta}
            onChange={(e) => setRango((r) => ({ ...r, hasta: e.target.value }))}
            className="rounded border px-2 py-1"
          />
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Números de esta terminal (base local). El consolidado de las sucursales vive en
        el tablero en nube.
      </p>

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${
              tab === t ? 'border-slate-900 font-medium' : 'border-transparent text-slate-500'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Ventas' && <Ventas rango={rango} />}
      {tab === 'Ventas vs. caja' && <VentasVsCaja rango={rango} />}
      {tab === 'Cortes' && <Cortes rango={rango} />}
      {tab === 'Gastos' && <Gastos rango={rango} />}
      {tab === 'Salud' && <Salud />}
      {tab === 'Excepciones' && <Excepciones />}
    </div>
  );
}

function Tabla<T>({
  q, columnas,
}: {
  q: { data?: T[]; isLoading: boolean; isError: boolean };
  columnas: { titulo: string; celda: (fila: T) => React.ReactNode; alDerecha?: boolean }[];
}) {
  if (q.isLoading) return <p className="text-sm text-slate-400">Cargando…</p>;
  if (q.isError) return <p className="text-sm text-red-600">No se pudo cargar.</p>;
  if (!q.data || q.data.length === 0) {
    return <p className="text-sm text-slate-400">Sin datos en el rango.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-tarjeta">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            {columnas.map((c) => (
              <th key={c.titulo} className={`px-3 py-2 ${c.alDerecha ? 'text-right' : ''}`}>
                {c.titulo}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {q.data.map((fila, i) => (
            <tr key={i} className="border-t border-slate-100 transition hover:bg-brand-50/40">
              {columnas.map((c) => (
                <td key={c.titulo} className={`px-3 py-2 ${c.alDerecha ? 'text-right' : ''}`}>
                  {c.celda(fila)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ventas({ rango }: { rango: Rango }) {
  const q = useQuery({ queryKey: ['rep', 'ventas', rango], queryFn: () => reporteVentas(rango) });
  return (
    <Tabla
      q={q}
      columnas={[
        { titulo: 'Día', celda: (f) => f.dia },
        { titulo: 'Sucursal', celda: (f) => f.sucursal },
        { titulo: 'Ops', celda: (f) => f.operaciones, alDerecha: true },
        { titulo: 'Boletos', celda: (f) => f.boletos, alDerecha: true },
        { titulo: 'Reserv.', celda: (f) => f.reservaciones, alDerecha: true },
        { titulo: 'Vendido', celda: (f) => money(f.importeVendido), alDerecha: true },
        { titulo: 'Liquidado', celda: (f) => money(f.importeLiquidado), alDerecha: true },
      ]}
    />
  );
}

function VentasVsCaja({ rango }: { rango: Rango }) {
  const q = useQuery({
    queryKey: ['rep', 'vc', rango], queryFn: () => ventasVsCaja(rango),
  });
  return (
    <Tabla
      q={q}
      columnas={[
        { titulo: 'Sucursal', celda: (f) => f.sucursal },
        { titulo: 'Vendido', celda: (f) => money(f.importeVendido), alDerecha: true },
        { titulo: 'A caja', celda: (f) => money(f.ingresoACaja), alDerecha: true },
        {
          titulo: 'Diferencia',
          alDerecha: true,
          celda: (f) => (
            <span className={f.diferencia === 0 ? '' : 'text-amber-700'}>{money(f.diferencia)}</span>
          ),
        },
        { titulo: 'Nota', celda: (f) => <span className="text-xs text-slate-500">{f.nota}</span> },
      ]}
    />
  );
}

function Cortes({ rango }: { rango: Rango }) {
  const q = useQuery({ queryKey: ['rep', 'cortes', rango], queryFn: () => reporteCortes(rango) });
  return (
    <Tabla
      q={q}
      columnas={[
        { titulo: 'Sucursal', celda: (f) => f.sucursal },
        { titulo: 'Abierto', celda: (f) => new Date(f.abiertoEn).toLocaleString() },
        { titulo: 'Estado', celda: (f) => f.estado },
        { titulo: 'Inicial', celda: (f) => money(f.saldoInicial), alDerecha: true },
        { titulo: 'Ingresos', celda: (f) => money(f.ingresos), alDerecha: true },
        { titulo: 'Egresos', celda: (f) => money(f.egresos), alDerecha: true },
        { titulo: 'Calculado', celda: (f) => money(f.saldoCalculado), alDerecha: true },
        {
          titulo: 'Diferencia',
          alDerecha: true,
          celda: (f) =>
            f.diferencia === null ? '—' : (
              <span className={f.diferencia === 0 ? '' : 'text-red-700'}>{money(f.diferencia)}</span>
            ),
        },
      ]}
    />
  );
}

function Gastos({ rango }: { rango: Rango }) {
  const q = useQuery({ queryKey: ['rep', 'gastos', rango], queryFn: () => gastos(rango) });
  return (
    <Tabla
      q={q}
      columnas={[
        { titulo: 'Concepto', celda: (f) => f.concepto },
        { titulo: 'Sucursal', celda: (f) => f.sucursal ?? '—' },
        { titulo: 'Movs.', celda: (f) => f.movimientos, alDerecha: true },
        { titulo: 'Monto', celda: (f) => money(f.monto), alDerecha: true },
      ]}
    />
  );
}

function Salud() {
  const q = useQuery({ queryKey: ['rep', 'salud'], queryFn: saludSucursales });
  return (
    <Tabla
      q={q}
      columnas={[
        { titulo: 'Sucursal', celda: (f) => f.sucursal },
        {
          titulo: 'Estado',
          celda: (f) =>
            f.degradado === null
              ? <span className="text-slate-400">nunca reportó</span>
              : f.degradado
                ? <span className="text-red-700">degradado</span>
                : <span className="text-green-700">al día</span>,
        },
        {
          titulo: 'Atraso',
          alDerecha: true,
          celda: (f) => (f.atrasoHoras === null ? '—' : `${f.atrasoHoras.toFixed(1)} h`),
        },
        { titulo: 'Outbox', celda: (f) => f.outboxPendiente ?? '—', alDerecha: true },
        { titulo: 'Exc. críticas', celda: (f) => f.excepcionesCriticas ?? '—', alDerecha: true },
        { titulo: 'Esquema', celda: (f) => f.versionEsquema ?? '—' },
      ]}
    />
  );
}

function Excepciones() {
  const q = useQuery({ queryKey: ['rep', 'excepciones'], queryFn: excepciones });
  if (q.isLoading) return <p className="text-sm text-slate-400">Cargando…</p>;
  if (q.isError || !q.data) return <p className="text-sm text-red-600">No se pudo cargar.</p>;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['critica', 'alta', 'media', 'baja'] as Severidad[]).map((s) => (
          <span key={s} className={`rounded px-2 py-1 text-xs ${SEV_COLOR[s]}`}>
            {s}: {q.data.resumen[s]}
          </span>
        ))}
      </div>
      {q.data.abiertas.length === 0 ? (
        <p className="text-sm text-slate-400">Ninguna excepción abierta.</p>
      ) : (
        <ul className="space-y-2">
          {q.data.abiertas.map((e) => (
            <li key={e.excepcionId} className="tarjeta p-3 text-sm">
              <span className={`inline-block rounded px-2 py-0.5 text-xs mr-2 ${SEV_COLOR[e.severidad]}`}>
                {e.severidad}
              </span>
              <span className="font-medium">{e.tipo}</span>
              {e.sucursal && <span className="text-slate-500"> · {e.sucursal}</span>}
              {e.entidad && <span className="text-slate-400"> · {e.entidad}</span>}
              <span className="text-slate-400"> · hace {e.antiguedadHoras.toFixed(0)} h</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
