-- =============================================================================
-- SEED · Parámetros operativos y matriz de permisos.
--
-- Todos los SUPUESTOS numéricos del blueprint viven aquí, no en constantes de
-- código: validar un supuesto con el cliente debe costar una fila, no un
-- despliegue. Bajo el delta D-8 eso importa el doble, porque desplegar significa
-- que un humano visite 4 terminales por TeamViewer de madrugada.
-- =============================================================================

INSERT INTO core.parametro (clave, valor, descripcion) VALUES
  ('horizonte_materializacion_dias', '90',
   'SUPUESTO S6. Días hacia adelante que se materializan salidas. Debe cubrir el '
   'peor corte de conexión plausible: una sucursal offline solo puede vender los '
   'viajes que ya tiene materializados localmente.'),

  ('minutos_cierre_venta', '15',
   'SUPUESTO S4. Cierre de venta antes de la hora de paso por esa parada.'),

  ('horas_expiracion_cupo', '4',
   'SUPUESTO S5. Los asientos no vendidos del cupo de una sucursal intermedia '
   'regresan al pool a T-4h. La expiración es una FUNCIÓN DEL TIEMPO, no un '
   'mensaje: la sucursal y la nube llegan a la misma conclusión sin hablarse.'),

  ('minutos_lease', '15',
   'Duración del lease de asiento. Cubre los pasos 3 a 6 del flujo con holgura. '
   'Si la red cae después de concederlo, la venta se completa igual.'),

  ('minutos_zona_muerta', '15',
   'Margen de seguridad alrededor de la expiración de cupos. Ninguna deriva de '
   'reloj menor a este valor puede producir doble venta.'),

  ('umbral_sync_degradado_horas', '72',
   'SUPUESTO S9. Sin sincronizar más de este tiempo, el nodo entra en modo '
   'degradado: sigue vendiendo (D1 es innegociable) pero bloquea el primer login '
   'de usuarios inactivos y prohíbe overrides de asiento.'),

  ('ventana_config_hora', '"03:00"',
   'Hora local de la sucursal en que se aplican los cambios de configuración.'),

  ('deriva_reloj_alerta_seg', '120',
   'Deriva de reloj que dispara alerta. NTP queda activo por el instalador (D-5).'),

  ('deriva_reloj_degradado_seg', '300',
   'Deriva que fuerza modo degradado: exige conexión para vender cerca de la '
   'frontera de expiración de cupos.'),

  ('respaldo_intervalo_minutos', '60',
   'D-2. Con una sola PC por sucursal (D-1) el respaldo local es la ÚNICA '
   'defensa contra perder la operación de la terminal. A medio EXTERNO dedicado, '
   'nunca al mismo disco.'),

  ('respaldo_retencion_dias', '7', 'Retención del respaldo local.'),

  ('retencion_local_meses', '18',
   'SUPUESTO S10. Datos en caliente en el nodo. La nube es el archivo completo.'),

  ('sync_push_lote', '500',   'Filas por lote de push.'),
  ('sync_push_segundos', '5', 'Cadencia de push en operación normal.'),
  ('sync_pull_segundos', '30','Cadencia de pull en operación normal.'),

  ('dias_convivencia_version_minimo', '14',
   'D-8. Un nodo en versión N-1 debe operar contra la nube N al menos este '
   'tiempo sin degradación. Si una migración no puede cumplirlo, se parte en dos '
   'releases.')
ON CONFLICT (clave) DO NOTHING;


-- =============================================================================
-- Matriz de permisos como DATO, no como `if` en el código.
-- Permite ajustar permisos sin desplegar.
-- =============================================================================
INSERT INTO core.rol_permiso (rol, permiso) VALUES
  -- vendedor
  ('vendedor',      'venta.crear'),
  ('vendedor',      'venta.reservar'),
  ('vendedor',      'corte.abrir'),
  ('vendedor',      'corte.cerrar'),
  ('vendedor',      'movimiento.egreso.crear'),
  ('vendedor',      'ticket.reimprimir'),
  ('vendedor',      'abordaje.registrar'),
  ('vendedor',      'conductor.cambiar.compatible'),

  -- gerente: todo lo del vendedor, más supervisión.
  -- Req: "el gerente SOLO podrá ver los registros activos del corte de caja".
  ('gerente',       'venta.crear'),
  ('gerente',       'venta.reservar'),
  ('gerente',       'venta.anular'),
  ('gerente',       'corte.abrir'),
  ('gerente',       'corte.cerrar'),
  ('gerente',       'movimiento.egreso.crear'),
  ('gerente',       'movimiento.anular'),
  ('gerente',       'ticket.reimprimir'),
  ('gerente',       'abordaje.registrar'),
  ('gerente',       'excepcion.resolver'),
  ('gerente',       'asiento.override'),
  ('gerente',       'conductor.cambiar.compatible'),
  ('gerente',       'conductor.cambiar.incompatible'),

  -- administrador: además configura y audita.
  -- Req: "el administrador podrá ver TODOS los registros activos e inactivos
  -- del corte del día (para visualizar posibles malos manejos)".
  ('administrador', 'venta.crear'),
  ('administrador', 'venta.reservar'),
  ('administrador', 'venta.anular'),
  ('administrador', 'corte.abrir'),
  ('administrador', 'corte.cerrar'),
  ('administrador', 'movimiento.egreso.crear'),
  ('administrador', 'movimiento.anular'),
  ('administrador', 'movimiento.ver_inactivos'),
  ('administrador', 'ticket.reimprimir'),
  ('administrador', 'abordaje.registrar'),
  ('administrador', 'excepcion.resolver'),
  ('administrador', 'asiento.override'),
  ('administrador', 'conductor.cambiar.compatible'),
  ('administrador', 'conductor.cambiar.incompatible'),
  ('administrador', 'config.horarios'),
  ('administrador', 'config.usuarios'),
  ('administrador', 'config.tarifas'),
  ('administrador', 'config.sucursales'),
  ('administrador', 'config.impresoras'),
  ('administrador', 'dashboard.ver'),
  ('administrador', 'auditoria.ver')
ON CONFLICT DO NOTHING;
