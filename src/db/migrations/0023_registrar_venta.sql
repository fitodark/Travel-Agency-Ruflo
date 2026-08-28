-- =============================================================================
-- 0023 · Registro de venta / reservación, pagos y encolado de impresión.
-- Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §2
--                  docs/architecture/01b-consistencia-asientos.md §3, §5
--                  docs/architecture/04-riesgos-roadmap.md §3 (F4, pasos 4-6)
--
-- El corazón transaccional del flujo de venta: una operación produce N boletos
-- con folio, N ocupaciones firmes, y opcionalmente un pago. Todo en una sola
-- transacción — si la ocupación de un asiento choca con la constraint de
-- exclusión, se revierte entera y no queda medio boleto.
--
-- Reservación y venta NO son entidades distintas (02b §2.1): `es_reservacion` es
-- CÓMO se originó (inmutable, para reportes); el ticket se imprime cuando el
-- saldo llega a cero, venga de donde venga.
--
-- FUERA DE ALCANCE (F6): el `core.movimiento_caja` de ingreso que suma el pago al
-- corte. Aquí se crea el `core.pago` con su `corte_caja_id`; el enlace
-- pago -> movimiento lo cablea F6.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Snapshot de un boleto para el ticket. El `print_job.datos` es una copia: el
-- ticket impreso no cambia aunque los datos de origen cambien después.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.snapshot_boleto(p_boleto_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'boleto_id',       b.id,
    'folio',           b.folio,
    'pasajero',        b.pasajero_nombre,
    'asiento',         b.asiento_num,
    'tramos',          b.tramos::text,
    'importe',         b.importe,
    'salida_id',       s.id,
    'fecha_operacion', s.fecha_operacion,
    'conductor',       s.conductor_nombre_snapshot,
    'origen',          so.nombre,
    'destino',         sd.nombre,
    'hora_salida',     spo.hora_paso_programada,
    'sucursal_venta',  sv.nombre,
    'vendedor',        u.nombre,
    'es_reservacion',  v.es_reservacion
  )
  FROM core.boleto b
  JOIN core.venta v          ON v.id  = b.venta_id
  JOIN core.salida s         ON s.id  = b.salida_id
  JOIN core.sucursal sv      ON sv.id = v.sucursal_venta_id
  JOIN core.usuario u        ON u.id  = v.usuario_id
  JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = lower(b.tramos)
  JOIN core.sucursal so      ON so.id = spo.sucursal_id
  JOIN core.salida_parada spd ON spd.salida_id = s.id AND spd.orden = upper(b.tramos)
  JOIN core.sucursal sd      ON sd.id = spd.sucursal_id
  WHERE b.id = p_boleto_id
$$;

COMMENT ON FUNCTION core.snapshot_boleto(uuid) IS
  'Datos congelados de un boleto para el ticket (print_job.datos). Blueprint 02b §6.';


-- -----------------------------------------------------------------------------
-- Encola un `print_job` 'boleto' por cada boleto vivo de la venta que aún no
-- tenga uno. Se llama cuando el saldo llega a cero: al vender pagado, o al
-- liquidar / verificar una reservación después.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.encolar_impresion_venta(p_venta_id uuid)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_n integer := 0; v_b record;
BEGIN
  FOR v_b IN
    SELECT b.id AS boleto_id, v.sucursal_venta_id
      FROM core.boleto b
      JOIN core.venta v ON v.id = b.venta_id
     WHERE b.venta_id = p_venta_id
       AND b.activo
       AND b.estado <> 'cancelado'
       AND NOT EXISTS (
         SELECT 1 FROM core.print_job pj
          WHERE pj.boleto_id = b.id AND NOT pj.es_reimpresion
       )
  LOOP
    INSERT INTO core.print_job (id, sucursal_id, template_key, datos, boleto_id, estado)
    VALUES (core.uuid_v7(), v_b.sucursal_venta_id, 'boleto',
            core.snapshot_boleto(v_b.boleto_id), v_b.boleto_id, 'pendiente');
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

COMMENT ON FUNCTION core.encolar_impresion_venta(uuid) IS
  'Encola un ticket por boleto sin print_job. Se dispara cuando el saldo llega a cero.';


-- -----------------------------------------------------------------------------
-- Resuelve el corte de caja abierto de una sucursal, o lanza.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.corte_abierto(p_sucursal_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM core.corte_caja
   WHERE sucursal_id = p_sucursal_id AND estado = 'abierto' AND activo;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no hay un corte de caja abierto en la sucursal %', p_sucursal_id;
  END IF;
  RETURN v_id;
END $$;


-- -----------------------------------------------------------------------------
-- REGISTRAR VENTA — pasos 4 a 6 del flujo.
--
--   p_pasajeros: jsonb array de { asiento_num, nombre, importe, lease_id? }
--   p_pago:      jsonb { metodo, monto, es_abono?, referencia?, corte_caja_id? }
--                o NULL para una reservación sin pago.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.registrar_venta(
  p_salida_id         uuid,
  p_sucursal_venta_id uuid,
  p_usuario_id        uuid,
  p_contacto_telefono text,
  p_origen_orden      integer,
  p_destino_orden     integer,
  p_pasajeros         jsonb,
  p_es_reservacion    boolean     DEFAULT false,
  p_cliente_id        uuid        DEFAULT NULL,
  p_pago              jsonb       DEFAULT NULL,
  p_con_conexion      boolean     DEFAULT true,
  p_ahora             timestamptz DEFAULT now()
)
RETURNS TABLE (
  venta_id        uuid,
  estado_venta    text,
  importe_total   numeric,
  pagado          numeric,
  saldo_pendiente numeric,
  boletos         jsonb,
  print_jobs      integer,
  imprimible      boolean
)
LANGUAGE plpgsql AS $$
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
  v_tramo := int4range(p_origen_orden, p_destino_orden);

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
    -- El efectivo cuenta al instante; la transferencia, al verificarse (02b §2.2).
    v_pagado := CASE WHEN v_metodo = 'efectivo' THEN v_monto ELSE 0 END;
  END IF;

  v_saldo     := v_importe_total - v_pagado;
  v_liquidada := v_saldo <= 0;
  -- Prioridad de arbitraje (S2), mayor = más difícil de revertir. El cálculo
  -- canónico lo hace la reconciliación (F4 slice 4); esto es el valor inicial.
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
    INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos,
                             pasajero_nombre, importe, estado)
    VALUES (core.uuid_v7(), v_venta_id, v_folio, p_salida_id, v_asiento, v_tramo,
            v_nombre, v_imp, 'emitido')
    RETURNING id INTO v_boleto_id;

    BEGIN
      INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, boleto_id,
                                          estado, sucursal_id, emitido_en, prioridad)
      VALUES (core.uuid_v7(), p_salida_id, v_asiento, v_tramo, v_boleto_id,
              'firme', p_sucursal_venta_id, p_ahora, v_prioridad);
    EXCEPTION WHEN exclusion_violation THEN
      RAISE EXCEPTION 'el asiento % ya está vendido en un tramo que solapa', v_asiento;
    END;

    IF v_lease_id IS NOT NULL THEN
      PERFORM core.consumir_lease(v_lease_id, v_boleto_id, p_ahora);
    END IF;

    v_boletos := v_boletos || jsonb_build_object(
      'boleto_id', v_boleto_id, 'folio', v_folio, 'asiento_num', v_asiento,
      'pasajero', v_nombre, 'importe', v_imp);
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
END $$;

COMMENT ON FUNCTION core.registrar_venta(uuid, uuid, uuid, text, integer, integer, jsonb, boolean, uuid, jsonb, boolean, timestamptz) IS
  'Registra una venta o reservación: N boletos con folio, N ocupaciones firmes, pago opcional. Blueprint F4 pasos 4-6.';


-- -----------------------------------------------------------------------------
-- REGISTRAR PAGO — abono o liquidación posterior de una venta/reservación.
-- El cobro puede ocurrir en OTRA sucursal (reservación pagada en destino, C5):
-- suma al corte de `p_sucursal_cobro_id`, no al de la venta.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.registrar_pago(
  p_venta_id          uuid,
  p_sucursal_cobro_id uuid,
  p_usuario_id        uuid,
  p_metodo            text,
  p_monto             numeric,
  p_es_abono          boolean     DEFAULT false,
  p_referencia        text        DEFAULT NULL,
  p_corte_caja_id     uuid        DEFAULT NULL,
  p_ahora             timestamptz DEFAULT now()
)
RETURNS TABLE (
  pago_id         uuid,
  pagado          numeric,
  saldo_pendiente numeric,
  liquidada       boolean,
  print_jobs      integer
)
LANGUAGE plpgsql AS $$
DECLARE
  v_estado_venta text;
  v_corte_id     uuid;
  v_pago_id      uuid;
  v_pagado       numeric;
  v_saldo        numeric;
  v_liq          boolean;
  v_pj           integer := 0;
BEGIN
  IF p_metodo NOT IN ('efectivo', 'transferencia') THEN
    RAISE EXCEPTION 'método de pago inválido: %', p_metodo;
  END IF;
  IF p_monto IS NULL OR p_monto <= 0 THEN
    RAISE EXCEPTION 'el monto del pago debe ser positivo';
  END IF;

  SELECT estado INTO v_estado_venta FROM core.venta WHERE id = p_venta_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la venta % no existe', p_venta_id;
  END IF;
  IF v_estado_venta = 'cancelada' THEN
    RAISE EXCEPTION 'la venta % está cancelada', p_venta_id;
  END IF;

  v_corte_id := COALESCE(p_corte_caja_id, core.corte_abierto(p_sucursal_cobro_id));

  INSERT INTO core.pago (id, venta_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                         metodo, monto, es_abono, verificado, referencia_transferencia, pagado_en)
  VALUES (core.uuid_v7(), p_venta_id, p_sucursal_cobro_id, v_corte_id, p_usuario_id,
          p_metodo, p_monto, p_es_abono, p_metodo = 'efectivo', p_referencia, p_ahora)
  RETURNING id INTO v_pago_id;

  SELECT vs.pagado, vs.saldo_pendiente INTO v_pagado, v_saldo
    FROM core.v_venta_saldo vs WHERE vs.venta_id = p_venta_id;
  v_liq := v_saldo <= 0;

  IF v_liq THEN
    UPDATE core.venta SET estado = 'liquidada' WHERE id = p_venta_id AND estado <> 'liquidada';
    v_pj := core.encolar_impresion_venta(p_venta_id);
  END IF;

  RETURN QUERY SELECT v_pago_id, v_pagado, v_saldo, v_liq, v_pj;
END $$;

COMMENT ON FUNCTION core.registrar_pago(uuid, uuid, uuid, text, numeric, boolean, text, uuid, timestamptz) IS
  'Añade un pago (abono o liquidación) a una venta. El cobro puede ser en otra sucursal (C5).';


-- -----------------------------------------------------------------------------
-- VERIFICAR TRANSFERENCIA — req. paso 6: "debe ser verificada posteriormente
-- por el usuario que realizó dicha venta y en ese momento sumar al corte".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.verificar_transferencia(
  p_pago_id    uuid,
  p_usuario_id uuid,
  p_ahora      timestamptz DEFAULT now()
)
RETURNS TABLE (
  pagado          numeric,
  saldo_pendiente numeric,
  liquidada       boolean,
  print_jobs      integer
)
LANGUAGE plpgsql AS $$
DECLARE
  v_pago    core.pago%ROWTYPE;
  v_pagado  numeric;
  v_saldo   numeric;
  v_liq     boolean;
  v_pj      integer := 0;
BEGIN
  SELECT * INTO v_pago FROM core.pago WHERE id = p_pago_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el pago % no existe', p_pago_id;
  END IF;
  IF v_pago.metodo <> 'transferencia' THEN
    RAISE EXCEPTION 'el pago % no es una transferencia', p_pago_id;
  END IF;
  IF v_pago.verificado THEN
    RAISE EXCEPTION 'el pago % ya estaba verificado', p_pago_id;
  END IF;
  IF v_pago.usuario_id <> p_usuario_id THEN
    RAISE EXCEPTION 'solo quien registró la venta puede verificar la transferencia';
  END IF;

  UPDATE core.pago
     SET verificado = true, verificado_por = p_usuario_id, verificado_en = p_ahora
   WHERE id = p_pago_id;

  SELECT vs.pagado, vs.saldo_pendiente INTO v_pagado, v_saldo
    FROM core.v_venta_saldo vs WHERE vs.venta_id = v_pago.venta_id;
  v_liq := v_saldo <= 0;

  IF v_liq THEN
    UPDATE core.venta SET estado = 'liquidada' WHERE id = v_pago.venta_id AND estado <> 'liquidada';
    v_pj := core.encolar_impresion_venta(v_pago.venta_id);
  END IF;

  RETURN QUERY SELECT v_pagado, v_saldo, v_liq, v_pj;
END $$;

COMMENT ON FUNCTION core.verificar_transferencia(uuid, uuid, timestamptz) IS
  'Verifica una transferencia: recién ahí el pago cuenta al saldo y al corte (req. paso 6).';
