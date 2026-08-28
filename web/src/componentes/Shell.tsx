import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSesion } from '../auth/sesion';

const NAV = [
  { a: '/vender', texto: 'Vender' },
  { a: '/sincronizacion', texto: 'Sincronización' },
  { a: '/clientes', texto: 'Clientes' },
];

export function Shell() {
  const { sesion, cerrar } = useSesion();
  const navigate = useNavigate();

  const salir = async () => {
    await cerrar();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-4 py-4 text-lg font-semibold border-b border-slate-700">
          Donaji · Terminal
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {NAV.map((n) => (
            <NavLink
              key={n.a}
              to={n.a}
              className={({ isActive }) =>
                `block rounded px-3 py-2 text-sm ${
                  isActive ? 'bg-slate-700 font-medium' : 'hover:bg-slate-800'
                }`
              }
            >
              {n.texto}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={() => void salir()}
          className="m-2 rounded px-3 py-2 text-sm text-left hover:bg-slate-800"
        >
          Cerrar sesión
        </button>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 shrink-0 bg-white border-b flex items-center justify-end px-4 gap-4 text-sm text-slate-600">
          <span className="capitalize">{sesion?.rol}</span>
          <span className="text-slate-300">·</span>
          <span className="font-mono text-xs">
            sucursal {sesion?.sucursalId?.slice(0, 8) ?? '—'}
          </span>
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
