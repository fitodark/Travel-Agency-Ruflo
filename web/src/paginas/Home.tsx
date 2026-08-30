import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { corteAbierto } from '../api/caja';
import { useSesion } from '../auth/sesion';
import { Icono } from '../componentes/iconos';

/**
 * Pantalla de inicio. A ella se redirige al iniciar sesión en cualquier sucursal.
 *
 * Por ahora: bienvenida + estado del corte de caja. Más adelante puede llevar el
 * reporte del corte activo, avisos de la sucursal, etc.
 *
 * Regla de QA: no se puede vender sin un corte de caja abierto. Desde aquí, el
 * acceso "Vender" lleva a `/caja` mientras no haya corte (y `/vender` también
 * redirige por su cuenta — ver `RequiereCorte` en `App.tsx`).
 */
export function Home() {
  const { sesion } = useSesion();
  const corte = useQuery({ queryKey: ['caja', 'corte'], queryFn: corteAbierto });
  const hayCorte = Boolean(corte.data);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-tinta">
          Bienvenido a {sesion?.sucursalNombre ?? 'la terminal'}
        </h1>
        <p className="mt-1 text-sm capitalize text-slate-500">
          {sesion?.rol ?? 'terminal de venta'}
        </p>
      </div>

      <div className="tarjeta p-5">
        {corte.isLoading ? (
          <p className="text-sm text-slate-400">Consultando el corte de caja…</p>
        ) : hayCorte ? (
          <>
            <div className="flex items-center gap-2 text-sm font-medium text-brand-800">
              <span className="h-2 w-2 rounded-full bg-brand-500" />
              Corte de caja abierto
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Cifra t="Saldo inicial" v={corte.data!.saldoInicial} />
              <Cifra t="Ingresos" v={corte.data!.ingresos} />
              <Cifra t="Egresos" v={corte.data!.egresos} />
              <Cifra t="En caja" v={corte.data!.saldoCalculado} fuerte />
            </div>
            <Link to="/caja" className="btn-fantasma mt-4 inline-flex">Ver caja</Link>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm font-medium text-amber-700">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              No hay corte de caja abierto
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Para vender boletos primero hay que abrir el corte del día.
            </p>
            <Link to="/caja" className="btn-primario mt-4 inline-flex">Abrir corte del día</Link>
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {/* Siempre va a /vender; si no hay corte, RequiereCorte redirige a /caja. */}
        <Acceso
          icono="vender" titulo="Vender" to="/vender"
          sub={hayCorte ? 'Nuevo boleto' : 'Requiere el corte abierto'}
        />
        <Acceso icono="caja" titulo="Caja" sub="Corte, ingresos y egresos" to="/caja" />
        <Acceso icono="viajes" titulo="Viajes" sub="Salidas del día y abordaje" to="/viajes" />
      </div>
    </div>
  );
}

function Cifra({ t, v, fuerte }: { t: string; v: number; fuerte?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200/70 bg-slate-50/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{t}</div>
      <div className={`mt-0.5 ${fuerte ? 'text-base font-semibold text-tinta' : 'text-sm'}`}>${v}</div>
    </div>
  );
}

function Acceso({ icono, titulo, sub, to }: { icono: string; titulo: string; sub: string; to: string }) {
  return (
    <Link
      to={to}
      className="tarjeta flex flex-col gap-1 p-4 transition hover:border-brand-300 hover:shadow-panel"
    >
      <span className="text-brand-600"><Icono nombre={icono} /></span>
      <span className="mt-1 font-medium">{titulo}</span>
      <span className="text-xs text-slate-500">{sub}</span>
    </Link>
  );
}
