-- =============================================================================
-- 0054 · Manifiesto "lista única por pasajero" (D11).
--        Fase 5a-2 de "paradas autorizadas".
--        docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D11) / §4 / §5.
--
-- CAMBIA:
--  * `core.datos_manifiesto` deja de agrupar por parada de ascenso (`ascensos[]`)
--    y emite una sola lista plana `pasajeros[]`, ordenada por punto de ascenso y
--    luego asiento. Cada pasajero lleva SOLO: nombre, asiento, "sube en" (punto
--    de ascenso), "baja en" (parada / terminal de descenso), estatus de pago y la
--    marca de conflicto de sobreventa. **Sin importe/tarifa/saldo** (N-8), sin
--    hora para descensos, sin `ocupacion_por_tramo`.
--  * Las dos copias (`conductor` / `terminal`) tienen ahora **contenido
--    idéntico**; `p_copia` solo rotula el papel (encabezado + línea de firma).
--  * `core.generar_manifiestos` cuenta `jsonb_array_length(datos->'pasajeros')`.
--
-- NO TOCA: `core.salidas_del_dia`, `core.snapshot_boleto`, `core.reimprimir_boleto`
-- (0053), ni el abordaje digital de F7 (`core.marcar_abordaje`) — D11 lo mantiene
-- en la terminal de origen.
--
-- DEPLOY: solo `CREATE OR REPLACE` de dos funciones, sin DDL. Se puede aplicar en
-- caliente. Compatible con nodos en 0053: el jsonb es autocontenido en el
-- `print_job`, no hay columna ni contrato de sync nuevo.
-- =============================================================================


-- 1. `core.datos_manifiesto` — lista única por pasajero (D11).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.datos_manifiesto(
  p_salida_id uuid,
  p_copia     text        DEFAULT 'terminal',
  p_ahora     timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sal       record;
  v_paradas   jsonb;
  v_pasajeros jsonb;
BEGIN
  IF p_copia NOT IN ('conductor', 'terminal') THEN
    RAISE EXCEPTION 'copia de manifiesto inválida: %', p_copia;
  END IF;

  SELECT s.id, s.fecha_operacion, s.conductor_nombre_snapshot, s.estado,
         u.numero_economico, tu.clave AS tipo_unidad
    INTO v_sal
    FROM core.salida s
    LEFT JOIN core.unidad u  ON u.id  = s.unidad_id
    JOIN core.tipo_unidad tu ON tu.id = s.tipo_unidad_id
   WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  -- Las paradas del recorrido (para el encabezado): nombre + tipo del punto,
  -- hora de paso (NULL en las paradas de solo descenso, Fase 4).
  SELECT jsonb_agg(jsonb_build_object(
           'orden', sp.orden, 'punto', pr.nombre, 'tipo', pr.tipo,
           'hora_paso', sp.hora_paso_programada) ORDER BY sp.orden)
    INTO v_paradas
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id;

  -- Lista única: un renglón por boleto vivo, ordenado por punto de ascenso y
  -- luego asiento. "sube en" = punto de `lower(tramos)`; "baja en" = punto de
  -- `upper(tramos)` (el tramo de VIAJE, no el de ocupación).
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'folio',         b.folio,
             'asiento',       b.asiento_num,
             'nombre',        b.pasajero_nombre,
             'sube_en',       puo.nombre,
             'sube_en_orden', spo.orden,
             'baja_en',       pud.nombre,
             'baja_en_orden', spd.orden,
             'estatus_pago',  CASE WHEN COALESCE(vs.saldo_pendiente, 0) <= 0
                                   THEN 'pagado' ELSE 'pendiente' END,
             'conflicto',     (b.estado = 'conflicto_sobreventa')
           )
           ORDER BY spo.orden, b.asiento_num
         ), '[]'::jsonb)
    INTO v_pasajeros
    FROM core.boleto b
    JOIN core.salida_parada spo
      ON spo.salida_id = p_salida_id AND spo.orden = lower(b.tramos)
    JOIN core.punto_ruta puo ON puo.id = spo.punto_id
    JOIN core.salida_parada spd
      ON spd.salida_id = p_salida_id AND spd.orden = upper(b.tramos)
    JOIN core.punto_ruta pud ON pud.id = spd.punto_id
    LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = b.venta_id
   WHERE b.salida_id = p_salida_id
     AND b.activo
     AND b.estado <> 'cancelado';

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'salida_id',       v_sal.id,
    'copia',           p_copia,
    'fecha_operacion', v_sal.fecha_operacion,
    'estado_salida',   v_sal.estado,
    'conductor',       v_sal.conductor_nombre_snapshot,
    'unidad',          v_sal.numero_economico,
    'tipo_unidad',     v_sal.tipo_unidad,
    'generado_en',     p_ahora,
    'paradas',         v_paradas,
    'pasajeros',       v_pasajeros
  ));
END $$;

COMMENT ON FUNCTION core.datos_manifiesto(uuid, text, timestamptz) IS
  'Datos congelados de un manifiesto: lista única por pasajero (nombre, asiento, sube en, baja en, estatus de pago), sin importe (D11/N-8). Puntos desde core.punto_ruta. Blueprint 03 §2.5 / 05 §4.';


-- 2. `core.generar_manifiestos` — conteo desde la lista plana.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.generar_manifiestos(
  p_salida_id  uuid,
  p_usuario_id uuid,
  p_ahora      timestamptz DEFAULT now()
)
RETURNS TABLE (copia text, print_job_id uuid, pasajeros integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_sucursal_origen uuid;
  v_copia  text;
  v_datos  jsonb;
  v_id     uuid;
  v_n      integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.salida WHERE id = p_salida_id) THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  SELECT pr.sucursal_id INTO v_sucursal_origen
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id AND sp.orden = 0;

  UPDATE core.print_job
     SET activo = false, desactivado_motivo = 'manifiesto regenerado'
   WHERE boleto_id IS NULL
     AND template_key IN ('manifiesto_conductor', 'manifiesto_terminal')
     AND estado = 'pendiente'
     AND datos->>'salida_id' = p_salida_id::text
     AND activo;

  FOREACH v_copia IN ARRAY ARRAY['conductor', 'terminal'] LOOP
    v_datos := core.datos_manifiesto(p_salida_id, v_copia, p_ahora);
    v_n := COALESCE(jsonb_array_length(v_datos->'pasajeros'), 0);

    INSERT INTO core.print_job (id, sucursal_id, template_key, datos, estado, boleto_id)
    VALUES (core.uuid_v7(), v_sucursal_origen, 'manifiesto_' || v_copia, v_datos, 'pendiente', NULL)
    RETURNING id INTO v_id;

    copia := v_copia; print_job_id := v_id; pasajeros := v_n;
    RETURN NEXT;
  END LOOP;
END $$;

COMMENT ON FUNCTION core.generar_manifiestos(uuid, uuid, timestamptz) IS
  'Encola los dos print_job de manifiesto (conductor y terminal, contenido idéntico) de una salida. F7 · 05 §4.';
