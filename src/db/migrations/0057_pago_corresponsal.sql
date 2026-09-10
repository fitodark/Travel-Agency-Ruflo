-- =============================================================================
-- 0057 · Tercer método de pago: `corresponsal`. Fase 6a de "paradas autorizadas".
--        docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D8, D13) / §4.
--
-- QUÉ RESUELVE. Tamazulapan es una sucursal nueva SIN sistema (corte manual
-- externo). El pasajero paga allá; la base solo reserva y debe saber que el
-- cobro fue afuera. Tercer método `metodo = 'corresponsal'`:
--   * `core.sucursal` gana `sin_sistema boolean` (D13): una sucursal así no tiene
--     `corte_caja` en el sistema, no cuelga de `ruta_parada`, solo figura como
--     `pago.sucursal_cobro_id` de un pago `corresponsal`.
--   * `core.pago.metodo` CHECK gana `'corresponsal'`. `corte_caja_id` **sigue
--     NOT NULL** = el corte abierto del vendedor de origen (para agruparlo).
--   * El pago `corresponsal` entra `verificado = true` y cuenta como pagado de
--     una vez (boleto imprimible), PERO el trigger `pago→ingreso` (0025) lo
--     **omite**: no crea `movimiento_caja`, no suma al efectivo del corte.
--   * El corte del origen lo muestra en un apartado aparte — `core.pagos_corresponsal`
--     (D8): conteo + suma + detalle por `sucursal_cobro_id`.
--
-- DEPLOY. `ADD COLUMN` con default + `DROP/ADD` de dos CHECK + `CREATE OR REPLACE`
-- de trigger y `registrar_venta`. Sin ventana coordinada: un nodo viejo que
-- ingiere un `sucursal` sin `sin_sistema` cae al default `false`; nadie emite
-- pagos `corresponsal` hasta que su binario lo soporte.
-- =============================================================================


-- 1. `core.sucursal.sin_sistema` (D13).
-- ---------------------------------------------------------------------------
ALTER TABLE core.sucursal ADD COLUMN sin_sistema boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.sucursal.sin_sistema IS
  'D13. Sucursal sin PC/caja en el sistema (corte manual externo, p. ej. Tamazulapan). No tiene corte_caja, no cuelga de ruta_parada; solo figura como pago.sucursal_cobro_id de un pago corresponsal.';

-- La vista vigente lleva lista explícita de columnas: se recrea para exponer
-- `sin_sistema` (los catálogos de la terminal la usan para el selector de cobro).
CREATE OR REPLACE VIEW core.v_sucursal_vigente AS
SELECT id, agencia_id, nombre, direccion_completa, telefono_principal, codigo,
       zona_horaria, effective_from, effective_until, activo, creado_en, creado_por,
       modificado_en, modificado_por, desactivado_en, desactivado_por,
       desactivado_motivo, sync_sucursal_id, hlc_ts, hlc_cnt, version, sin_sistema
  FROM core.sucursal
 WHERE activo AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now());


-- 2. `core.pago` — `corresponsal` en los dos CHECK.
-- ---------------------------------------------------------------------------
ALTER TABLE core.pago DROP CONSTRAINT pago_metodo_check;
ALTER TABLE core.pago ADD  CONSTRAINT pago_metodo_check
  CHECK (metodo = ANY (ARRAY['efectivo'::text, 'transferencia'::text, 'corresponsal'::text]));

-- El `corresponsal` entra verificado sin `verificado_por` (lo "verifica" el
-- hecho de que la reserva se registró porque ya se pagó afuera).
ALTER TABLE core.pago DROP CONSTRAINT pago_check;
ALTER TABLE core.pago ADD  CONSTRAINT pago_check
  CHECK (metodo IN ('efectivo', 'corresponsal') OR NOT verificado OR verificado_por IS NOT NULL);


-- 3. `core.trg_pago_a_ingreso` — el `corresponsal` NO entra al efectivo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.trg_pago_a_ingreso()
RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF sync.replicando() THEN
    RETURN NEW;
  END IF;

  -- Dinero confirmado que SÍ toca la caja del origen: efectivo desde el inicio,
  -- transferencia al verificarse. El `corresponsal` se cobró en otra sucursal
  -- (D8): queda registrado pero no genera movimiento de caja aquí.
  IF NEW.activo AND NEW.metodo <> 'corresponsal'
     AND (NEW.metodo = 'efectivo' OR NEW.verificado)
     AND NOT EXISTS (
       SELECT 1 FROM core.movimiento_caja
        WHERE origen_tipo = 'pago_boleto' AND origen_id = NEW.id AND activo
     )
  THEN
    INSERT INTO core.movimiento_caja (corte_caja_id, tipo, origen_tipo, origen_id,
                                      monto, usuario_id, registrado_en)
    VALUES (NEW.corte_caja_id, 'ingreso', 'pago_boleto', NEW.id,
            NEW.monto, NEW.usuario_id,
            COALESCE(NEW.verificado_en, NEW.pagado_en, now()));
  END IF;

  -- Pago dado de baja: su ingreso lo sigue.
  IF TG_OP = 'UPDATE' AND OLD.activo AND NOT NEW.activo THEN
    UPDATE core.movimiento_caja
       SET activo = false, desactivado_motivo = 'pago cancelado'
     WHERE origen_tipo = 'pago_boleto' AND origen_id = NEW.id AND activo;
  END IF;

  RETURN NEW;
END $function$;


-- 4. `core.pagos_corresponsal` — apartado del corte (D8).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.pagos_corresponsal(p_corte_id uuid)
RETURNS TABLE (
  pago_id       uuid,
  folio         text,
  pasajero      text,
  sucursal_cobro text,
  monto         numeric,
  pagado_en     timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT p.id, b.folio, b.pasajero_nombre, sc.nombre, p.monto, p.pagado_en
    FROM core.pago p
    JOIN core.sucursal sc ON sc.id = p.sucursal_cobro_id
    JOIN core.venta v     ON v.id = p.venta_id
    LEFT JOIN LATERAL (
      SELECT folio, pasajero_nombre FROM core.boleto
       WHERE venta_id = v.id AND activo ORDER BY creado_en LIMIT 1
    ) b ON true
   WHERE p.corte_caja_id = p_corte_id
     AND p.metodo = 'corresponsal'
     AND p.activo
   ORDER BY p.pagado_en
$$;

COMMENT ON FUNCTION core.pagos_corresponsal(uuid) IS
  'D8. Cobros corresponsal agrupados en el corte del vendedor de origen: no suman al efectivo, se listan aparte con la sucursal donde se cobró.';


-- 5. `core.registrar_venta` — maneja `metodo='corresponsal'`.
--    Idéntica a 0056 salvo el bloque de pago (nueva var `v_sucursal_cobro`).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.registrar_venta(
  p_salida_id uuid, p_sucursal_venta_id uuid, p_usuario_id uuid, p_contacto_telefono text,
  p_origen_orden integer, p_destino_orden integer, p_pasajeros jsonb,
  p_es_reservacion boolean DEFAULT false, p_cliente_id uuid DEFAULT NULL::uuid,
  p_pago jsonb DEFAULT NULL::jsonb, p_con_conexion boolean DEFAULT true,
  p_ahora timestamp with time zone DEFAULT now()
)
RETURNS TABLE(venta_id uuid, estado_venta text, importe_total numeric, pagado numeric,
              saldo_pendiente numeric, boletos jsonb, print_jobs integer, imprimible boolean)
LANGUAGE plpgsql AS $function$
DECLARE
  v_estado_salida  text;
  v_mapa           jsonb;
  v_n_paradas      integer;
  v_cierre         timestamptz;
  v_zona_muerta    integer;
  v_importe_total  numeric;
  v_metodo         text;
  v_monto          numeric;
  v_es_abono       boolean;
  v_corte_id       uuid;
  v_sucursal_cobro uuid;
  v_pagado         numeric := 0;
  v_saldo          numeric;
  v_liquidada      boolean;
  v_prioridad      integer;
  v_venta_id       uuid;
  v_p              jsonb;
  v_asiento        smallint;
  v_nombre         text;
  v_imp            numeric;
  v_lease_id       uuid;
  v_lease          core.asiento_lease%ROWTYPE;
  v_folio          char(6);
  v_boleto_id      uuid;
  v_boletos        jsonb := '[]'::jsonb;
  v_print_jobs     integer := 0;
  v_tramo          int4range;
  v_tramo_ocup     int4range;
  v_ruta_id        uuid;
  v_validar_estr   boolean;
  v_categoria      text;
  v_tarifa         numeric;
  v_desc_ok        boolean;
BEGIN
  IF p_contacto_telefono IS NULL OR btrim(p_contacto_telefono) = '' THEN
    RAISE EXCEPTION 'el teléfono de contacto es obligatorio (S11)';
  END IF;

  SELECT s.estado, s.mapa_snapshot INTO v_estado_salida, v_mapa
    FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado_salida <> 'programada' THEN
    RAISE EXCEPTION 'la salida % está % : no se puede vender ni reservar', p_salida_id, v_estado_salida;
  END IF;

  SELECT count(*)::int INTO v_n_paradas
    FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF p_origen_orden < 0 OR p_destino_orden <= p_origen_orden
     OR p_destino_orden > v_n_paradas - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_origen_orden, p_destino_orden, p_salida_id, v_n_paradas;
  END IF;
  v_tramo      := int4range(p_origen_orden, p_destino_orden);
  v_tramo_ocup := core.tramo_ocupacion(p_salida_id, p_origen_orden, p_destino_orden);

  SELECT h.ruta_id INTO v_ruta_id
    FROM core.salida sa JOIN core.horario h ON h.id = sa.horario_id
   WHERE sa.id = p_salida_id;

  v_validar_estr := COALESCE(
    (SELECT (valor::text)::boolean FROM core.parametro
      WHERE clave = 'validar_tarifa_estricta' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1), true);

  SELECT
    EXISTS (SELECT 1 FROM core.ruta_parada rp JOIN core.punto_ruta pr ON pr.id = rp.punto_id
             WHERE rp.ruta_id = v_ruta_id AND rp.activo
               AND rp.orden = p_origen_orden AND rp.orden = 0 AND pr.tipo = 'terminal')
    AND
    EXISTS (SELECT 1 FROM core.ruta_parada rp JOIN core.punto_ruta pr ON pr.id = rp.punto_id
             WHERE rp.ruta_id = v_ruta_id AND rp.activo
               AND rp.orden = p_destino_orden AND pr.tipo = 'terminal'
               AND rp.orden = (SELECT max(orden) FROM core.ruta_parada
                                WHERE ruta_id = v_ruta_id AND activo))
    INTO v_desc_ok;

  IF NOT EXISTS (
    SELECT 1
      FROM core.salida_parada sp
      JOIN core.salida sa      ON sa.id = sp.salida_id
      JOIN core.horario h      ON h.id  = sa.horario_id
      JOIN core.ruta_parada rp ON rp.ruta_id = h.ruta_id AND rp.punto_id = sp.punto_id
     WHERE sp.salida_id = p_salida_id
       AND sp.orden = p_origen_orden
       AND rp.permite_ascenso AND rp.activo
  ) THEN
    RAISE EXCEPTION 'la parada de origen (orden %) de la salida % no permite ascenso',
      p_origen_orden, p_salida_id;
  END IF;

  SELECT sp.cierre_venta_en INTO v_cierre
    FROM core.salida_parada sp
   WHERE sp.salida_id = p_salida_id AND sp.orden = p_origen_orden;
  IF v_cierre <= p_ahora THEN
    RAISE EXCEPTION 'la venta para la parada % de la salida % ya cerró', p_origen_orden, p_salida_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.usuario u
     WHERE u.id = p_usuario_id AND u.activo
       AND u.effective_from <= p_ahora
       AND (u.effective_until IS NULL OR u.effective_until > p_ahora)
  ) THEN
    RAISE EXCEPTION 'el usuario % no existe o no está vigente', p_usuario_id;
  END IF;

  IF p_pasajeros IS NULL OR jsonb_typeof(p_pasajeros) <> 'array'
     OR jsonb_array_length(p_pasajeros) = 0 THEN
    RAISE EXCEPTION 'la venta no lleva pasajeros';
  END IF;

  SELECT COALESCE(sum((e->>'importe')::numeric), 0) INTO v_importe_total
    FROM jsonb_array_elements(p_pasajeros) e;

  v_zona_muerta := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_zona_muerta' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1), 15);

  -- --- Pago (paso 6): resolver corte, sucursal de cobro y cuánto cuenta ya ---
  IF p_pago IS NOT NULL THEN
    v_metodo   := p_pago->>'metodo';
    v_monto    := (p_pago->>'monto')::numeric;
    v_es_abono := COALESCE((p_pago->>'es_abono')::boolean, false);
    IF v_metodo NOT IN ('efectivo', 'transferencia', 'corresponsal') THEN
      RAISE EXCEPTION 'método de pago inválido: %', v_metodo;
    END IF;
    IF v_monto IS NULL OR v_monto <= 0 THEN
      RAISE EXCEPTION 'el monto del pago debe ser positivo';
    END IF;

    IF v_metodo = 'corresponsal' THEN
      -- D8/D13: lo cobró una sucursal "sin sistema"; el corte del vendedor de
      -- origen lo agrupa pero no entra al efectivo. Un corresponsal cuenta como
      -- pagado de una vez y no admite abonos parciales.
      v_sucursal_cobro := (p_pago->>'sucursal_cobro_id')::uuid;
      IF v_sucursal_cobro IS NULL THEN
        RAISE EXCEPTION 'un pago corresponsal necesita la sucursal donde se cobró';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM core.sucursal
                      WHERE id = v_sucursal_cobro AND sin_sistema AND activo) THEN
        RAISE EXCEPTION 'la sucursal de cobro corresponsal % no existe o no es "sin sistema"', v_sucursal_cobro;
      END IF;
      IF v_es_abono OR v_monto <> v_importe_total THEN
        RAISE EXCEPTION 'un pago corresponsal cubre el total de la venta, sin abonos parciales';
      END IF;
    ELSE
      v_sucursal_cobro := p_sucursal_venta_id;
    END IF;

    v_corte_id := COALESCE((p_pago->>'corte_caja_id')::uuid,
                           core.corte_abierto(p_sucursal_venta_id));
    v_pagado := CASE WHEN v_metodo IN ('efectivo', 'corresponsal') THEN v_monto ELSE 0 END;
  END IF;

  v_saldo     := v_importe_total - v_pagado;
  v_liquidada := v_saldo <= 0;
  v_prioridad := CASE WHEN v_liquidada THEN 3 WHEN v_pagado > 0 THEN 2 ELSE 1 END;

  INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, cliente_id, contacto_telefono,
                          es_reservacion, salida_id, parada_origen_orden, parada_destino_orden,
                          importe_total, estado)
  VALUES (core.uuid_v7(), p_sucursal_venta_id, p_usuario_id, p_cliente_id, p_contacto_telefono,
          p_es_reservacion, p_salida_id, p_origen_orden, p_destino_orden,
          v_importe_total, CASE WHEN v_liquidada THEN 'liquidada' ELSE 'pendiente' END)
  RETURNING id INTO v_venta_id;

  FOR v_p IN SELECT * FROM jsonb_array_elements(p_pasajeros) LOOP
    v_asiento  := (v_p->>'asiento_num')::smallint;
    v_nombre   := v_p->>'nombre';
    v_imp      := (v_p->>'importe')::numeric;
    v_lease_id := (v_p->>'lease_id')::uuid;

    IF v_nombre IS NULL OR btrim(v_nombre) = '' THEN
      RAISE EXCEPTION 'falta el nombre del pasajero del asiento %', v_asiento;
    END IF;

    v_categoria := COALESCE(NULLIF(v_p->>'categoria', ''), 'general');
    IF v_categoria NOT IN ('general','inapam','menor') THEN
      RAISE EXCEPTION 'categoría de pasajero inválida: %', v_categoria;
    END IF;

    IF v_categoria <> 'general' AND NOT v_desc_ok THEN
      RAISE EXCEPTION 'la categoría % solo aplica de la terminal de origen a la de destino (tramo completo), no en paradas intermedias',
        v_categoria;
    END IF;

    IF v_validar_estr THEN
      SELECT t.importe INTO v_tarifa
        FROM core.v_tarifa_vigente t
       WHERE t.ruta_id = v_ruta_id
         AND t.parada_origen_orden = p_origen_orden
         AND t.parada_destino_orden = p_destino_orden
         AND t.categoria_pasajero = v_categoria
       ORDER BY t.effective_from DESC LIMIT 1;
      IF v_tarifa IS NULL THEN
        RAISE EXCEPTION 'no hay tarifa vigente para el tramo [%,%) categoría % (ruta %)',
          p_origen_orden, p_destino_orden, v_categoria, v_ruta_id;
      END IF;
      IF v_imp <> v_tarifa THEN
        RAISE EXCEPTION 'el importe del pasajero (%) no coincide con la tarifa vigente (%) para el tramo [%,%) categoría %',
          v_imp, v_tarifa, p_origen_orden, p_destino_orden, v_categoria;
      END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_mapa->'asientos') a
       WHERE (a->>'num')::smallint = v_asiento
         AND COALESCE((a->>'vendible')::boolean, true)
    ) THEN
      RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida %', v_asiento, p_salida_id;
    END IF;

    IF v_lease_id IS NOT NULL THEN
      SELECT * INTO v_lease FROM core.asiento_lease
       WHERE id = v_lease_id
         AND consumido_por_boleto_id IS NULL AND liberado_en IS NULL
         AND expira_en > p_ahora;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'el lease % no está vivo', v_lease_id;
      END IF;
      IF v_lease.sucursal_id <> p_sucursal_venta_id THEN
        RAISE EXCEPTION 'el lease % es de otra sucursal', v_lease_id;
      END IF;
      IF v_lease.asiento_num <> v_asiento OR NOT (v_lease.tramos @> v_tramo) THEN
        RAISE EXCEPTION 'el lease % no cubre el asiento % en el tramo pedido', v_lease_id, v_asiento;
      END IF;
    ELSIF NOT p_con_conexion THEN
      IF NOT EXISTS (
        SELECT 1 FROM core.cupo_offline co
         WHERE co.salida_id = p_salida_id
           AND co.sucursal_id = p_sucursal_venta_id
           AND v_asiento = ANY (co.asientos)
           AND co.tramos @> v_tramo
           AND co.vigente_desde <= p_ahora
           AND co.vigente_hasta - make_interval(mins => v_zona_muerta) > p_ahora
      ) THEN
        RAISE EXCEPTION 'sin conexión, el asiento % no está en el cupo vigente de la sucursal %',
          v_asiento, p_sucursal_venta_id;
      END IF;
    END IF;

    v_folio := core.siguiente_folio(p_sucursal_venta_id);
    INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, tramos_ocupacion,
                             pasajero_nombre, importe, categoria_pasajero, estado)
    VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_id, v_asiento, v_tramo, v_tramo_ocup,
            v_nombre, v_imp, v_categoria, 'emitido')
    RETURNING id INTO v_boleto_id;

    BEGIN
      INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, tramos_ocupacion, boleto_id,
                                          estado, sucursal_id, emitido_en, prioridad)
      VALUES (core.uuid_v7(), p_salida_id, v_asiento, v_tramo, v_tramo_ocup, v_boleto_id,
              'firme', p_sucursal_venta_id, p_ahora, v_prioridad);
    EXCEPTION WHEN exclusion_violation THEN
      RAISE EXCEPTION 'el asiento % ya está vendido en un tramo que solapa', v_asiento;
    END;

    IF v_lease_id IS NOT NULL THEN
      PERFORM core.consumir_lease(v_lease_id, v_boleto_id, p_ahora);
    END IF;

    v_boletos := v_boletos || jsonb_build_object(
      'boleto_id', v_boleto_id, 'folio', v_folio, 'asiento_num', v_asiento,
      'pasajero', v_nombre, 'importe', v_imp, 'categoria', v_categoria);
  END LOOP;

  IF p_pago IS NOT NULL THEN
    INSERT INTO core.pago (id, venta_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                           metodo, monto, es_abono, verificado, referencia_transferencia, pagado_en)
    VALUES (core.uuid_v7(), v_venta_id, v_sucursal_cobro, v_corte_id, p_usuario_id,
            v_metodo, v_monto, v_es_abono, v_metodo IN ('efectivo', 'corresponsal'),
            CASE WHEN v_metodo = 'transferencia' THEN p_pago->>'referencia' END, p_ahora);
  END IF;

  IF v_liquidada THEN
    v_print_jobs := core.encolar_impresion_venta(v_venta_id);
  END IF;

  RETURN QUERY SELECT
    v_venta_id,
    CASE WHEN v_liquidada THEN 'liquidada' ELSE 'pendiente' END,
    v_importe_total, v_pagado, v_saldo, v_boletos, v_print_jobs, v_liquidada;
END $function$;

COMMENT ON FUNCTION core.registrar_venta(uuid, uuid, uuid, text, integer, integer, jsonb, boolean, uuid, jsonb, boolean, timestamptz) IS
  'Venta / reserva de una salida. Tarifa estricta + categoría (D4); descuento por tipo de punto (F3-D2); método de pago `corresponsal` cobrado en sucursal sin_sistema (D8). 02b §4 / 05 §4.';
