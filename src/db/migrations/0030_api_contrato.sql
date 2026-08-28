-- =============================================================================
-- 0030 · Esquema `api` — contrato de solo lectura con el sistema externo (F8).
-- Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
--                  docs/architecture/api-contrato.md
--
-- P7 sigue PARCIAL: se confirmó que el sistema externo es de solo lectura para
-- reportes, pero falta el mecanismo de acceso y los campos exactos. Por eso
-- estas vistas están ANDAMIADAS Y VERSIONADAS (`v1_`), no congeladas: cuando P7
-- se cierre, lo que cambie se publica como `v2_` y `v1_` se mantiene un tiempo.
--
-- 0009 ya definió `api.v1_boleto` y `api.v1_corte_caja`. Aquí se completan las
-- entidades que el reporte externo va a necesitar con más probabilidad.
-- =============================================================================

CREATE OR REPLACE VIEW api.v1_venta AS
SELECT v.id,
       so.nombre AS sucursal_venta,
       v.es_reservacion,
       v.estado,
       v.importe_total,
       vs.pagado,
       vs.saldo_pendiente,
       spo_o.hora_paso_programada AS fecha_hora_viaje,
       su_o.nombre AS origen,
       su_d.nombre AS destino,
       v.creado_en
  FROM core.venta v
  JOIN core.sucursal so           ON so.id = v.sucursal_venta_id
  JOIN core.v_venta_saldo vs      ON vs.venta_id = v.id
  JOIN core.salida sa             ON sa.id = v.salida_id
  JOIN core.salida_parada spo_o   ON spo_o.salida_id = sa.id AND spo_o.orden = v.parada_origen_orden
  JOIN core.sucursal su_o         ON su_o.id = spo_o.sucursal_id
  JOIN core.salida_parada spo_d   ON spo_d.salida_id = sa.id AND spo_d.orden = v.parada_destino_orden
  JOIN core.sucursal su_d         ON su_d.id = spo_d.sucursal_id
 WHERE v.activo;

COMMENT ON VIEW api.v1_venta IS
  'Contrato externo v1: venta con su estado económico. Andamiada (P7). F8.';


CREATE OR REPLACE VIEW api.v1_pago AS
SELECT p.id,
       p.venta_id,
       sc.nombre AS sucursal_cobro,
       p.metodo,
       p.monto,
       p.es_abono,
       p.verificado,
       p.verificado_en,
       p.pagado_en
  FROM core.pago p
  JOIN core.sucursal sc ON sc.id = p.sucursal_cobro_id
 WHERE p.activo;

COMMENT ON VIEW api.v1_pago IS
  'Contrato externo v1: pagos (append-only). El corte lo determina sucursal_cobro (C5). F8.';


CREATE OR REPLACE VIEW api.v1_movimiento_caja AS
SELECT m.id,
       m.corte_caja_id,
       s.nombre AS sucursal,
       m.tipo,
       m.origen_tipo,
       m.descripcion,
       m.monto,
       m.registrado_en,
       m.activo
  FROM core.movimiento_caja m
  JOIN core.corte_caja c ON c.id = m.corte_caja_id
  JOIN core.sucursal s   ON s.id = c.sucursal_id;
-- Nota: incluye inactivos (activo=false) a propósito — el sistema externo audita
-- igual que el administrador. La vista de saldo (v1_corte_caja) ya solo suma
-- activos.

COMMENT ON VIEW api.v1_movimiento_caja IS
  'Contrato externo v1: movimientos de caja, activos e inactivos. F8.';


CREATE OR REPLACE VIEW api.v1_salida AS
SELECT sa.id,
       sa.fecha_operacion,
       sa.estado,
       sa.conductor_nombre_snapshot AS conductor,
       tu.clave AS tipo_unidad,
       su_o.nombre AS origen,
       su_d.nombre AS destino,
       spo_o.hora_paso_programada AS hora_salida,
       sa.salida_real_en
  FROM core.salida sa
  JOIN core.tipo_unidad tu       ON tu.id = sa.tipo_unidad_id
  JOIN core.salida_parada spo_o  ON spo_o.salida_id = sa.id AND spo_o.orden = 0
  JOIN core.sucursal su_o        ON su_o.id = spo_o.sucursal_id
  JOIN core.salida_parada spo_d  ON spo_d.salida_id = sa.id
   AND spo_d.orden = (SELECT max(orden) FROM core.salida_parada WHERE salida_id = sa.id)
  JOIN core.sucursal su_d        ON su_d.id = spo_d.sucursal_id
 WHERE sa.activo;

COMMENT ON VIEW api.v1_salida IS
  'Contrato externo v1: salidas materializadas y su estado. F8.';
