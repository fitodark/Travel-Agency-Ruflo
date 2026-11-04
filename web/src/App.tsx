import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSesion } from './auth/sesion';
import { corteAbierto } from './api/caja';
import { Shell } from './componentes/Shell';
import { RequiereSucursal } from './componentes/RequiereSucursal';
import { Home } from './paginas/Home';
import { Login } from './paginas/Login';
import { ElegirSucursal } from './paginas/ElegirSucursal';
import { Sincronizacion } from './paginas/Sincronizacion';
import { Clientes } from './paginas/Clientes';
import { Vender } from './paginas/Vender';
import { Caja } from './paginas/Caja';
import { Viajes } from './paginas/Viajes';
import { Paqueteria } from './paginas/Paqueteria';
import { Verificar } from './paginas/Verificar';
import { Dashboard } from './paginas/Dashboard';
import { HistorialCortes } from './paginas/HistorialCortes';
import { HistorialCorteMovimientos } from './paginas/HistorialCorteMovimientos';
import { AdminLayout } from './paginas/admin/AdminLayout';
import { AdminSucursales } from './paginas/admin/Sucursales';
import { AdminUsuarios } from './paginas/admin/Usuarios';
import { AdminImpresoras } from './paginas/admin/Impresoras';
import { AdminTicket } from './paginas/admin/Ticket';
import { AdminTarifas } from './paginas/admin/Tarifas';
import { AdminHorarios } from './paginas/admin/Horarios';
import { AdminPuntos } from './paginas/admin/Puntos';
import { AdminUnidades } from './paginas/admin/Unidades';
import { AdminConductores } from './paginas/admin/Conductores';

function Protegida({ children }: { children: React.ReactNode }) {
  const { sesion, cargando, faltaSucursal } = useSesion();
  if (cargando) {
    return <div className="h-full grid place-items-center text-slate-400">Cargando…</div>;
  }
  if (!sesion) return <Navigate to="/login" replace />;
  // En modo consulta (sin sucursal a propósito) NO se redirige a elegir
  // sucursal: cada pantalla operativa decide si la necesita (`<RequiereSucursal>`).
  if (faltaSucursal) return <Navigate to="/elegir-sucursal" replace />;
  return <>{children}</>;
}

/**
 * Regla de QA: no se vende sin un corte de caja abierto. Si no lo hay, `/vender`
 * redirige a `/caja` para abrir el del día.
 */
function RequiereCorte({ children }: { children: React.ReactNode }) {
  const { sesion } = useSesion();
  const corte = useQuery({
    queryKey: ['caja', 'corte'], queryFn: corteAbierto, enabled: !!sesion?.sucursalId,
  });
  if (!sesion?.sucursalId) return null; // `<RequiereSucursal>` ya está mostrando el diálogo
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
        <Route
          path="/vender"
          element={<RequiereSucursal><RequiereCorte><Vender /></RequiereCorte></RequiereSucursal>}
        />
        <Route path="/caja" element={<Caja />} />
        <Route path="/viajes" element={<RequiereSucursal><Viajes /></RequiereSucursal>} />
        <Route path="/paqueteria" element={<RequiereSucursal><Paqueteria /></RequiereSucursal>} />
        <Route path="/verificar" element={<RequiereSucursal><Verificar /></RequiereSucursal>} />
        <Route path="/tablero" element={<Dashboard />} />
        <Route path="/historial" element={<HistorialCortes />} />
        <Route path="/historial/:id/movimientos" element={<HistorialCorteMovimientos />} />
        <Route
          path="/sincronizacion"
          element={<RequiereSucursal><Sincronizacion /></RequiereSucursal>}
        />
        <Route path="/clientes" element={<RequiereSucursal><Clientes /></RequiereSucursal>} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/sucursales" replace />} />
          <Route path="sucursales" element={<AdminSucursales />} />
          <Route path="usuarios" element={<AdminUsuarios />} />
          <Route path="rutas" element={<AdminHorarios />} />
          <Route path="puntos" element={<AdminPuntos />} />
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
