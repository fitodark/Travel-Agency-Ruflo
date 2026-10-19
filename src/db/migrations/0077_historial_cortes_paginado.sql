-- =============================================================================
-- 0077 · Historial de cortes en pantalla propia: paginado + filtro por usuario
--        + detalle de pago. docs/architecture/02b-modelo-transaccional.md §3
--
-- QA: "Caja" mezclaba la operación del corte activo con un historial completo.
-- Se separan en dos pantallas (admin/gerente): "Historial de Cortes" (lista
-- paginada) y "/historial/:id/movimientos" (detalle). El historial puede
-- crecer mucho en registros — necesita paginado real en SQL, no traer todo y
-- cortar en el cliente.
--
-- QUÉ CAMBIA:
--  1. `core.f_cortes_visibles` gana `p_usuario_apertura_id`, `p_limite`,
--     `p_offset` y columnas `usuario_apertura_id`/`total` (`count(*) OVER()`,
--     calculado ANTES del LIMIT) para que la SPA arme el paginador sin una
--     segunda consulta. RETURNS TABLE cambia ⇒ DROP + CREATE (patrón 0043/0065).
--  2. `core.cortes_usuarios_visibles` (nueva): quiénes aparecen como "abrió" en
--     el historial visible de esta sesión — alimenta el combo de filtro sin
--     exponer el padrón completo de usuarios.
--  3. `core.corte_detalle` (nueva): resumen de UN corte por id, para el
--     encabezado de la pantalla de detalle. La visibilidad la valida la ruta
--     con `corte_visible_por` antes de llamarla.
--  4. `core.corte_visible_por` (0045): el gerente solo veía la sucursal ACTIVA
--     de su sesión — en modo consulta (0076) esa sucursal es NULL, así que no
--     podía ver NINGÚN corte ni sus movimientos. Ahora compara contra TODAS
--     sus sucursales asignadas (`core.usuario_sucursal`), con o sin sucursal
--     activa. Misma firma ⇒ CREATE OR REPLACE, sin DROP.
--  5. `core.movimientos_corte_detalle` (nueva): movimientos de un corte con el
--     método de pago, la referencia de transferencia y los pasajeros/folios de
--     la venta (abonos incluidos) cuando el ingreso viene de un boleto — hoy
--     `movimientosDeCorte`/`v_movimiento_*` no lo traen.
-- =============================================================================


-- 1. `core.f_cortes_visibles` — paginado + filtro por usuario + total.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.f_cortes_visibles(text, uuid, uuid, date, date, text);

CREATE FUNCTION core.f_cortes_visibles(
  p_rol                 text,
  p_usuario_id          uuid,
  p_sucursal_id         uuid,
  p_desde               date DEFAULT NULL,
  p_hasta               date DEFAULT NULL,
  p_estado              text DEFAULT NULL,
  p_usuario_apertura_id uuid DEFAULT NULL,
  p_limite              integer DEFAULT 20,
  p_offset              integer DEFAULT 0
)
RETURNS TABLE (
  corte_id            uuid,
  sucursal_id         uuid,
  sucursal            text,
  estado              text,
  abierto_en          timestamptz,
  cerrado_en          timestamptz,
  usuario_apertura_id uuid,
  usuario_apertura    text,
  usuario_cierre      text,
  saldo_inicial       numeric,
  ingresos            numeric,
  egresos             numeric,
  transferencia       numeric,
  efectivo_calculado  numeric,
  saldo_calculado     numeric,
  saldo_declarado     numeric,
  diferencia          numeric,
  total               bigint
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.sucursal_id, su.nombre, c.estado, c.abierto_en, c.cerrado_en,
         c.usuario_apertura_id, ua.nombre, uc.nombre,
         cs.saldo_inicial, cs.ingresos, cs.egresos,
         cs.ingresos_transferencia, cs.efectivo_calculado, cs.saldo_calculado,
         c.saldo_final_declarado,
         c.saldo_final_declarado - cs.efectivo_calculado,
         count(*) OVER ()
    FROM core.corte_caja c
    JOIN core.sucursal su      ON su.id = c.sucursal_id
    JOIN core.v_corte_saldo cs ON cs.corte_caja_id = c.id
    JOIN core.usuario ua       ON ua.id = c.usuario_apertura_id
    LEFT JOIN core.usuario uc  ON uc.id = c.usuario_cierre_id
   WHERE c.activo
     AND (p_desde IS NULL OR (c.abierto_en AT TIME ZONE su.zona_horaria)::date >= p_desde)
     AND (p_hasta IS NULL OR (c.abierto_en AT TIME ZONE su.zona_horaria)::date <= p_hasta)
     AND (p_estado IS NULL OR c.estado = p_estado)
     AND (p_usuario_apertura_id IS NULL OR c.usuario_apertura_id = p_usuario_apertura_id)
     AND CASE p_rol
           WHEN 'administrador' THEN true
           WHEN 'gerente'       THEN c.sucursal_id = p_sucursal_id
           WHEN 'vendedor'      THEN c.usuario_apertura_id = p_usuario_id
           ELSE false
         END
   ORDER BY c.abierto_en DESC
   LIMIT p_limite OFFSET p_offset
$$;

COMMENT ON FUNCTION core.f_cortes_visibles(text, uuid, uuid, date, date, text, uuid, integer, integer) IS
  'Historial de cortes visible por rol, paginado (0077): `total` = count(*) OVER() antes del LIMIT, para el paginador de la SPA.';


-- 2. `core.cortes_usuarios_visibles` — combo de filtro "usuario propietario".
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.cortes_usuarios_visibles(
  p_rol         text,
  p_usuario_id  uuid,
  p_sucursal_id uuid,
  p_desde       date DEFAULT NULL,
  p_hasta       date DEFAULT NULL,
  p_estado      text DEFAULT NULL
)
RETURNS TABLE (usuario_id uuid, nombre text)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT c.usuario_apertura_id, ua.nombre
    FROM core.corte_caja c
    JOIN core.sucursal su ON su.id = c.sucursal_id
    JOIN core.usuario ua  ON ua.id = c.usuario_apertura_id
   WHERE c.activo
     AND (p_desde IS NULL OR (c.abierto_en AT TIME ZONE su.zona_horaria)::date >= p_desde)
     AND (p_hasta IS NULL OR (c.abierto_en AT TIME ZONE su.zona_horaria)::date <= p_hasta)
     AND (p_estado IS NULL OR c.estado = p_estado)
     AND CASE p_rol
           WHEN 'administrador' THEN true
           WHEN 'gerente'       THEN c.sucursal_id = p_sucursal_id
           WHEN 'vendedor'      THEN c.usuario_apertura_id = p_usuario_id
           ELSE false
         END
   ORDER BY ua.nombre
$$;

COMMENT ON FUNCTION core.cortes_usuarios_visibles(text, uuid, uuid, date, date, text) IS
  'Quiénes abrieron un corte dentro del historial visible por esta sesión (0077) — alimenta el combo de filtro sin exponer el padrón completo de usuarios.';


-- 3. `core.corte_detalle` — resumen de UN corte, para el encabezado del detalle.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.corte_detalle(p_corte_id uuid)
RETURNS TABLE (
  corte_id            uuid,
  sucursal_id         uuid,
  sucursal            text,
  estado              text,
  abierto_en          timestamptz,
  cerrado_en          timestamptz,
  usuario_apertura_id uuid,
  usuario_apertura    text,
  usuario_cierre      text,
  saldo_inicial       numeric,
  ingresos            numeric,
  egresos             numeric,
  transferencia       numeric,
  efectivo_calculado  numeric,
  saldo_calculado     numeric,
  saldo_declarado     numeric,
  diferencia          numeric
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.sucursal_id, su.nombre, c.estado, c.abierto_en, c.cerrado_en,
         c.usuario_apertura_id, ua.nombre, uc.nombre,
         cs.saldo_inicial, cs.ingresos, cs.egresos,
         cs.ingresos_transferencia, cs.efectivo_calculado, cs.saldo_calculado,
         c.saldo_final_declarado, c.saldo_final_declarado - cs.efectivo_calculado
    FROM core.corte_caja c
    JOIN core.sucursal su      ON su.id = c.sucursal_id
    JOIN core.v_corte_saldo cs ON cs.corte_caja_id = c.id
    JOIN core.usuario ua       ON ua.id = c.usuario_apertura_id
    LEFT JOIN core.usuario uc  ON uc.id = c.usuario_cierre_id
   WHERE c.id = p_corte_id AND c.activo
$$;

COMMENT ON FUNCTION core.corte_detalle(uuid) IS
  'Resumen de un corte por id (0077), para el encabezado de /historial/:id/movimientos. La visibilidad la valida la ruta con corte_visible_por antes de llamarla.';


-- 4. `core.corte_visible_por` — gerente: CUALQUIERA de sus sucursales
--    asignadas, no solo la activa de la sesión (0076 la deja en NULL en modo
--    consulta). Misma firma: CREATE OR REPLACE, sin DROP.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.corte_visible_por(
  p_corte_id    uuid,
  p_rol         text,
  p_usuario_id  uuid,
  p_sucursal_id uuid
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.corte_caja c
     WHERE c.id = p_corte_id AND c.activo
       AND CASE p_rol
             WHEN 'administrador' THEN true
             WHEN 'gerente'       THEN EXISTS (
               SELECT 1 FROM core.usuario_sucursal us
                WHERE us.usuario_id = p_usuario_id AND us.sucursal_id = c.sucursal_id AND us.activo
             )
             WHEN 'vendedor'      THEN c.usuario_apertura_id = p_usuario_id
             ELSE false
           END
  )
$$;

COMMENT ON FUNCTION core.corte_visible_por(uuid, text, uuid, uuid) IS
  'RBAC de fila para un corte (0077): admin=todos, gerente=CUALQUIERA de sus sucursales asignadas (antes solo la activa de la sesión — fallaba en modo consulta, 0076), vendedor=los que abrió.';


-- 5. `core.movimientos_corte_detalle` — movimientos + detalle de pago/pasajeros.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.movimientos_corte_detalle(
  p_corte_id          uuid,
  p_incluir_inactivos boolean DEFAULT false
)
RETURNS TABLE (
  id                        uuid,
  corte_caja_id             uuid,
  tipo                      text,
  origen_tipo               text,
  origen_id                 uuid,
  descripcion               text,
  monto                     numeric,
  usuario_id                uuid,
  usuario                   text,
  registrado_en             timestamptz,
  activo                    boolean,
  metodo_pago               text,
  referencia_transferencia  text,
  es_abono                  boolean,
  venta_id                  uuid,
  pasajeros                 jsonb
)
LANGUAGE sql STABLE AS $$
  SELECT m.id, m.corte_caja_id, m.tipo, m.origen_tipo, m.origen_id, m.descripcion,
         m.monto, m.usuario_id, u.nombre, m.registrado_en, m.activo,
         p.metodo, p.referencia_transferencia, p.es_abono, p.venta_id,
         bb.pasajeros
    FROM core.movimiento_caja m
    JOIN core.usuario u ON u.id = m.usuario_id
    LEFT JOIN core.pago p ON p.id = m.origen_id AND m.origen_tipo = 'pago_boleto'
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'folio', b.folio, 'pasajero', b.pasajero_nombre, 'importe', b.importe
             ) ORDER BY b.creado_en) AS pasajeros
        FROM core.boleto b
       WHERE b.venta_id = p.venta_id AND b.activo
    ) bb ON p.venta_id IS NOT NULL
   WHERE m.corte_caja_id = p_corte_id
     AND (p_incluir_inactivos OR m.activo)
   ORDER BY m.registrado_en, m.id
$$;

COMMENT ON FUNCTION core.movimientos_corte_detalle(uuid, boolean) IS
  'Movimientos de un corte con el detalle de pago (método, referencia, abono) y los pasajeros/folios de la venta cuando el ingreso viene de un boleto (0077), para /historial/:id/movimientos.';
