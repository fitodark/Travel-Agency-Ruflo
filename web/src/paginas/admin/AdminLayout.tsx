import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import { saludAdmin } from '../../api/admin';
import { Aviso } from '../../componentes/ui';

const SUB: { a: string; t: string }[] = [
  { a: '/admin/sucursales', t: 'Sucursales' },
  { a: '/admin/usuarios', t: 'Usuarios' },
  { a: '/admin/rutas', t: 'Rutas y horarios' },
  { a: '/admin/unidades', t: 'Unidades' },
  { a: '/admin/conductores', t: 'Conductores' },
  { a: '/admin/impresoras', t: 'Impresoras' },
  { a: '/admin/ticket', t: 'Ticket' },
  { a: '/admin/tarifas', t: 'Tarifas' },
];

/**
 * Marco de la sección de administración. Los cambios se escriben en la NUBE, así
 * que necesita conexión: si `/admin/salud` dice que no hay, se avisa y las
 * pantallas quedan solo-lectura (cada una lo maneja).
 */
export function AdminLayout() {
  const salud = useQuery({ queryKey: ['admin', 'salud'], queryFn: saludAdmin, refetchInterval: 30_000 });
  const sinConexion = salud.data?.disponible === false;

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-tinta">Administración</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Los cambios se guardan en la nube y bajan al resto de sucursales al sincronizar.
        </p>
        <nav className="mt-3 flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm shadow-tarjeta">
          {SUB.map((s) => (
            <NavLink
              key={s.a}
              to={s.a}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 font-medium transition ${
                  isActive ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {s.t}
            </NavLink>
          ))}
        </nav>
      </div>

      {sinConexion && (
        <Aviso tono="alerta">
          Sin conexión a la nube. Puedes consultar la configuración, pero no editarla
          hasta que la terminal recupere conexión.
        </Aviso>
      )}

      <div data-sin-conexion={sinConexion || undefined}>
        <Outlet context={{ sinConexion }} />
      </div>
    </div>
  );
}
