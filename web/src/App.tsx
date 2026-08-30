import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSesion } from './auth/sesion';
import { corteAbierto } from './api/caja';
import { Shell } from './componentes/Shell';
import { Home } from './paginas/Home';
import { Login } from './paginas/Login';
import { ElegirSucursal } from './paginas/ElegirSucursal';
import { Sincronizacion } from './paginas/Sincronizacion';
import { Clientes } from './paginas/Clientes';
import { Vender } from './paginas/Vender';
import { Caja } from './paginas/Caja';
import { Viajes } from './paginas/Viajes';
import { Dashboard } from './paginas/Dashboard';
import { AdminLayout } from './paginas/admin/AdminLayout';
import { AdminSucursales } from './paginas/admin/Sucursales';
import { AdminUsuarios } from './paginas/admin/Usuarios';
import { AdminImpresoras } from './paginas/admin/Impresoras';
import { AdminTicket } from './paginas/admin/Ticket';
import { AdminTarifas } from './paginas/admin/Tarifas';
import { AdminHorarios } from './paginas/admin/Horarios';
import { AdminUnidades } from './paginas/admin/Unidades';
import { AdminConductores } from './paginas/admin/Conductores';

function Protegida({ children }: { children: React.ReactNode }) {
  const { sesion, cargando, faltaSucursal } = useSesion();
  if (cargando) {
    return <div className="h-full grid place-items-center text-slate-400">Cargando…</div>;
  }
  if (!sesion) return <Navigate to="/login" replace />;
  if (faltaSucursal) return <Navigate to="/elegir-sucursal" replace />;
  return <>{children}</>;
}

/**
 * Regla de QA: no se vende sin un corte de caja abierto. Si no lo hay, `/vender`
 * redirige a `/caja` para abrir el del día.
 */
function RequiereCorte({ children }: { children: React.ReactNode }) {
  const corte = useQuery({ queryKey: ['caja', 'corte'], queryFn: corteAbierto });
  if (corte.isLoading) {
    return <div className="h-full grid place-items-center text-slate-400">Cargando…</div>;
  }
  if (!corte.data) return <Navigate to="/caja" replace state={{ avisoCorte: true }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/elegir-sucursal" element={<ElegirSucursal />} />
      <Route
        element={
          <Protegida>
            <Shell />
          </Protegida>
        }
      >
        <Route index element={<Home />} />
        <Route path="/vender" element={<RequiereCorte><Vender /></RequiereCorte>} />
        <Route path="/caja" element={<Caja />} />
        <Route path="/viajes" element={<Viajes />} />
        <Route path="/tablero" element={<Dashboard />} />
        <Route path="/sincronizacion" element={<Sincronizacion />} />
        <Route path="/clientes" element={<Clientes />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/sucursales" replace />} />
          <Route path="sucursales" element={<AdminSucursales />} />
          <Route path="usuarios" element={<AdminUsuarios />} />
          <Route path="rutas" element={<AdminHorarios />} />
          <Route path="unidades" element={<AdminUnidades />} />
          <Route path="conductores" element={<AdminConductores />} />
          <Route path="impresoras" element={<AdminImpresoras />} />
          <Route path="ticket" element={<AdminTicket />} />
          <Route path="tarifas" element={<AdminTarifas />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
