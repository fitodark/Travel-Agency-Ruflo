import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import { saludAdmin } from '../../api/admin';

const SUB: { a: string; t: string }[] = [
  { a: '/admin/sucursales', t: 'Sucursales' },
  { a: '/admin/usuarios', t: 'Usuarios' },
  { a: '/admin/rutas', t: 'Rutas y horarios' },
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
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">Administración</h1>
        <nav className="flex gap-1 text-sm">
          {SUB.map((s) => (
            <NavLink
              key={s.a}
              to={s.a}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 ${isActive ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`
              }
            >
              {s.t}
            </NavLink>
          ))}
        </nav>
      </div>

      {sinConexion && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Sin conexión a la nube. Puedes consultar la configuración, pero no editarla
          hasta que la terminal recupere conexión.
        </div>
      )}

      <div data-sin-conexion={sinConexion || undefined}>
        <Outlet context={{ sinConexion }} />
      </div>
    </div>
  );
}
