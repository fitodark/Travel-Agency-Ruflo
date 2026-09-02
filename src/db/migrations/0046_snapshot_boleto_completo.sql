-- =============================================================================
-- 0046 · `core.snapshot_boleto` completa los datos que el ticket necesita (F5).
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.4
--
-- El spooler ya sabe renderizar el boleto (`renderBoleto` / `DatosBoleto`), pero
-- el snapshot congelado que produce `core.snapshot_boleto` se quedaba corto: le
-- faltaban la dirección y el teléfono de la sucursal de ascenso, el número de
-- unidad, el momento de emisión, el saldo pendiente y la fecha+hora del viaje ya
-- formateada. `DatosBoleto` los exige y sin ellos el ticket sale con huecos.
--
-- Solo función (CREATE OR REPLACE), sin DML: seguro para local y nube. Los
-- `print_job` de boleto ya emitidos conservan su snapshot viejo — el ticket
-- impreso no cambia retroactivamente, que es justo la propiedad que se quiere.
--
-- Horas: `to_char(... AT TIME ZONE core.sucursal.zona_horaria, ...)` — hora de
-- pared de la sucursal de ascenso, sin más aritmética (P12 sigue abierta, mismo
-- criterio que el manifiesto).
-- =============================================================================

CREATE OR REPLACE FUNCTION core.snapshot_boleto(p_boleto_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'boleto_id',        b.id,
    'folio',            b.folio,
    'pasajero',         b.pasajero_nombre,
    'asiento',          b.asiento_num,
    'tramos',           b.tramos::text,
    'importe',          b.importe,
    'saldo_pendiente',  vs.saldo_pendiente,
    'salida_id',        s.id,
    'fecha_operacion',  s.fecha_operacion,
    'conductor',        s.conductor_nombre_snapshot,
    'unidad',           un.numero_economico,
    'origen',           so.nombre,
    'origen_direccion', so.direccion_completa,
    'origen_telefono',  so.telefono_principal,
    'destino',          sd.nombre,
    'hora_salida',      spo.hora_paso_programada,
    'fecha_hora_viaje', to_char(spo.hora_paso_programada AT TIME ZONE so.zona_horaria,
                                'YYYY-MM-DD HH24:MI'),
    'emitido_en',       to_char(b.creado_en AT TIME ZONE so.zona_horaria,
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
  JOIN core.sucursal so           ON so.id = spo.sucursal_id
  JOIN core.salida_parada spd     ON spd.salida_id = s.id AND spd.orden = upper(b.tramos)
  JOIN core.sucursal sd           ON sd.id = spd.sucursal_id
  WHERE b.id = p_boleto_id
$$;

COMMENT ON FUNCTION core.snapshot_boleto(uuid) IS
  'Datos congelados de un boleto para el ticket (print_job.datos). Blueprint 02b §6 / 03 §2.4.';
