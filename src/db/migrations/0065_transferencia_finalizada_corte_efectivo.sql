-- =============================================================================
-- 0065 · Venta por transferencia: se finaliza e imprime al registrar; se
--        confirma después; el corte separa efectivo de transferencia.
--        docs/architecture/02b-modelo-transaccional.md §2.2, §3
--
-- QUÉ CAMBIA (feedback de QA sobre 0064):
--
--  1. Al REGISTRAR una venta pagada íntegra por transferencia, la venta queda
--     `estado = 'finalizada_transferencia'` y **se imprime el boleto** (el
--     pasajero puede abordar). Antes quedaba 'pendiente' sin imprimir.
--
--  2. La CONFIRMACIÓN del comprobante ("marcar pagado"):
--     - La puede hacer **quien vendió** O un usuario con el permiso nuevo
--       `pago.transferencia.confirmar` (gerente / administrador). Antes solo el
--       vendedor de la venta.
--     - El monto suma al **corte abierto en ese momento** de la sucursal de
--       cobro (no al corte de cuando se vendió, que puede estar cerrado). Si no
--       hay corte abierto, se rechaza.
--     - La venta pasa a `estado = 'liquidada'`.
--
--  3. El CORTE separa el efectivo del dinero por transferencia:
--     - `core.v_corte_saldo` gana `ingresos_efectivo`, `ingresos_transferencia`
--       y `efectivo_calculado` (= inicial + ingresos en efectivo − egresos).
--     - `core.cerrar_corte` compara el efectivo DECLARADO (contado físicamente)
--       contra `efectivo_calculado`, NO contra el total. La transferencia se
--       reporta aparte: suma al corte pero no es efectivo en la terminal.
--     - `core.f_cortes_visibles` (historial) aplica la misma regla.
--
-- SIN CAMBIO DE FIRMA en `registrar_venta` / `verificar_transferencia`
-- (`CREATE OR REPLACE`). `cerrar_corte` y `f_cortes_visibles` cambian su
-- `RETURNS TABLE` ⇒ DROP + CREATE (patrón 0043).
--
-- SIN COMPAT TRIGGER: `venta.estado` gana un valor en el CHECK; el ingest (0031)
-- copia el valor real. Un nodo viejo nunca emite 'finalizada_transferencia'.
-- =============================================================================


-- 1. `core.venta.estado` — nuevo valor `finalizada_transferencia`.
-- ---------------------------------------------------------------------------
ALTER TABLE core.venta DROP CONSTRAINT venta_estado_check;
ALTER TABLE core.venta ADD  CONSTRAINT venta_estado_check
  CHECK (estado IN ('pendiente','liquidada','cancelada','conflicto','finalizada_transferencia'));


-- 2. Permiso `pago.transferencia.confirmar` (gerente + administrador).
--    Bajo `donaji.replicando` para no sellar HLC/outbox en la migración (0051).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);
  INSERT INTO core.rol_permiso (rol, permiso) VALUES
    ('gerente',       'pago.transferencia.confirmar'),
    ('administrador', 'pago.transferencia.confirmar')
  ON CONFLICT DO NOTHING;
  PERFORM set_config('donaji.replicando', 'off', true);
END $$;


-- 3. `core.v_corte_saldo` — separa efectivo de transferencia (columnas nuevas
--    al final: `CREATE OR REPLACE VIEW` las admite).
--    Un `movimiento_caja` de ingreso 'pago_boleto' cuyo `pago.metodo` es
--    'transferencia' NO es efectivo físico. Todo lo demás (efectivo, otros
--    ingresos, egresos) mueve el efectivo de la caja.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_corte_saldo AS
SELECT c.id AS corte_caja_id,
       c.saldo_inicial,
       COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='ingreso'), 0) AS ingresos,
       COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='egreso'),  0) AS egresos,
       c.saldo_inicial
         + COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='ingreso'), 0)
         - COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='egreso'),  0)
         AS saldo_calculado,
       -- 0065: ingresos que SÍ son efectivo físico (todo menos transferencia).
       COALESCE(SUM(m.monto) FILTER (
         WHERE m.activo AND m.tipo='ingreso'
           AND (p.metodo IS NULL OR p.metodo <> 'transferencia')), 0) AS ingresos_efectivo,
       -- 0065: ingresos por transferencia verificada (suman al corte, no a la caja).
       COALESCE(SUM(m.monto) FILTER (
         WHERE m.activo AND m.tipo='ingreso' AND p.metodo = 'transferencia'), 0) AS ingresos_transferencia,
       -- 0065: efectivo que debe haber en la caja = inicial + ingresos efectivo - egresos.
       c.saldo_inicial
         + COALESCE(SUM(m.monto) FILTER (
             WHERE m.activo AND m.tipo='ingreso'
               AND (p.metodo IS NULL OR p.metodo <> 'transferencia')), 0)
         - COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='egreso'), 0)
         AS efectivo_calculado
  FROM core.corte_caja c
  LEFT JOIN core.movimiento_caja m ON m.corte_caja_id = c.id
  LEFT JOIN core.pago p ON p.id = m.origen_id AND m.origen_tipo = 'pago_boleto'
 WHERE c.activo
 GROUP BY c.id, c.saldo_inicial;

COMMENT ON VIEW core.v_corte_saldo IS
  'Saldo del corte (solo movimientos activos). `efectivo_calculado` es lo que debe estar en la caja (excluye transferencia); `saldo_calculado` es el total. 0065.';


-- 4. `core.registrar_venta` — copia vigente de 0064 + transferencia finalizada.
--    Cambios « 0065 »: `v_transfer_finalizada`, el estado de la venta, la
--    prioridad, la impresión y el `imprimible` devuelto.
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
  v_degradado      boolean;
  v_efectivo_recibido numeric;
  v_efectivo_cambio   numeric;
  v_transfer_finalizada boolean := false;   -- 0065
  v_estado_final   text;                    -- 0065
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

    -- 0064: efectivo recibido / cambio.
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

    -- 0065: una transferencia que cubre el total finaliza la venta e imprime el
    -- boleto ahora; el comprobante se confirma después (core.verificar_transferencia).
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
  END IF;

  RETURN QUERY SELECT
    v_venta_id, v_estado_final,
    v_importe_total, v_pagado, v_saldo, v_boletos, v_print_jobs,
    (v_liquidada OR v_transfer_finalizada);
END $function$;

COMMENT ON FUNCTION core.registrar_venta(uuid, uuid, uuid, text, integer, integer, jsonb, boolean, uuid, jsonb, boolean, timestamptz) IS
  'Venta / reserva de una salida. Tarifa estricta + categoría (D4); descuento por tipo de punto (F3-D2); `corresponsal` (D8); efectivo recibido + cambio (0064); transferencia íntegra ⇒ estado finalizada_transferencia + imprime, se confirma después (0065); libera reservas caducas (D9); cupo propio si offline/degradado (§3.3).';


-- 5. `core.verificar_transferencia` — la puede confirmar quien vendió O un
--    usuario con `pago.transferencia.confirmar`; suma al corte abierto AHORA de
--    la sucursal de cobro.
-- ---------------------------------------------------------------------------
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
  v_pago         core.pago%ROWTYPE;
  v_corte_actual uuid;
  v_pagado       numeric;
  v_saldo        numeric;
  v_liq          boolean;
  v_pj           integer := 0;
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

  -- 0065: quien vendió, o un gerente/administrador (permiso).
  IF v_pago.usuario_id <> p_usuario_id
     AND NOT EXISTS (
       SELECT 1 FROM core.usuario u
        JOIN core.rol_permiso rp ON rp.rol = u.rol
       WHERE u.id = p_usuario_id AND rp.permiso = 'pago.transferencia.confirmar'
     )
  THEN
    RAISE EXCEPTION 'solo quien registró la venta o un gerente/administrador puede confirmar la transferencia';
  END IF;

  -- 0065: entra al corte abierto AHORA de la sucursal de cobro (no al de la venta).
  v_corte_actual := core.corte_abierto(v_pago.sucursal_cobro_id);

  UPDATE core.pago
     SET verificado = true, verificado_por = p_usuario_id, verificado_en = p_ahora,
         corte_caja_id = v_corte_actual
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
  'Confirma el comprobante de una transferencia: quien vendió o un gerente/admin (0065). Suma al corte abierto AHORA de la sucursal de cobro; la venta pasa a liquidada. Req. paso 6.';


-- 6. `core.cerrar_corte` — el efectivo declarado se concilia contra el efectivo
--    esperado (no contra el total); la transferencia se reporta aparte.
--    RETURNS TABLE cambia ⇒ DROP + CREATE.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.cerrar_corte(uuid, uuid, numeric, timestamptz);

CREATE FUNCTION core.cerrar_corte(
  p_corte_id           uuid,
  p_usuario_cierre_id  uuid,
  p_saldo_declarado    numeric,
  p_ahora              timestamptz DEFAULT now()
)
RETURNS TABLE (
  saldo_inicial      numeric,
  ingresos           numeric,
  egresos            numeric,
  ingresos_efectivo  numeric,
  transferencia      numeric,
  efectivo_calculado numeric,
  saldo_calculado    numeric,
  saldo_declarado    numeric,
  diferencia         numeric
)
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
  v_sal    record;
BEGIN
  IF p_saldo_declarado IS NULL OR p_saldo_declarado < 0 THEN
    RAISE EXCEPTION 'el saldo declarado no puede ser negativo';
  END IF;

  SELECT c.estado INTO v_estado
    FROM core.corte_caja c WHERE c.id = p_corte_id AND c.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el corte de caja % no existe', p_corte_id;
  END IF;
  IF v_estado = 'cerrado' THEN
    RAISE EXCEPTION 'el corte de caja % ya está cerrado', p_corte_id;
  END IF;

  SELECT s.saldo_inicial, s.ingresos, s.egresos, s.ingresos_efectivo,
         s.ingresos_transferencia, s.efectivo_calculado, s.saldo_calculado
    INTO v_sal
    FROM core.v_corte_saldo s WHERE s.corte_caja_id = p_corte_id;

  UPDATE core.corte_caja
     SET estado                = 'cerrado',
         cerrado_en            = p_ahora,
         usuario_cierre_id     = p_usuario_cierre_id,
         saldo_final_declarado = p_saldo_declarado,
         -- se guarda el EFECTIVO esperado (lo que el declarado debe igualar).
         saldo_final_calculado = v_sal.efectivo_calculado
   WHERE id = p_corte_id;

  RETURN QUERY SELECT
    v_sal.saldo_inicial, v_sal.ingresos, v_sal.egresos, v_sal.ingresos_efectivo,
    v_sal.ingresos_transferencia, v_sal.efectivo_calculado, v_sal.saldo_calculado,
    p_saldo_declarado, p_saldo_declarado - v_sal.efectivo_calculado;
END $$;

COMMENT ON FUNCTION core.cerrar_corte(uuid, uuid, numeric, timestamptz) IS
  'Cierra el corte. `diferencia` = efectivo declarado − efectivo esperado (0065): la transferencia suma al corte pero no es efectivo físico, se reporta aparte.';


-- 7. `core.f_cortes_visibles` — misma regla en el historial. RETURNS TABLE
--    cambia ⇒ DROP + CREATE.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.f_cortes_visibles(text, uuid, uuid, date, date, text);

CREATE FUNCTION core.f_cortes_visibles(
  p_rol         text,
  p_usuario_id  uuid,
  p_sucursal_id uuid,
  p_desde       date DEFAULT NULL,
  p_hasta       date DEFAULT NULL,
  p_estado      text DEFAULT NULL
)
RETURNS TABLE (
  corte_id          uuid,
  sucursal_id       uuid,
  sucursal          text,
  estado            text,
  abierto_en        timestamptz,
  cerrado_en        timestamptz,
  usuario_apertura  text,
  usuario_cierre    text,
  saldo_inicial     numeric,
  ingresos          numeric,
  egresos           numeric,
  transferencia     numeric,
  efectivo_calculado numeric,
  saldo_calculado   numeric,
  saldo_declarado   numeric,
  diferencia        numeric
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.sucursal_id, su.nombre, c.estado, c.abierto_en, c.cerrado_en,
         ua.nombre, uc.nombre,
         cs.saldo_inicial, cs.ingresos, cs.egresos,
         cs.ingresos_transferencia, cs.efectivo_calculado, cs.saldo_calculado,
         c.saldo_final_declarado,
         c.saldo_final_declarado - cs.efectivo_calculado
    FROM core.corte_caja c
    JOIN core.sucursal su      ON su.id = c.sucursal_id
    JOIN core.v_corte_saldo cs ON cs.corte_caja_id = c.id
    JOIN core.usuario ua       ON ua.id = c.usuario_apertura_id
    LEFT JOIN core.usuario uc  ON uc.id = c.usuario_cierre_id
   WHERE c.activo
     AND (p_desde IS NULL OR (c.abierto_en AT TIME ZONE su.zona_horaria)::date >= p_desde)
     AND (p_hasta IS NULL OR (c.abierto_en AT TIME ZONE su.zona_horaria)::date <= p_hasta)
     AND (p_estado IS NULL OR c.estado = p_estado)
     AND CASE p_rol
           WHEN 'administrador' THEN true
           WHEN 'gerente'       THEN c.sucursal_id = p_sucursal_id
           WHEN 'vendedor'      THEN c.usuario_apertura_id = p_usuario_id
           ELSE false
         END
   ORDER BY c.abierto_en DESC
$$;

COMMENT ON FUNCTION core.f_cortes_visibles(text, uuid, uuid, date, date, text) IS
  'Historial de cortes visible por rol. `diferencia` = declarado − efectivo esperado; `transferencia` aparte (0065).';


-- 8. `core.pagos_transferencia_por_verificar` — cola de confirmación: pagos
--    'transferencia' aún sin verificar de una sucursal de cobro. Para el panel
--    del encargado en Caja.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.pagos_transferencia_por_verificar(p_sucursal_id uuid)
RETURNS TABLE (
  pago_id        uuid,
  venta_id       uuid,
  folio          text,
  pasajero       text,
  monto          numeric,
  referencia     text,
  vendedor       text,
  registrado_en  timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT p.id, p.venta_id, b.folio, b.pasajero_nombre, p.monto,
         p.referencia_transferencia, u.nombre, p.pagado_en
    FROM core.pago p
    JOIN core.venta v   ON v.id = p.venta_id
    JOIN core.usuario u ON u.id = p.usuario_id
    LEFT JOIN LATERAL (
      SELECT folio, pasajero_nombre FROM core.boleto
       WHERE venta_id = v.id AND activo ORDER BY creado_en LIMIT 1
    ) b ON true
   WHERE p.sucursal_cobro_id = p_sucursal_id
     AND p.metodo = 'transferencia'
     AND NOT p.verificado
     AND p.activo
     AND v.estado <> 'cancelada'
   ORDER BY p.pagado_en
$$;

COMMENT ON FUNCTION core.pagos_transferencia_por_verificar(uuid) IS
  'Cola del encargado: transferencias registradas en esta sucursal aún sin confirmar el comprobante (0065).';
