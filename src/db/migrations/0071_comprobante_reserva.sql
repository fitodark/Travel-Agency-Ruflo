-- =============================================================================
-- 0071 · Comprobante de anticipo para reservaciones con abono parcial.
--        Regla del product owner (Ses. 71): una reserva puede recibir un
--        ANTICIPO (monto < total) además de "sin pago" (ya cubierto) o pago
--        íntegro (ya cubierto). Con anticipo:
--          - el abono queda etiquetado con nombre + teléfono de quien reservó
--            (`core.cliente` + `venta.contacto_telefono`, ya existían),
--          - NO se imprime el boleto (ya era la regla: solo se imprime al
--            llegar el saldo a cero, sin importar el método),
--          - SÍ se imprime un comprobante de pago con ruta, hora, pasajeros,
--            asientos y saldo restante, con el folio de alguno de sus boletos
--            como referencia de consulta (el folio ya es único, se dicta por
--            teléfono y se teclea a mano — 0006 — no hace falta inventar otro).
--
-- QUÉ CAMBIA.
--   1. `core.print_job` gana el template `comprobante_reserva` + columna
--      `venta_id` (el comprobante cubre TODOS los boletos de la venta, no uno).
--   2. `core.snapshot_comprobante_reserva` / `core.encolar_comprobante_reserva`
--      — mismo patrón que `snapshot_boleto` / `encolar_impresion_venta`.
--   3. `core.registrar_venta` y `core.registrar_pago` encolan el comprobante
--      cuando el pago es `es_abono` y la venta NO queda liquidada. Ambas ganan
--      la columna `comprobante_impreso` en su `RETURNS TABLE` ⇒ DROP + CREATE
--      (patrón 0043 / 0065).
--
-- FUERA DE ALCANCE de esta migración (siguiente paso, UI):
--   - paso 6 del wizard (opción "Abono" + captura de cliente),
--   - pantalla Viajes (buscar el folio, modal, botón "Cobrar saldo"),
--   - el renderer ESC/POS del comprobante (va en `src/printing/templates/`,
--     fuera de SQL).
-- =============================================================================


-- 1. `core.print_job` — nuevo template + `venta_id`.
-- -----------------------------------------------------------------------------
-- DEFERRABLE INITIALLY IMMEDIATE (0040): toda FK de `core` debe serlo, para que
-- el bootstrap pueda diferir el orden de inserción dentro de un lote.
ALTER TABLE core.print_job ADD COLUMN venta_id uuid
  REFERENCES core.venta(id) DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE core.print_job DROP CONSTRAINT print_job_template_key_check;
ALTER TABLE core.print_job ADD CONSTRAINT print_job_template_key_check
  CHECK (template_key IN
    ('boleto','manifiesto_conductor','manifiesto_terminal',
     'corte','etiqueta_paquete','comprobante_reserva'));

-- Invariante: `comprobante_reserva` siempre lleva `venta_id` y NUNCA `boleto_id`
-- (cubre N boletos); cualquier otro template es al revés. La base lo garantiza,
-- no la disciplina del código que inserta.
ALTER TABLE core.print_job ADD CONSTRAINT print_job_comprobante_reserva_check
  CHECK (
    (template_key = 'comprobante_reserva' AND venta_id IS NOT NULL AND boleto_id IS NULL)
    OR (template_key <> 'comprobante_reserva' AND venta_id IS NULL)
  );


-- 2. Snapshot del comprobante — todos los boletos vivos de la venta, saldo y
--    cliente. Igual que `snapshot_boleto`, es un STABLE recalculado cada vez
--    que se encola (no hay reimpresión congelada previa que preservar aquí).
--
--    Recibe la sucursal de COBRO por separado de `venta.sucursal_venta_id`:
--    una reservación puede haberse hecho en una sucursal y el abono cobrarse
--    en otra (C5, igual que `registrar_pago`/`sucursal_cobro_id`) — el papel
--    debe decir dónde se recibió ESTE abono, no dónde se originó la reserva.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.snapshot_comprobante_reserva(
  p_venta_id uuid, p_sucursal_cobro_id uuid
)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'venta_id',         v.id,
    'folios',           (SELECT jsonb_agg(b.folio ORDER BY b.asiento_num)
                            FROM core.boleto b WHERE b.venta_id = v.id AND b.activo),
    'pasajeros',        (SELECT jsonb_agg(jsonb_build_object(
                              'nombre',  b.pasajero_nombre,
                              'asiento', b.asiento_num,
                              'importe', b.importe
                            ) ORDER BY b.asiento_num)
                            FROM core.boleto b WHERE b.venta_id = v.id AND b.activo),
    'cliente_nombre',   cli.nombre,
    'cliente_telefono', v.contacto_telefono,
    'importe_total',    v.importe_total,
    'pagado',           vs.pagado,
    'saldo_pendiente',  vs.saldo_pendiente,
    'origen',           puo.nombre,
    'origen_direccion', so.direccion_completa,
    'origen_telefono',  so.telefono_principal,
    'destino',          pud.nombre,
    'fecha_hora_viaje', to_char(spo.hora_paso_programada
                                AT TIME ZONE COALESCE(so.zona_horaria, puo.zona_horaria),
                                'YYYY-MM-DD HH24:MI'),
    'sucursal_cobro',   scb.nombre,
    'vendedor',         u.nombre,
    'generado_en',      to_char(now()
                                AT TIME ZONE COALESCE(so.zona_horaria, puo.zona_horaria),
                                'YYYY-MM-DD HH24:MI')
  )
  FROM core.venta v
  JOIN core.usuario u          ON u.id  = v.usuario_id
  JOIN core.sucursal scb       ON scb.id = p_sucursal_cobro_id
  LEFT JOIN core.cliente cli   ON cli.id = v.cliente_id
  JOIN core.v_venta_saldo vs   ON vs.venta_id = v.id
  JOIN core.salida s           ON s.id  = v.salida_id
  JOIN core.salida_parada spo  ON spo.salida_id = s.id AND spo.orden = v.parada_origen_orden
  JOIN core.punto_ruta puo     ON puo.id = spo.punto_id
  LEFT JOIN core.sucursal so   ON so.id = puo.sucursal_id
  JOIN core.salida_parada spd  ON spd.salida_id = s.id AND spd.orden = v.parada_destino_orden
  JOIN core.punto_ruta pud     ON pud.id = spd.punto_id
  WHERE v.id = p_venta_id
$$;

COMMENT ON FUNCTION core.snapshot_comprobante_reserva(uuid, uuid) IS
  'Snapshot de un comprobante de anticipo: todos los boletos vivos de la venta, saldo, cliente y la sucursal donde se cobró (puede diferir de la de venta, C5). Blueprint Ses. 71.';


-- 3. Encola el comprobante — una sola vez por venta (igual que
--    `encolar_impresion_venta` no duplica el ticket de un boleto ya encolado).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.encolar_comprobante_reserva(
  p_venta_id uuid, p_sucursal_id uuid
)
RETURNS integer
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM core.print_job pj
     WHERE pj.venta_id = p_venta_id
       AND pj.template_key = 'comprobante_reserva'
       AND NOT pj.es_reimpresion
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO core.print_job (id, sucursal_id, template_key, datos, venta_id, estado)
  VALUES (core.uuid_v7(), p_sucursal_id, 'comprobante_reserva',
          core.snapshot_comprobante_reserva(p_venta_id, p_sucursal_id), p_venta_id, 'pendiente');
  RETURN 1;
END $$;

COMMENT ON FUNCTION core.encolar_comprobante_reserva(uuid, uuid) IS
  'Encola el comprobante de anticipo (nunca el boleto) cuando un pago es_abono deja la venta pendiente. Ses. 71.';


-- 4. `core.registrar_venta` — copia vigente de 0065 + encola el comprobante
--    cuando el pago es abono y la venta no queda liquidada. Gana la columna
--    `comprobante_impreso` ⇒ DROP + CREATE.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.registrar_venta(uuid, uuid, uuid, text, integer, integer, jsonb, boolean, uuid, jsonb, boolean, timestamptz);

CREATE FUNCTION core.registrar_venta(
  p_salida_id uuid, p_sucursal_venta_id uuid, p_usuario_id uuid, p_contacto_telefono text,
  p_origen_orden integer, p_destino_orden integer, p_pasajeros jsonb,
  p_es_reservacion boolean DEFAULT false, p_cliente_id uuid DEFAULT NULL::uuid,
  p_pago jsonb DEFAULT NULL::jsonb, p_con_conexion boolean DEFAULT true,
  p_ahora timestamp with time zone DEFAULT now()
)
RETURNS TABLE(venta_id uuid, estado_venta text, importe_total numeric, pagado numeric,
              saldo_pendiente numeric, boletos jsonb, print_jobs integer, imprimible boolean,
              comprobante_impreso boolean)
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
  v_degradado      boolean;
  v_efectivo_recibido numeric;
  v_efectivo_cambio   numeric;
  v_transfer_finalizada boolean := false;
  v_estado_final   text;
  v_comprobante_impreso boolean := false;   -- 0071
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

  PERFORM core.liberar_reservas_caducas(p_salida_id, p_ahora);

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

  v_degradado := core.sync_degradado(p_sucursal_venta_id, p_ahora);

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

    v_efectivo_recibido := NULLIF(p_pago->>'efectivo_recibido', '')::numeric;
    IF v_efectivo_recibido IS NOT NULL THEN
      IF v_metodo <> 'efectivo' THEN
        RAISE EXCEPTION 'el efectivo recibido solo aplica a un pago en efectivo (método %)', v_metodo;
      END IF;
      IF v_efectivo_recibido < v_monto THEN
        RAISE EXCEPTION 'el efectivo recibido (%) no cubre el monto a cobrar (%)',
          v_efectivo_recibido, v_monto;
      END IF;
      v_efectivo_cambio := v_efectivo_recibido - v_monto;
    END IF;

    v_transfer_finalizada := (v_metodo = 'transferencia' AND NOT v_es_abono
                              AND v_monto >= v_importe_total);
  END IF;

  v_saldo     := v_importe_total - v_pagado;
  v_liquidada := v_saldo <= 0;
  v_prioridad := CASE WHEN v_liquidada THEN 3
                      WHEN v_pagado > 0 OR v_transfer_finalizada THEN 2
                      ELSE 1 END;
  v_estado_final := CASE WHEN v_liquidada THEN 'liquidada'
                         WHEN v_transfer_finalizada THEN 'finalizada_transferencia'
                         ELSE 'pendiente' END;

  INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, cliente_id, contacto_telefono,
                          es_reservacion, salida_id, parada_origen_orden, parada_destino_orden,
                          importe_total, estado)
  VALUES (core.uuid_v7(), p_sucursal_venta_id, p_usuario_id, p_cliente_id, p_contacto_telefono,
          p_es_reservacion, p_salida_id, p_origen_orden, p_destino_orden,
          v_importe_total, v_estado_final)
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
    ELSIF (NOT p_con_conexion OR v_degradado)
          AND NOT core.asiento_en_cupo(p_salida_id, v_asiento, p_origen_orden, p_destino_orden,
                                       p_sucursal_venta_id, p_ahora) THEN
      IF NOT p_con_conexion THEN
        RAISE EXCEPTION 'sin conexión, el asiento % no está en el cupo vigente de la sucursal %',
          v_asiento, p_sucursal_venta_id;
      ELSE
        RAISE EXCEPTION 'la terminal lleva demasiado tiempo sin sincronizar: hasta ponerse al día solo puede vender los asientos de su cupo (el % no está); evita sobreventa entre sucursales',
          v_asiento;
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
                           metodo, monto, es_abono, verificado, referencia_transferencia,
                           efectivo_recibido, efectivo_cambio, pagado_en)
    VALUES (core.uuid_v7(), v_venta_id, v_sucursal_cobro, v_corte_id, p_usuario_id,
            v_metodo, v_monto, v_es_abono, v_metodo IN ('efectivo', 'corresponsal'),
            CASE WHEN v_metodo = 'transferencia' THEN p_pago->>'referencia' END,
            v_efectivo_recibido, v_efectivo_cambio, p_ahora);
  END IF;

  -- 0065: una venta liquidada O finalizada por transferencia imprime su boleto.
  IF v_liquidada OR v_transfer_finalizada THEN
    v_print_jobs := core.encolar_impresion_venta(v_venta_id);
  -- 0071: un abono que deja la venta pendiente imprime el comprobante, nunca el
  -- boleto (regla PO Ses. 71: "no debe imprimir los boletos, pero sí un
  -- comprobante de pago").
  ELSIF v_es_abono THEN
    PERFORM core.encolar_comprobante_reserva(v_venta_id, p_sucursal_venta_id);
    v_comprobante_impreso := true;
  END IF;

  RETURN QUERY SELECT
    v_venta_id, v_estado_final,
    v_importe_total, v_pagado, v_saldo, v_boletos, v_print_jobs,
    (v_liquidada OR v_transfer_finalizada), v_comprobante_impreso;
END $function$;

COMMENT ON FUNCTION core.registrar_venta(uuid, uuid, uuid, text, integer, integer, jsonb, boolean, uuid, jsonb, boolean, timestamptz) IS
  'Venta / reserva de una salida. Tarifa estricta + categoría (D4); descuento por tipo de punto (F3-D2); `corresponsal` (D8); efectivo recibido + cambio (0064); transferencia íntegra ⇒ finalizada_transferencia + imprime (0065); abono parcial ⇒ comprobante de anticipo, sin boleto (0071); libera reservas caducas (D9); cupo propio si offline/degradado (§3.3).';


-- 5. `core.registrar_pago` — copia vigente de 0023 + encola el comprobante
--    cuando el pago es abono y la venta no queda liquidada (mismo caso que en
--    `registrar_venta`, para el abono que se registra en una visita separada,
--    o el "cobrar saldo" en origen si por lo que sea no cubre el total). Gana
--    la columna `comprobante_impreso` ⇒ DROP + CREATE.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.registrar_pago(uuid, uuid, uuid, text, numeric, boolean, text, uuid, timestamptz);

CREATE FUNCTION core.registrar_pago(
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
  pago_id             uuid,
  pagado              numeric,
  saldo_pendiente     numeric,
  liquidada           boolean,
  print_jobs          integer,
  comprobante_impreso boolean
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
  v_comprobante  boolean := false;   -- 0071
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
  ELSIF p_es_abono THEN
    PERFORM core.encolar_comprobante_reserva(p_venta_id, p_sucursal_cobro_id);
    v_comprobante := true;
  END IF;

  RETURN QUERY SELECT v_pago_id, v_pagado, v_saldo, v_liq, v_pj, v_comprobante;
END $$;

COMMENT ON FUNCTION core.registrar_pago(uuid, uuid, uuid, text, numeric, boolean, text, uuid, timestamptz) IS
  'Añade un pago (abono o liquidación) a una venta. El cobro puede ser en otra sucursal (C5). Un abono que no liquida encola el comprobante de anticipo (0071).';
