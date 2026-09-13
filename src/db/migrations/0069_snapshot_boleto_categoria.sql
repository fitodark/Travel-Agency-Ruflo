-- =============================================================================
-- 0069 · `core.snapshot_boleto` suma `categoria` (tarifa cobrada) al ticket.
--        docs/architecture/05-paradas-autorizadas-tarifas.md · decisión D7
--        (revisada 2026-09-12, Ses. 68).
--
-- QUÉ CAMBIA. La Fase 3 (`0051`) había decidido NO imprimir `categoria_pasajero`
-- en el boleto. Cliente + QA + diseño revirtieron esa decisión: el mockup de
-- diseño del boleto térmico incluye una fila "Tarifa" (General/INAPAM/Menor).
-- `core.snapshot_boleto` suma la clave `categoria` con `b.categoria_pasajero`;
-- el resto de columnas queda igual que en `0053`.
--
-- SIN CAMBIO DE FIRMA: `CREATE OR REPLACE`, misma `RETURNS jsonb`. Un boleto ya
-- impreso antes de esta migración no se reimprime solo — la próxima reimpresión
-- (`core.reimprimir_boleto`) ya sale con la categoría porque el snapshot se
-- recalcula en el momento, no se congela hasta la primera impresión.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.snapshot_boleto(p_boleto_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'boleto_id',        b.id,
    'folio',            b.folio,
    'pasajero',         b.pasajero_nombre,
    'asiento',          b.asiento_num,
    'categoria',        b.categoria_pasajero,
    'tramos',           b.tramos::text,
    'importe',          b.importe,
    'saldo_pendiente',  vs.saldo_pendiente,
    'salida_id',        s.id,
    'fecha_operacion',  s.fecha_operacion,
    'conductor',        s.conductor_nombre_snapshot,
    'unidad',           un.numero_economico,
    'origen',           puo.nombre,
    'punto_ascenso',    puo.nombre,
    'origen_direccion', so.direccion_completa,
    'origen_telefono',  so.telefono_principal,
    'destino',          pud.nombre,
    'hora_salida',      spo.hora_paso_programada,
    'fecha_hora_viaje', to_char(spo.hora_paso_programada
                                AT TIME ZONE COALESCE(so.zona_horaria, puo.zona_horaria),
                                'YYYY-MM-DD HH24:MI'),
    'emitido_en',       to_char(b.creado_en
                                AT TIME ZONE COALESCE(so.zona_horaria, puo.zona_horaria),
                                'YYYY-MM-DD HH24:MI'),
    'sucursal_venta',   sv.nombre,
    'vendedor',         u.nombre,
    'es_reservacion',   v.es_reservacion
  )
  FROM core.boleto b
  JOIN core.venta v               ON v.id  = b.venta_id
  JOIN core.salida s              ON s.id  = b.salida_id
  JOIN core.sucursal sv           ON sv.id = v.sucursal_venta_id
  JOIN core.usuario u             ON u.id  = v.usuario_id
  LEFT JOIN core.unidad un        ON un.id = s.unidad_id
  LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = v.id
  JOIN core.salida_parada spo     ON spo.salida_id = s.id AND spo.orden = lower(b.tramos)
  JOIN core.punto_ruta puo        ON puo.id = spo.punto_id
  LEFT JOIN core.sucursal so      ON so.id = puo.sucursal_id
  JOIN core.salida_parada spd     ON spd.salida_id = s.id AND spd.orden = upper(b.tramos)
  JOIN core.punto_ruta pud        ON pud.id = spd.punto_id
  LEFT JOIN core.sucursal sd      ON sd.id = pud.sucursal_id
  WHERE b.id = p_boleto_id
$$;

COMMENT ON FUNCTION core.snapshot_boleto(uuid) IS
  'Snapshot congelado del boleto para impresión (ticket) y reimpresión. '
  'Incluye categoria_pasajero desde 0069 (D7 revisada, Ses. 68): el boleto '
  'imprime la tarifa cobrada (General/INAPAM/Menor).';
