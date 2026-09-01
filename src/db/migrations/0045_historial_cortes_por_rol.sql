-- =============================================================================
-- 0045 · Historial de cortes de caja, visible según el rol.
-- Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
--
-- QA: el administrador NO podía ver los movimientos de cortes pasados —solo el
-- corte abierto de su sucursal—. Falta poder consultar el historial de cortes y
-- sus movimientos, con visibilidad por rol:
--
--   administrador → TODOS los cortes de TODAS las sucursales
--   gerente       → los cortes de LA SUCURSAL que opera (la de su sesión)
--   vendedor      → SOLO los cortes que él mismo abrió
--
-- La regla vive en UNA función (`_filtro_corte_rol`, vía las dos de abajo) para
-- que no se pueda saltar desde otra consulta. `core.v_corte_saldo` ya deriva el
-- saldo (solo movimientos activos); aquí solo se le pega el filtro y los nombres.
-- Sin DML: son funciones, replican al correr la migración en cada base.
-- =============================================================================

-- ¿Este rol, en esta sucursal, con este usuario, puede ver este corte?
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
             WHEN 'gerente'       THEN c.sucursal_id = p_sucursal_id
             WHEN 'vendedor'      THEN c.usuario_apertura_id = p_usuario_id
             ELSE false
           END
  )
$$;

COMMENT ON FUNCTION core.corte_visible_por(uuid, text, uuid, uuid) IS
  'RBAC de fila para un corte: admin=todos, gerente=su sucursal, vendedor=los que abrió.';


-- Historial de cortes que el rol puede ver, con saldo y quién abrió/cerró.
CREATE OR REPLACE FUNCTION core.f_cortes_visibles(
  p_rol         text,
  p_usuario_id  uuid,
  p_sucursal_id uuid,
  p_desde       date DEFAULT NULL,
  p_hasta       date DEFAULT NULL,
  p_estado      text DEFAULT NULL
)
RETURNS TABLE (
  corte_id          uuid,
  sucursal_id       uuid,
  sucursal          text,
  estado            text,
  abierto_en        timestamptz,
  cerrado_en        timestamptz,
  usuario_apertura  text,
  usuario_cierre    text,
  saldo_inicial     numeric,
  ingresos          numeric,
  egresos           numeric,
  saldo_calculado   numeric,
  saldo_declarado   numeric,
  diferencia        numeric
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.sucursal_id, su.nombre, c.estado, c.abierto_en, c.cerrado_en,
         ua.nombre, uc.nombre,
         cs.saldo_inicial, cs.ingresos, cs.egresos, cs.saldo_calculado,
         c.saldo_final_declarado,
         c.saldo_final_declarado - cs.saldo_calculado
    FROM core.corte_caja c
    JOIN core.sucursal su      ON su.id = c.sucursal_id
    JOIN core.v_corte_saldo cs ON cs.corte_caja_id = c.id
    JOIN core.usuario ua       ON ua.id = c.usuario_apertura_id
    LEFT JOIN core.usuario uc  ON uc.id = c.usuario_cierre_id
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
   ORDER BY c.abierto_en DESC
$$;

COMMENT ON FUNCTION core.f_cortes_visibles(text, uuid, uuid, date, date, text) IS
  'Historial de cortes visible por rol (admin=todos, gerente=su sucursal, vendedor=los que abrió).';
