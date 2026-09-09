-- =============================================================================
-- 0056 · Alta de rutas por vigencia + reporte de boletos huérfanos + F3-D2.
--        Fase 5c de "paradas autorizadas".
--        docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D5, D12) / §4-§5.
--
-- QUÉ TRAE:
--  1. `core.ruta` gana `vigente_hasta date` y `reemplaza_a uuid` (D5): cambiar
--     las paradas de una ruta = baja lógica + alta nueva, sin traslape de fechas.
--  2. `core.boletos_huerfanos(ruta, desde)` — el listado de D12: boletos vivos de
--     una ruta para viajar en/desde `desde` (los que hay que reubicar a mano al
--     configurar la ruta que la reemplaza).
--  3. F3-D2: el guard de descuento de `core.registrar_venta` pasa de "por `orden`"
--     (`p_destino_orden = v_n_paradas - 1`) a "por `tipo='terminal'` + extremo de
--     la ruta". Hoy es equivalente (crearRuta garantiza terminal en los extremos);
--     esto lo vuelve explícito y robusto ante rutas con paradas no-terminal.
--
-- DEPLOY: `ADD COLUMN` nullable (sin backfill) + 1 función nueva + `CREATE OR
-- REPLACE` de `registrar_venta`. Sin ventana coordinada: `vigente_hasta` /
-- `reemplaza_a` NULL en un nodo viejo es inocuo; el guard nuevo es equivalente.
-- =============================================================================


-- 1. `core.ruta` — vigencia y cadena de reemplazo (D5).
-- ---------------------------------------------------------------------------
ALTER TABLE core.ruta ADD COLUMN vigente_hasta date;
ALTER TABLE core.ruta ADD COLUMN reemplaza_a  uuid
  REFERENCES core.ruta(id) DEFERRABLE INITIALLY IMMEDIATE;

COMMENT ON COLUMN core.ruta.vigente_hasta IS
  'D5. Último día operativo de la ruta (NULL = sin fin). La partición efectiva de venta la da horario.vigente_desde/hasta; esto es el ancla a nivel ruta.';
COMMENT ON COLUMN core.ruta.reemplaza_a IS
  'D5. Ruta a la que reemplaza esta (misma dirección, paradas distintas). Cadena de trazabilidad; no debe haber traslape de fechas con la reemplazada.';


-- 2. `core.boletos_huerfanos` — listado de reubicación manual (D12).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.boletos_huerfanos(
  p_ruta_id uuid,
  p_desde   date
)
RETURNS TABLE (
  boleto_id        uuid,
  folio            text,
  pasajero         text,
  contacto         text,
  salida_id        uuid,
  fecha_operacion  date,
  hora_salida      timestamptz,
  asiento          smallint,
  origen           text,
  destino          text,
  importe          numeric,
  estatus_pago     text
)
LANGUAGE sql STABLE AS $$
  SELECT b.id, b.folio, b.pasajero_nombre, v.contacto_telefono,
         s.id, s.fecha_operacion,
         spo.hora_paso_programada,
         b.asiento_num,
         puo.nombre, pud.nombre,
         b.importe,
         CASE WHEN COALESCE(vs.saldo_pendiente, 0) <= 0 THEN 'pagado' ELSE 'pendiente' END
    FROM core.boleto b
    JOIN core.venta v            ON v.id = b.venta_id
    JOIN core.salida s           ON s.id = b.salida_id
    JOIN core.horario h          ON h.id = s.horario_id
    JOIN core.salida_parada spo  ON spo.salida_id = s.id AND spo.orden = lower(b.tramos)
    JOIN core.punto_ruta puo     ON puo.id = spo.punto_id
    JOIN core.salida_parada spd  ON spd.salida_id = s.id AND spd.orden = upper(b.tramos)
    JOIN core.punto_ruta pud     ON pud.id = spd.punto_id
    LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = v.id
   WHERE h.ruta_id = p_ruta_id
     AND s.fecha_operacion >= p_desde
     AND s.estado <> 'cancelada'
     AND b.activo
     AND b.estado <> 'cancelado'
   ORDER BY s.fecha_operacion, spo.hora_paso_programada, b.asiento_num
$$;

COMMENT ON FUNCTION core.boletos_huerfanos(uuid, date) IS
  'D12. Boletos vivos de una ruta para viajar en/desde `desde` — hay que reubicarlos a mano (cancelar + reemitir) al configurar la ruta que la reemplaza. 05 §2/§5.';


-- 3. `core.registrar_venta` — F3-D2: guard de descuento por terminal-extremo.
--    Idéntica a la de 0051 salvo el cálculo `v_desc_ok` y el IF del descuento.
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
  v_estado_salida text;
  v_mapa          jsonb;
  v_n_paradas     integer;
  v_cierre        timestamptz;
  v_zona_muerta   integer;
  v_importe_total numeric;
  v_metodo        text;
  v_monto         numeric;
  v_es_abono      boolean;
  v_corte_id      uuid;
  v_pagado        numeric := 0;
  v_saldo         numeric;
  v_liquidada     boolean;
  v_prioridad     integer;
  v_venta_id      uuid;
  v_p             jsonb;
  v_asiento       smallint;
  v_nombre        text;
  v_imp           numeric;
  v_lease_id      uuid;
  v_lease         core.asiento_lease%ROWTYPE;
  v_folio         char(6);
  v_boleto_id     uuid;
  v_boletos       jsonb := '[]'::jsonb;
  v_print_jobs    integer := 0;
  v_tramo         int4range;
  v_tramo_ocup    int4range;
  v_ruta_id       uuid;
  v_validar_estr  boolean;
  v_categoria     text;
  v_tarifa        numeric;
  v_desc_ok       boolean;   -- F3-D2: origen y destino son terminales extremas de la ruta
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

  -- F3-D2: el descuento (categoría ≠ general) vale SOLO terminal-extremo →
  -- terminal-extremo de la RUTA. Se decide por `tipo='terminal'` + ser el primer
  -- / último `ruta_parada` de la ruta, no por la posición cruda contra
  -- `v_n_paradas` (que cuenta filas de `salida_parada`).
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

  -- El punto de origen debe permitir ascenso en la ruta (D2 / P-1): una parada
  -- de solo descenso nunca origina una venta.
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

  -- --- Pago (paso 6): resolver corte y cuánto cuenta ya ---
  IF p_pago IS NOT NULL THEN
    v_metodo   := p_pago->>'metodo';
    v_monto    := (p_pago->>'monto')::numeric;
    v_es_abono := COALESCE((p_pago->>'es_abono')::boolean, false);
    IF v_metodo NOT IN ('efectivo', 'transferencia') THEN
      RAISE EXCEPTION 'método de pago inválido: %', v_metodo;
    END IF;
    IF v_monto IS NULL OR v_monto <= 0 THEN
      RAISE EXCEPTION 'el monto del pago debe ser positivo';
    END IF;
    v_corte_id := COALESCE((p_pago->>'corte_caja_id')::uuid,
                           core.corte_abierto(p_sucursal_venta_id));
    v_pagado := CASE WHEN v_metodo = 'efectivo' THEN v_monto ELSE 0 END;
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

    -- D4 / F3-D2: el descuento solo aplica terminal-extremo → terminal-extremo,
    -- nunca en una parada intermedia.
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

    -- Autorización para ocupar el asiento.
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
      -- Regla de oro offline (01b §3.4): solo el cupo propio vigente.
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
    -- Con conexión y sin lease: se permite directo; el EXCLUDE es la última defensa.

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
    VALUES (core.uuid_v7(), v_venta_id, p_sucursal_venta_id, v_corte_id, p_usuario_id,
            v_metodo, v_monto, v_es_abono, v_metodo = 'efectivo',
            p_pago->>'referencia', p_ahora);
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
  'Venta / reserva de una salida. Tarifa estricta + categoría (D4); descuento solo terminal-extremo → terminal-extremo por tipo de punto (F3-D2). 02b §4 / 05 §4.';
