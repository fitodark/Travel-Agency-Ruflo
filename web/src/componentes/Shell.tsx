import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { cambiarSucursal } from '../api/auth';
import { useSesion } from '../auth/sesion';
import { Icono } from './iconos';

interface ItemNav { a: string; texto: string; icono: string; permiso?: string }

const NAV_OPERACION: ItemNav[] = [
  { a: '/vender', texto: 'Vender', icono: 'vender' },
  { a: '/caja', texto: 'Caja', icono: 'caja' },
  { a: '/viajes', texto: 'Viajes', icono: 'viajes' },
  { a: '/tablero', texto: 'Tablero', icono: 'tablero', permiso: 'dashboard.ver' },
  { a: '/sincronizacion', texto: 'Sincronización', icono: 'sync' },
  { a: '/clientes', texto: 'Clientes', icono: 'clientes' },
];

// Administración: un administrador la usa DESDE la terminal; los cambios se
// escriben en la nube y bajan replicados al resto de sucursales.
const NAV_ADMIN: ItemNav[] = [
  { a: '/admin/sucursales', texto: 'Sucursales', icono: 'sucursales', permiso: 'config.sucursales' },
  { a: '/admin/usuarios', texto: 'Usuarios', icono: 'usuarios', permiso: 'config.usuarios' },
  { a: '/admin/rutas', texto: 'Rutas y horarios', icono: 'rutas', permiso: 'config.horarios' },
  { a: '/admin/impresoras', texto: 'Impresoras', icono: 'impresoras', permiso: 'config.impresoras' },
  { a: '/admin/ticket', texto: 'Ticket', icono: 'ticket', permiso: 'config.impresoras' },
  { a: '/admin/tarifas', texto: 'Tarifas', icono: 'tarifas', permiso: 'config.tarifas' },
];

const CLAVE_COLAPSO = 'donaji.nav.colapsado';
const leerColapso = (): boolean => {
  try { return localStorage.getItem(CLAVE_COLAPSO) === '1'; } catch { return false; }
};

function Enlace({ item, colapsado }: { item: ItemNav; colapsado: boolean }) {
  return (
    <NavLink
      to={item.a}
      title={colapsado ? item.texto : undefined}
      className={({ isActive }) =>
        [
          'group flex items-center rounded-lg text-sm transition',
          colapsado ? 'justify-center py-2.5' : 'gap-3 px-3 py-2',
          isActive ? 'bg-white/10 font-medium text-white' : 'text-brand-100/80 hover:bg-white/5 hover:text-white',
        ].join(' ')
      }
    >
      {({ isActive }) => (
        <>
          <span className={`shrink-0 transition ${isActive ? 'text-white' : 'text-brand-200/70 group-hover:text-white'}`}>
            <Icono nombre={item.icono} />
          </span>
          {!colapsado && <span className="truncate">{item.texto}</span>}
        </>
      )}
    </NavLink>
  );
}

function BotonSidebar(
  { icono, texto, colapsado, onClick, rotarIcono = false }:
  { icono: string; texto: string; colapsado: boolean; onClick: () => void; rotarIcono?: boolean },
) {
  return (
    <button
      onClick={onClick}
      title={colapsado ? texto : undefined}
      className={[
        'flex w-full items-center rounded-lg py-2 text-sm text-brand-200/80 transition hover:bg-white/5 hover:text-white',
        colapsado ? 'justify-center' : 'gap-3 px-3',
      ].join(' ')}
    >
      <span className={`shrink-0 transition-transform ${rotarIcono && colapsado ? 'rotate-180' : ''}`}>
        <Icono nombre={icono} />
      </span>
      {!colapsado && <span>{texto}</span>}
    </button>
  );
}

function SelectorSucursal() {
  const { sesion, refrescar } = useSesion();
  const [cambiando, setCambiando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sesion) return null;

  const sucursales = sesion.sucursales;
  const nombre = sesion.sucursalNombre ?? '—';

  if (sucursales.length <= 1) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-brand-50 px-2.5 py-1 font-medium text-brand-800">
        <Icono nombre="sucursales" width={14} height={14} />
        {nombre}
      </span>
    );
  }

  const elegir = async (id: string) => {
    if (id === sesion.sucursalId) return;
    setError(null);
    setCambiando(true);
    try {
      await cambiarSucursal(id);
      await refrescar();
    } catch {
      setError('No se pudo cambiar (¿corte de caja abierto?)');
    } finally {
      setCambiando(false);
    }
  };

  return (
    <span className="flex items-center gap-2">
      <span className="text-brand-600"><Icono nombre="sucursales" width={15} height={15} /></span>
      <select
        value={sesion.sucursalId ?? ''}
        disabled={cambiando}
        onChange={(e) => void elegir(e.target.value)}
        className="campo-sm font-medium text-slate-700 disabled:opacity-50"
        aria-label="Sucursal"
      >
        {sucursales.map((s) => (
          <option key={s.id} value={s.id}>{s.nombre}</option>
        ))}
      </select>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

export function Shell() {
  const { sesion, cerrar, puede } = useSesion();
  const navigate = useNavigate();
  const [colapsado, setColapsado] = useState(leerColapso);

  useEffect(() => {
    try { localStorage.setItem(CLAVE_COLAPSO, colapsado ? '1' : '0'); } catch { /* ventana privada */ }
  }, [colapsado]);

  const permitido = (n: ItemNav) => !n.permiso || puede(n.permiso);
  const navOperacion = NAV_OPERACION.filter(permitido);
  const navAdmin = NAV_ADMIN.filter(permitido);

  const salir = async () => {
    await cerrar();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex h-full bg-lienzo">
      <aside
        className={[
          'flex shrink-0 flex-col bg-brand-950 text-brand-50 transition-[width] duration-200 ease-out',
          colapsado ? 'w-16 px-2' : 'w-60 px-2',
        ].join(' ')}
      >
        <div className={`flex h-14 items-center ${colapsado ? 'justify-center' : 'px-1'}`}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">
            D
          </span>
          {!colapsado && (
            <span className="ml-2.5 text-sm font-semibold tracking-tight">
              Donaji <span className="font-normal text-brand-300">· Terminal</span>
            </span>
          )}
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto py-2">
          {navOperacion.map((n) => <Enlace key={n.a} item={n} colapsado={colapsado} />)}
          {navAdmin.length > 0 && (
            <>
              <div className={`pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-brand-400 ${colapsado ? 'text-center' : 'px-3'}`}>
                {colapsado ? '· · ·' : 'Administración'}
              </div>
              {navAdmin.map((n) => <Enlace key={n.a} item={n} colapsado={colapsado} />)}
            </>
          )}
        </nav>

        <div className="space-y-1 border-t border-white/10 py-2">
          <BotonSidebar
            icono="panel"
            texto="Colapsar"
            colapsado={colapsado}
            rotarIcono
            onClick={() => setColapsado((v) => !v)}
          />
          <BotonSidebar icono="salir" texto="Cerrar sesión" colapsado={colapsado} onClick={() => void salir()} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b border-slate-200 bg-white px-5 text-sm text-slate-600">
          <span className="inline-flex items-center gap-1.5 capitalize text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            {sesion?.rol}
          </span>
          <span className="h-4 w-px bg-slate-200" />
          <SelectorSucursal />
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
