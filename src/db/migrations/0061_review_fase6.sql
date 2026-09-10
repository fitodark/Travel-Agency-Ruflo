-- =============================================================================
-- 0061 · Correcciones del review de Fase 6 (F6-D1..F6-D4, F6-D6).
--        docs/architecture/05-paradas-autorizadas-tarifas.md § "Notas del review
--        de Fase 6".
--
-- QUÉ CORRIGE.
--   * F6-D1 (alto) — `reubicar_huerfano` dejaba el boleto viejo `activo = true`
--     con `estado = 'reasignado'`. En el resto del código `reasignado` = "mismo
--     boleto, asiento nuevo, sigue viajando" (`src/sync/reasignacion.ts`), así que
--     `datos_manifiesto` / `salidas_del_dia` / `v_checklist_abordaje` /
--     `boletos_huerfanos` (que solo excluyen `'cancelado'`) seguían listando al
--     pasajero reubicado como fantasma en la salida vieja. Ahora también
--     `activo = false` — todos esos lectores ya filtran `AND b.activo`.
--   * F6-D2 (alto) — `reubicar_huerfano` movía TODOS los `core.pago` a la venta
--     nueva y cancelaba la venta vieja en la PRIMERA reubicación. Una venta
--     huérfana multi-boleto (una familia) quedaba con los demás boletos vivos en
--     una venta cancelada y sin pago → al reubicarlos se les cobraba de nuevo.
--     Ahora se rechaza una venta con más de un boleto `emitido` vivo, con un
--     mensaje que apunta al flujo manual (cancelar + reemitir la venta completa).
--   * F6-D3 (medio) — `cancelar_boleto` reembolsaba `LEAST(boleto.importe,
--     pagado)` por boleto sin descontar reembolsos previos ni desactivar el pago:
--     cancelar boleto por boleto una venta multi-boleto con ABONO PARCIAL
--     reembolsaba de más ($900 sobre $500 pagados). Ahora se acota con lo ya
--     reembolsado a los pagos de esa venta.
--   * F6-D4 (menor) — `reubicar_huerfano` no liberaba las reservas caducas de la
--     salida destino antes de tomar el asiento (a diferencia de `registrar_venta`
--     / `adquirir_lease`). Ahora sí.
--   * F6-D6 (menor) — `cancelar_boleto` y `reubicar_huerfano` no abortaban bajo
--     `sync.replicando()`. Hoy es inocuo (solo se llaman desde la API), pero por
--     consistencia con `liberar_reservas_caducas` ahora sí.
--
-- FUERA (documentado, no se toca aquí): F6-D5 (categoría/tarifa sin validar en la
-- rama "precio mantenido" de la reubicación), F6-D7 (mensaje feo si no hay corte
-- abierto para un pago), F6-D8 (perf de `reservas_caducas` en `asientos_libres`).
--
-- DEPLOY. `CREATE OR REPLACE` de 2 funciones. Sin datos que migrar, sin ventana
-- coordinada.
-- =============================================================================


-- 1. `core.cancelar_boleto` — acota el reembolso a lo ya devuelto (F6-D3) +
--    guard de replicación (F6-D6). Idéntica a 0059 salvo esos dos cambios.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.cancelar_boleto(
  p_boleto_id   uuid,
  p_usuario_id  uuid,
  p_sucursal_id uuid,
  p_motivo      text        DEFAULT NULL,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS TABLE (
  venta_id             uuid,
  venta_cancelada      boolean,
  reembolso_id         uuid,
  reembolso_monto      numeric,
  reembolso_pendiente_en text
)
LANGUAGE plpgsql AS $function$
DECLARE
  v_b               core.boleto%ROWTYPE;
  v_venta_id        uuid;
  v_hora_salida     timestamptz;
  v_pagado          numeric;
  v_ya_reembolsado  numeric;
  v_reembolso       numeric := 0;
  v_pago_id         uuid;
  v_sucursal_cobro  uuid;
  v_cobro_nombre    text;
  v_cobro_sin_sis   boolean;
  v_corte_id        uuid;
  v_reembolso_id    uuid;
  v_pendiente_en    text;
  v_venta_cancel    boolean := false;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.cancelar_boleto no se ejecuta durante la replicación';
  END IF;

  SELECT * INTO v_b FROM core.boleto WHERE id = p_boleto_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el boleto % no existe', p_boleto_id;
  END IF;
  IF v_b.estado = 'cancelado' THEN
    RAISE EXCEPTION 'el boleto % ya está cancelado', p_boleto_id;
  END IF;
  v_venta_id := v_b.venta_id;

  -- Ventana D9: hasta 1 h antes de la salida del origen (orden 0).
  SELECT spo.hora_paso_programada INTO v_hora_salida
    FROM core.salida_parada spo
   WHERE spo.salida_id = v_b.salida_id AND spo.orden = 0;
  IF v_hora_salida IS NOT NULL AND v_hora_salida - interval '1 hour' <= p_ahora THEN
    RAISE EXCEPTION 'no se puede cancelar a menos de 1 h de la salida (%). Contacta a administración.',
      v_hora_salida;
  END IF;

  SELECT COALESCE(vs.pagado, 0) INTO v_pagado
    FROM core.v_venta_saldo vs WHERE vs.venta_id = v_venta_id;

  -- F6-D3: lo ya reembolsado a los pagos de ESTA venta (otros boletos ya
  -- cancelados). El pago es append-only y no se reduce; sin este tope, cada
  -- boleto de una venta con abono parcial devolvería LEAST(importe, pagado).
  SELECT COALESCE(SUM(mc.monto), 0) INTO v_ya_reembolsado
    FROM core.movimiento_caja mc
    JOIN core.pago p2 ON p2.id = mc.origen_id
   WHERE mc.origen_tipo = 'devolucion' AND mc.activo
     AND p2.venta_id = v_venta_id;

  v_reembolso := GREATEST(0, LEAST(v_b.importe, v_pagado - v_ya_reembolsado));

  IF v_reembolso > 0 THEN
    SELECT p.id, p.sucursal_cobro_id, sc.nombre, sc.sin_sistema
      INTO v_pago_id, v_sucursal_cobro, v_cobro_nombre, v_cobro_sin_sis
      FROM core.pago p
      JOIN core.sucursal sc ON sc.id = p.sucursal_cobro_id
     WHERE p.venta_id = v_venta_id AND p.activo
       AND (p.metodo = 'efectivo' OR p.verificado)
     ORDER BY p.pagado_en DESC
     LIMIT 1;

    IF v_cobro_sin_sis THEN
      -- N-13: el efectivo se quedó en la sucursal sin sistema. La cancelación
      -- procede; el reembolso se hace a mano allá (conciliación manual).
      v_pendiente_en := v_cobro_nombre;
    ELSE
      v_corte_id := core.corte_abierto(v_sucursal_cobro);
      IF v_corte_id IS NULL THEN
        RAISE EXCEPTION 'el reembolso de $% lo registra "%" (donde se cobró) con su corte de caja abierto',
          v_reembolso, v_cobro_nombre;
      END IF;
      INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, origen_id,
                                        descripcion, monto, usuario_id, registrado_en)
      VALUES (v_corte_id, 'egreso', 'devolucion', v_pago_id,
              format('Reembolso boleto %s', v_b.folio), v_reembolso, p_usuario_id, p_ahora)
      RETURNING id INTO v_reembolso_id;
    END IF;
  END IF;

  UPDATE core.asiento_ocupacion
     SET estado = 'liberado', desactivado_motivo = 'boleto cancelado (D9)'
   WHERE boleto_id = p_boleto_id AND estado IN ('firme', 'conflicto');

  UPDATE core.boleto SET estado = 'cancelado' WHERE id = p_boleto_id;

  IF NOT EXISTS (
    SELECT 1 FROM core.boleto b2
     WHERE b2.venta_id = v_venta_id AND b2.activo AND b2.estado <> 'cancelado'
  ) THEN
    UPDATE core.venta SET estado = 'cancelada' WHERE id = v_venta_id;
    v_venta_cancel := true;
  END IF;

  INSERT INTO core.nota_auditoria (id, entidad, entidad_id, tipo, detalle,
                                   usuario_id, sucursal_id, ocurrido_en)
  VALUES (core.uuid_v7(), 'core.boleto', p_boleto_id, 'cancelacion',
          jsonb_strip_nulls(jsonb_build_object(
            'motivo', p_motivo,
            'reembolso_id', v_reembolso_id,
            'reembolso_monto', CASE WHEN v_reembolso > 0 THEN v_reembolso END,
            'reembolso_pendiente_en', v_pendiente_en,
            'sucursal_cobro_id', v_sucursal_cobro)),
          p_usuario_id, p_sucursal_id, p_ahora);

  venta_id               := v_venta_id;
  venta_cancelada        := v_venta_cancel;
  reembolso_id           := v_reembolso_id;
  reembolso_monto        := CASE WHEN v_reembolso > 0 THEN v_reembolso END;
  reembolso_pendiente_en := v_pendiente_en;
  RETURN NEXT;
END $function$;

COMMENT ON FUNCTION core.cancelar_boleto(uuid, uuid, uuid, text, timestamptz) IS
  'D9/N-13. Cancela un boleto/reserva hasta 1 h antes de la salida: libera el asiento y cancela boleto+venta. El reembolso solo existe en la sucursal de cobro y se acota a lo aún no devuelto de la venta (F6-D3); sin sistema (corresponsal) ⇒ sin movimiento (`reembolso_pendiente_en`). 05 §4.';


-- 2. `core.reubicar_huerfano` — boleto viejo `activo = false` (F6-D1), rechaza
--    venta multi-boleto (F6-D2), libera caducas de la salida destino (F6-D4),
--    guard de replicación (F6-D6). Idéntica a 0060 salvo esos cambios.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.reubicar_huerfano(
  p_boleto_viejo_id uuid,
  p_salida_nueva_id uuid,
  p_origen_orden    integer,
  p_destino_orden   integer,
  p_asiento_num     smallint,
  p_usuario_id      uuid,
  p_sucursal_id     uuid,
  p_ahora           timestamptz DEFAULT now()
)
RETURNS TABLE (
  boleto_nuevo_id  uuid,
  folio_nuevo      text,
  venta_nueva_id   uuid,
  importe          numeric,
  precio_mantenido boolean,
  saldo_pendiente  numeric,
  print_jobs       integer
)
LANGUAGE plpgsql AS $function$
DECLARE
  v_bv          core.boleto%ROWTYPE;
  v_vv          core.venta%ROWTYPE;
  v_n_vivos     integer;
  v_pagado      numeric;
  v_ruta_nueva  uuid;
  v_n_paradas   integer;
  v_estado_sal  text;
  v_mapa        jsonb;
  v_cierre      timestamptz;
  v_importe     numeric;
  v_mantiene    boolean;
  v_tramo       int4range;
  v_tramo_ocup  int4range;
  v_venta_id    uuid;
  v_boleto_id   uuid;
  v_folio       char(6);
  v_saldo       numeric;
  v_liquidada   boolean;
  v_print_jobs  integer := 0;
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.reubicar_huerfano no se ejecuta durante la replicación';
  END IF;

  SELECT * INTO v_bv FROM core.boleto WHERE id = p_boleto_viejo_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el boleto huérfano % no existe', p_boleto_viejo_id;
  END IF;
  IF v_bv.estado <> 'emitido' THEN
    RAISE EXCEPTION 'el boleto % está % : solo se reubica un boleto emitido', p_boleto_viejo_id, v_bv.estado;
  END IF;
  SELECT * INTO v_vv FROM core.venta WHERE id = v_bv.venta_id;

  -- F6-D2: una venta multi-boleto (familia) no se reubica boleto por boleto —
  -- traspasar el pago boleto a boleto rompe la contabilidad. Se cancela y se
  -- reemite la venta completa a mano (D12).
  SELECT count(*)::int INTO v_n_vivos
    FROM core.boleto WHERE venta_id = v_vv.id AND activo AND estado = 'emitido';
  IF v_n_vivos > 1 THEN
    RAISE EXCEPTION 'la venta % tiene % boletos vivos: cancélala completa y reemite la venta en la ruta nueva (la reubicación automática es solo para ventas de un boleto)',
      v_vv.id, v_n_vivos;
  END IF;

  SELECT s.estado, s.mapa_snapshot INTO v_estado_sal, v_mapa
    FROM core.salida s WHERE s.id = p_salida_nueva_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida nueva % no existe', p_salida_nueva_id;
  END IF;
  IF v_estado_sal <> 'programada' THEN
    RAISE EXCEPTION 'la salida nueva % está % : no admite reubicación', p_salida_nueva_id, v_estado_sal;
  END IF;

  SELECT count(*)::int INTO v_n_paradas
    FROM core.salida_parada WHERE salida_id = p_salida_nueva_id;
  IF p_origen_orden < 0 OR p_destino_orden <= p_origen_orden OR p_destino_orden > v_n_paradas - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_origen_orden, p_destino_orden, p_salida_nueva_id, v_n_paradas;
  END IF;

  SELECT h.ruta_id INTO v_ruta_nueva
    FROM core.salida sa JOIN core.horario h ON h.id = sa.horario_id
   WHERE sa.id = p_salida_nueva_id;

  IF NOT EXISTS (
    SELECT 1 FROM core.salida_parada sp
      JOIN core.ruta_parada rp ON rp.ruta_id = v_ruta_nueva AND rp.punto_id = sp.punto_id
     WHERE sp.salida_id = p_salida_nueva_id AND sp.orden = p_origen_orden
       AND rp.permite_ascenso AND rp.activo
  ) THEN
    RAISE EXCEPTION 'la parada de origen (orden %) de la salida nueva no permite ascenso', p_origen_orden;
  END IF;

  SELECT sp.cierre_venta_en INTO v_cierre
    FROM core.salida_parada sp
   WHERE sp.salida_id = p_salida_nueva_id AND sp.orden = p_origen_orden;
  IF v_cierre IS NOT NULL AND v_cierre <= p_ahora THEN
    RAISE EXCEPTION 'la venta para la parada % de la salida nueva ya cerró', p_origen_orden;
  END IF;

  -- F6-D4: libera las reservas caducas de la salida destino antes de tomar el
  -- asiento (igual que `registrar_venta` / `adquirir_lease`).
  PERFORM core.liberar_reservas_caducas(p_salida_nueva_id, p_ahora);

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_mapa->'asientos') a
     WHERE (a->>'num')::smallint = p_asiento_num
       AND COALESCE((a->>'vendible')::boolean, true)
  ) THEN
    RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida nueva', p_asiento_num;
  END IF;

  SELECT COALESCE(vs.pagado, 0) INTO v_pagado
    FROM core.v_venta_saldo vs WHERE vs.venta_id = v_vv.id;

  IF v_pagado > 0 THEN
    v_importe  := v_bv.importe;
    v_mantiene := true;
  ELSE
    SELECT t.importe INTO v_importe
      FROM core.v_tarifa_vigente t
     WHERE t.ruta_id = v_ruta_nueva
       AND t.parada_origen_orden = p_origen_orden
       AND t.parada_destino_orden = p_destino_orden
       AND t.categoria_pasajero = v_bv.categoria_pasajero
     ORDER BY t.effective_from DESC LIMIT 1;
    IF v_importe IS NULL THEN
      RAISE EXCEPTION 'no hay tarifa vigente para el tramo [%,%) categoría % de la ruta nueva',
        p_origen_orden, p_destino_orden, v_bv.categoria_pasajero;
    END IF;
    v_mantiene := false;
  END IF;

  v_tramo      := int4range(p_origen_orden, p_destino_orden);
  v_tramo_ocup := core.tramo_ocupacion(p_salida_nueva_id, p_origen_orden, p_destino_orden);

  v_saldo     := v_importe - LEAST(v_pagado, v_importe);
  v_liquidada := v_saldo <= 0;

  INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, cliente_id, contacto_telefono,
                          es_reservacion, salida_id, parada_origen_orden, parada_destino_orden,
                          importe_total, estado)
  VALUES (core.uuid_v7(), p_sucursal_id, p_usuario_id, v_vv.cliente_id, v_vv.contacto_telefono,
          v_vv.es_reservacion, p_salida_nueva_id, p_origen_orden, p_destino_orden,
          v_importe, CASE WHEN v_liquidada THEN 'liquidada' ELSE 'pendiente' END)
  RETURNING id INTO v_venta_id;

  v_folio := core.siguiente_folio(p_sucursal_id);
  INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, tramos_ocupacion,
                           pasajero_nombre, importe, categoria_pasajero, estado)
  VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_nueva_id, p_asiento_num,
          v_tramo, v_tramo_ocup, v_bv.pasajero_nombre, v_importe, v_bv.categoria_pasajero, 'emitido')
  RETURNING id INTO v_boleto_id;

  BEGIN
    INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, tramos_ocupacion,
                                        boleto_id, estado, sucursal_id, emitido_en, prioridad)
    VALUES (core.uuid_v7(), p_salida_nueva_id, p_asiento_num, v_tramo, v_tramo_ocup,
            v_boleto_id, 'firme', p_sucursal_id, p_ahora, CASE WHEN v_liquidada THEN 3 ELSE 1 END);
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'el asiento % ya está ocupado en la salida nueva', p_asiento_num;
  END;

  IF v_pagado > 0 THEN
    UPDATE core.pago SET venta_id = v_venta_id
     WHERE venta_id = v_vv.id AND activo;
  END IF;

  -- F6-D1: el boleto viejo queda `reasignado` Y `activo = false`. `reasignado` a
  -- secas lo interpretan los lectores del manifiesto/checklist como "sigue
  -- viajando" (semántica de `src/sync/reasignacion.ts`); `activo = false` lo saca.
  UPDATE core.asiento_ocupacion
     SET estado = 'liberado', desactivado_motivo = 'boleto reubicado (D12/N-14)'
   WHERE boleto_id = p_boleto_viejo_id AND estado IN ('firme', 'conflicto');
  UPDATE core.boleto SET estado = 'reasignado', activo = false WHERE id = p_boleto_viejo_id;
  UPDATE core.venta  SET estado = 'cancelada'  WHERE id = v_vv.id;

  INSERT INTO core.nota_auditoria (id, entidad, entidad_id, tipo, detalle,
                                   usuario_id, sucursal_id, ocurrido_en)
  VALUES (core.uuid_v7(), 'core.boleto', p_boleto_viejo_id, 'reubicacion',
          jsonb_build_object('boleto_nuevo_id', v_boleto_id, 'folio_nuevo', v_folio,
                             'salida_nueva_id', p_salida_nueva_id, 'precio_mantenido', v_mantiene,
                             'importe', v_importe),
          p_usuario_id, p_sucursal_id, p_ahora);

  IF v_liquidada THEN
    v_print_jobs := core.encolar_impresion_venta(v_venta_id);
  END IF;

  boleto_nuevo_id  := v_boleto_id;
  folio_nuevo      := v_folio;
  venta_nueva_id   := v_venta_id;
  importe          := v_importe;
  precio_mantenido := v_mantiene;
  saldo_pendiente  := v_saldo;
  print_jobs       := v_print_jobs;
  RETURN NEXT;
END $function$;

COMMENT ON FUNCTION core.reubicar_huerfano(uuid, uuid, integer, integer, smallint, uuid, uuid, timestamptz) IS
  'N-14. Reubica un boleto huérfano (venta de UN boleto) en una salida de la ruta nueva: boleto viejo → reasignado + activo=false + asiento liberado; boleto nuevo al precio pagado (traspasa el pago) o a la tarifa vigente si no había pago. Una venta multi-boleto se cancela y reemite a mano. 05 §7.3.';
