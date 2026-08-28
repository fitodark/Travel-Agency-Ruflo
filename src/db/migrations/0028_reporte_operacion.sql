-- =============================================================================
-- 0028 · Reportes de operación para el dashboard en nube (F8, slice 1).
-- Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
--                  CONTRADICCIÓN C5 (docs/architecture/02b §2.2, §3)
--
-- El dashboard del administrador vive en la nube y lee de aquí. Estas funciones
-- reportan por sucursal y por día operativo (día local de la sucursal, no UTC:
-- es lo que el administrador espera ver).
--
-- La distinción CLAVE (criterio de aceptación de F8): "ventas de la sucursal" NO
-- es lo mismo que "corte de caja de la sucursal". Una reservación pagada en
-- destino se cuenta como venta en la sucursal de origen y como ingreso en la de
-- destino. Los dos reportes existen por separado y NO deben cuadrar.
--
-- El esquema `reporte` es el del dashboard PROPIO. El esquema `api` (contrato con
-- el sistema externo) es otra cosa y se aborda en el slice 3.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS reporte;

-- -----------------------------------------------------------------------------
-- Ventas registradas en la sucursal (por `venta.sucursal_venta_id`).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reporte.f_ventas(
  p_desde       date,
  p_hasta       date,
  p_sucursal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  sucursal_id       uuid,
  sucursal          text,
  dia               date,
  operaciones       integer,
  boletos           integer,
  reservaciones     integer,
  importe_vendido   numeric,
  importe_liquidado numeric
)
LANGUAGE sql STABLE AS $$
  SELECT v.sucursal_venta_id,
         su.nombre,
         (v.creado_en AT TIME ZONE su.zona_horaria)::date AS dia,
         count(DISTINCT v.id)::int,
         count(b.id)::int,
         count(DISTINCT v.id) FILTER (WHERE v.es_reservacion)::int,
         COALESCE(sum(b.importe), 0),
         COALESCE(sum(b.importe) FILTER (WHERE v.estado = 'liquidada'), 0)
    FROM core.venta v
    JOIN core.sucursal su ON su.id = v.sucursal_venta_id
    LEFT JOIN core.boleto b
      ON b.venta_id = v.id AND b.activo AND b.estado <> 'cancelado'
   WHERE v.activo
     AND (v.creado_en AT TIME ZONE su.zona_horaria)::date BETWEEN p_desde AND p_hasta
     AND (p_sucursal_id IS NULL OR v.sucursal_venta_id = p_sucursal_id)
   GROUP BY v.sucursal_venta_id, su.nombre, 3
   ORDER BY 2, 3
$$;

COMMENT ON FUNCTION reporte.f_ventas(date, date, uuid) IS
  'Ventas registradas en la sucursal que vende (venta.sucursal_venta_id). F8.';


-- -----------------------------------------------------------------------------
-- Ingresos a la caja de la sucursal (por `pago.sucursal_cobro_id`). Solo dinero
-- confirmado: efectivo, o transferencia verificada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reporte.f_ingresos_caja(
  p_desde       date,
  p_hasta       date,
  p_sucursal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  sucursal_id           uuid,
  sucursal              text,
  dia                   date,
  pagos                 integer,
  efectivo              numeric,
  transferencia         numeric,
  transferencia_pendiente numeric,
  total_confirmado      numeric
)
LANGUAGE sql STABLE AS $$
  SELECT p.sucursal_cobro_id,
         su.nombre,
         (p.pagado_en AT TIME ZONE su.zona_horaria)::date AS dia,
         count(*)::int,
         COALESCE(sum(p.monto) FILTER (WHERE p.metodo = 'efectivo'), 0),
         COALESCE(sum(p.monto) FILTER (WHERE p.metodo = 'transferencia' AND p.verificado), 0),
         COALESCE(sum(p.monto) FILTER (WHERE p.metodo = 'transferencia' AND NOT p.verificado), 0),
         COALESCE(sum(p.monto) FILTER (WHERE p.metodo = 'efectivo' OR p.verificado), 0)
    FROM core.pago p
    JOIN core.sucursal su ON su.id = p.sucursal_cobro_id
   WHERE p.activo
     AND (p.pagado_en AT TIME ZONE su.zona_horaria)::date BETWEEN p_desde AND p_hasta
     AND (p_sucursal_id IS NULL OR p.sucursal_cobro_id = p_sucursal_id)
   GROUP BY p.sucursal_cobro_id, su.nombre, 3
   ORDER BY 2, 3
$$;

COMMENT ON FUNCTION reporte.f_ingresos_caja(date, date, uuid) IS
  'Ingresos a la caja de la sucursal que cobra (pago.sucursal_cobro_id). F8. Ver C5.';


-- -----------------------------------------------------------------------------
-- Ventas vs. caja, lado a lado. La `diferencia` NO es un error del sistema: es
-- la consecuencia de C5, y el dashboard la muestra con esta nota para que el
-- administrador no la lea como un descuadre.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reporte.f_ventas_vs_caja(
  p_desde date,
  p_hasta date
)
RETURNS TABLE (
  sucursal        text,
  importe_vendido numeric,
  ingreso_a_caja  numeric,
  diferencia      numeric,
  nota            text
)
LANGUAGE sql STABLE AS $$
  WITH ventas AS (
    SELECT sucursal, sum(importe_vendido) AS v
      FROM reporte.f_ventas(p_desde, p_hasta) GROUP BY sucursal
  ), caja AS (
    SELECT sucursal, sum(total_confirmado) AS c
      FROM reporte.f_ingresos_caja(p_desde, p_hasta) GROUP BY sucursal
  )
  SELECT COALESCE(ventas.sucursal, caja.sucursal),
         COALESCE(ventas.v, 0),
         COALESCE(caja.c, 0),
         COALESCE(caja.c, 0) - COALESCE(ventas.v, 0),
         'La venta se registra en la sucursal que vende; el ingreso, en la que '
         'cobra (reservación pagada en destino, C5). No deben cuadrar.'
    FROM ventas FULL JOIN caja ON caja.sucursal = ventas.sucursal
   ORDER BY 1
$$;

COMMENT ON FUNCTION reporte.f_ventas_vs_caja(date, date) IS
  'Ventas vs. ingreso a caja por sucursal; la diferencia es C5, no un descuadre. F8.';


-- -----------------------------------------------------------------------------
-- Cortes de caja por sucursal, con declarado vs. calculado.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reporte.f_cortes(
  p_desde       date,
  p_hasta       date,
  p_sucursal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  corte_id        uuid,
  sucursal        text,
  abierto_en      timestamptz,
  cerrado_en      timestamptz,
  estado          text,
  saldo_inicial   numeric,
  ingresos        numeric,
  egresos         numeric,
  saldo_calculado numeric,
  saldo_declarado numeric,
  diferencia      numeric
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, su.nombre, c.abierto_en, c.cerrado_en, c.estado,
         cs.saldo_inicial, cs.ingresos, cs.egresos, cs.saldo_calculado,
         c.saldo_final_declarado,
         c.saldo_final_declarado - cs.saldo_calculado
    FROM core.corte_caja c
    JOIN core.sucursal su ON su.id = c.sucursal_id
    JOIN core.v_corte_saldo cs ON cs.corte_caja_id = c.id
   WHERE c.activo
     AND (c.abierto_en AT TIME ZONE su.zona_horaria)::date BETWEEN p_desde AND p_hasta
     AND (p_sucursal_id IS NULL OR c.sucursal_id = p_sucursal_id)
   ORDER BY su.nombre, c.abierto_en
$$;

COMMENT ON FUNCTION reporte.f_cortes(date, date, uuid) IS
  'Cortes de caja por sucursal con saldo declarado vs. calculado. F8.';
