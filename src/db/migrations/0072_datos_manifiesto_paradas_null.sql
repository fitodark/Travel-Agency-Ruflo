-- =============================================================================
-- 0072 · `core.datos_manifiesto` — `paradas` nunca ausente en el jsonb.
--
-- QUÉ RESUELVE. `v_paradas` sale de un `jsonb_agg(...)` sin `COALESCE`, a
-- diferencia de `v_pasajeros` que sí lo tiene (0054). Una salida materializada
-- de una ruta sin `ruta_parada` activa queda con CERO `salida_parada`
-- (`core.materializar_salidas` la cuenta en su columna `sin_paradas` — es un
-- estado real, no hipotético). Para esa salida, `v_paradas` es NULL y
-- `jsonb_strip_nulls` BORRA la clave `paradas` del jsonb entero. El renderer
-- ESC/POS (`src/printing/templates/manifiesto.ts`) lee `m.paradas[0]` sin
-- guardia ⇒ `TypeError` sin SQLSTATE, exactamente la clase de error que el
-- manejador global de la API oculta detrás de "error_interno" (src/api/server.ts).
--
-- CÓMO. Mismo patrón que `v_pasajeros`: `COALESCE(jsonb_agg(...), '[]'::jsonb)`.
-- Con la lista vacía, el renderer ya no revienta; el encabezado de ruta se omite
-- (guardia existente `if (origen && destino)`), y el resto del manifiesto se
-- imprime igual — útil para operar la salida manualmente mientras se corrige la
-- ruta sin paradas.
--
-- DEPLOY: `CREATE OR REPLACE` de una función, sin DDL. Aplica en caliente.
-- =============================================================================

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
  -- hora de paso (NULL en las paradas de solo descenso, Fase 4). `COALESCE` a
  -- `[]` (0072): una salida sin `salida_parada` (ruta sin `ruta_parada`
  -- activa, ver `core.materializar_salidas.sin_paradas`) no debe perder la
  -- clave completa por `jsonb_strip_nulls`.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'orden', sp.orden, 'punto', pr.nombre, 'tipo', pr.tipo,
           'hora_paso', sp.hora_paso_programada) ORDER BY sp.orden), '[]'::jsonb)
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
  'Datos congelados de un manifiesto: lista única por pasajero (nombre, asiento, sube en, baja en, estatus de pago), sin importe (D11/N-8). Puntos desde core.punto_ruta. paradas nunca ausente (0072). Blueprint 03 §2.5 / 05 §4.';
