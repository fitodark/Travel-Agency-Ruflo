-- =============================================================================
-- 0029 · Auditoría, salud de sincronización y gastos (F8, slice 2).
-- Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
--
-- Lo que el administrador necesita ver en el dashboard además de las ventas:
--   - registros INACTIVOS (baja lógica) para detectar posibles malos manejos,
--   - la SALUD de sync de cada sucursal (última sync, atraso, deriva, versión),
--   - las EXCEPCIONES abiertas (sobreventa, deriva, divergencia, …),
--   - los GASTOS (egresos de caja + nómina).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Todo lo dado de baja lógicamente, de un vistazo. El administrador ve el qué,
-- el cuándo, quién y por qué motivo.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW reporte.v_inactivos AS
  SELECT 'core.movimiento_caja'::text AS tabla, m.id,
         m.desactivado_en, m.desactivado_por, m.desactivado_motivo,
         format('%s de $%s: %s', m.tipo, m.monto,
                COALESCE(m.descripcion, m.origen_tipo)) AS resumen
    FROM core.movimiento_caja m WHERE NOT m.activo
  UNION ALL
  SELECT 'core.boleto', b.id, b.desactivado_en, b.desactivado_por, b.desactivado_motivo,
         format('folio %s, asiento %s (%s)', b.folio, b.asiento_num, b.pasajero_nombre)
    FROM core.boleto b WHERE NOT b.activo
  UNION ALL
  SELECT 'core.venta', v.id, v.desactivado_en, v.desactivado_por, v.desactivado_motivo,
         format('%s de $%s', CASE WHEN v.es_reservacion THEN 'reservación' ELSE 'venta' END,
                v.importe_total)
    FROM core.venta v WHERE NOT v.activo
  UNION ALL
  SELECT 'core.pago', p.id, p.desactivado_en, p.desactivado_por, p.desactivado_motivo,
         format('pago %s de $%s', p.metodo, p.monto)
    FROM core.pago p WHERE NOT p.activo
  UNION ALL
  SELECT 'core.cliente', cl.id, cl.desactivado_en, cl.desactivado_por, cl.desactivado_motivo,
         format('cliente %s', cl.nombre)
    FROM core.cliente cl WHERE NOT cl.activo
  UNION ALL
  SELECT 'core.print_job', pj.id, pj.desactivado_en, pj.desactivado_por, pj.desactivado_motivo,
         format('%s (%s)', pj.template_key, pj.estado)
    FROM core.print_job pj WHERE NOT pj.activo;

COMMENT ON VIEW reporte.v_inactivos IS
  'Registros dados de baja lógicamente, para la auditoría del administrador. F8.';


-- -----------------------------------------------------------------------------
-- Salud de sync por sucursal. En la nube `sync.salud` tiene una fila por
-- sucursal (cada nodo la reporta). `degradado`: NULL si nunca reportó, false si
-- reportó pero aún no sincronizó (arrancando), true si lleva más del umbral.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW reporte.v_salud_sucursal AS
  SELECT su.id   AS sucursal_id,
         su.nombre AS sucursal,
         sa.ultima_sync_exitosa,
         CASE WHEN sa.ultima_sync_exitosa IS NULL THEN NULL
              ELSE round(extract(epoch FROM (now() - sa.ultima_sync_exitosa)) / 3600.0, 2)
         END AS atraso_horas,
         sa.outbox_pendiente,
         sa.deriva_reloj_seg,
         sa.excepciones_criticas,
         sa.version_esquema,
         sa.version_binario,
         sa.ultimo_respaldo_en,
         sa.reportado_en,
         CASE
           WHEN sa.sucursal_id IS NULL THEN NULL
           WHEN sa.ultima_sync_exitosa IS NULL THEN false
           ELSE sa.ultima_sync_exitosa < now() - make_interval(hours => COALESCE(
             (SELECT (valor)::text::int FROM core.parametro
               WHERE clave = 'umbral_sync_degradado_horas'
               ORDER BY effective_from DESC LIMIT 1), 72))
         END AS degradado
    FROM core.sucursal su
    LEFT JOIN sync.salud sa ON sa.sucursal_id = su.id
   WHERE su.activo;

COMMENT ON VIEW reporte.v_salud_sucursal IS
  'Salud de sincronización de cada sucursal para el dashboard. F8.';


-- -----------------------------------------------------------------------------
-- Excepciones abiertas, ordenadas por severidad y antigüedad.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reporte.f_excepciones_abiertas()
RETURNS TABLE (
  excepcion_id     uuid,
  sucursal         text,
  tipo             text,
  severidad        text,
  entidad          text,
  detalle          jsonb,
  creado_en        timestamptz,
  antiguedad_horas numeric
)
LANGUAGE sql STABLE AS $$
  SELECT e.id, su.nombre, e.tipo, e.severidad, e.entidad, e.detalle, e.creado_en,
         round(extract(epoch FROM (now() - e.creado_en)) / 3600.0, 2)
    FROM sync.excepcion e
    LEFT JOIN core.sucursal su ON su.id = e.sucursal_id
   WHERE e.estado IN ('abierta', 'en_proceso')
   ORDER BY array_position(ARRAY['critica','alta','media','baja'], e.severidad), e.creado_en
$$;

COMMENT ON FUNCTION reporte.f_excepciones_abiertas() IS
  'Excepciones abiertas para el badge del dashboard. F8.';

CREATE OR REPLACE FUNCTION reporte.f_excepciones_resumen()
RETURNS TABLE (severidad text, abiertas integer)
LANGUAGE sql STABLE AS $$
  SELECT s.sev,
         COALESCE((SELECT count(*)::int FROM sync.excepcion e
                    WHERE e.estado IN ('abierta','en_proceso') AND e.severidad = s.sev), 0)
    FROM (VALUES ('critica'),('alta'),('media'),('baja')) AS s(sev)
   ORDER BY array_position(ARRAY['critica','alta','media','baja'], s.sev)
$$;


-- -----------------------------------------------------------------------------
-- Gastos: egresos de caja por sucursal + la nómina mensual. El requisito pide
-- "gastos (incluye sueldos)". La nómina es MENSUAL, sin prorratear.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reporte.f_gastos(
  p_desde date,
  p_hasta date
)
RETURNS TABLE (
  concepto    text,
  sucursal    text,
  movimientos integer,
  monto       numeric
)
LANGUAGE sql STABLE AS $$
  SELECT 'egreso_' || m.origen_tipo, su.nombre, count(*)::int, sum(m.monto)
    FROM core.movimiento_caja m
    JOIN core.corte_caja c ON c.id = m.corte_caja_id
    JOIN core.sucursal su ON su.id = c.sucursal_id
   WHERE m.activo AND m.tipo = 'egreso'
     AND (m.registrado_en AT TIME ZONE su.zona_horaria)::date BETWEEN p_desde AND p_hasta
   GROUP BY 1, 2
  UNION ALL
  SELECT 'nomina_mensual', NULL,
         count(*)::int, COALESCE(sum(u.sueldo), 0)
    FROM core.usuario u
   WHERE u.activo AND u.sueldo IS NOT NULL
     AND u.effective_from <= p_hasta
     AND (u.effective_until IS NULL OR u.effective_until >= p_desde)
  ORDER BY 1, 2
$$;

COMMENT ON FUNCTION reporte.f_gastos(date, date) IS
  'Gastos del período: egresos de caja por sucursal + nómina mensual. F8.';
