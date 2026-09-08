-- =============================================================================
-- 0051 · Categoría de pasajero y validación estricta de tarifa. Fase 3 de
--        "paradas autorizadas". docs/architecture/05-paradas-autorizadas-tarifas.md §4
--
-- CIERRA (D4 / P-2): `core.registrar_venta` deja de sumar a ciegas el `importe`
-- que manda el cliente y lo valida contra `core.tarifa` por categoría de pasajero
-- (`general` | `inapam` | `menor`). Sin tarifa vigente para el par
-- (ruta, tramo, categoría) ⇒ rechaza; `pasajero.importe` debe igualar esa tarifa.
-- El descuento (`categoria <> 'general'`) solo aplica de la terminal de origen a
-- la de destino (tramo completo, HJP↔CDMX), nunca en una parada intermedia.
-- Interruptor `core.parametro` `validar_tarifa_estricta` (default `true`).
-- `core.tarifa` gana `tope_asientos smallint` — estructural, NO se valida hoy.
-- `core.boleto` guarda `categoria_pasajero` (NO se imprime — D7).
--
-- SIN COMPAT TRIGGER: `categoria_pasajero NOT NULL DEFAULT 'general'` cubre el
-- ingest desde una nube en 0049/0050 (0031 toma columnas reales; la ausente cae
-- al DEFAULT, que es lo correcto — toda tarifa/boleto actual es 'general'). Un
-- nodo en 0051 que empuja `boleto` a una nube en 0050 ve su columna ignorada
-- hasta que la nube llegue a 0051 (misma ventana de deploy). 0050 y 0051 van
-- juntos.
-- =============================================================================


-- 1. `core.tarifa`: categoría + tope de asientos (estructural).
-- ---------------------------------------------------------------------------
ALTER TABLE core.tarifa
  ADD COLUMN categoria_pasajero text NOT NULL DEFAULT 'general'
    CONSTRAINT tarifa_categoria_chk CHECK (categoria_pasajero IN ('general','inapam','menor')),
  ADD COLUMN tope_asientos smallint;   -- NULL = sin tope (D4 futuro; no se valida hoy)


-- 2. `core.v_tarifa_vigente`: una vista `SELECT *` NO adopta sola las columnas
--    nuevas de la tabla base — hay que recrearla.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_tarifa_vigente AS
SELECT * FROM core.tarifa
 WHERE activo AND effective_from <= now()
   AND (effective_until IS NULL OR effective_until > now());


-- 3. `core.boleto`: la categoría con que se emitió (para el corte de Fase 5).
-- ---------------------------------------------------------------------------
ALTER TABLE core.boleto
  ADD COLUMN categoria_pasajero text NOT NULL DEFAULT 'general'
    CONSTRAINT boleto_categoria_chk CHECK (categoria_pasajero IN ('general','inapam','menor'));


-- 4. Parámetro `validar_tarifa_estricta` (clase A; se propaga a los nodos).
--    Bajo `donaji.replicando` para no sellar HLC/outbox en la migración.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);
  INSERT INTO core.parametro (clave, valor, descripcion) VALUES
    ('validar_tarifa_estricta', 'true'::jsonb,
     'D4. true: core.registrar_venta exige que cada pasajero.importe iguale la '
     'core.tarifa vigente de su (ruta, tramo, categoria); sin tarifa vigente => '
     'rechaza. false: no valida el importe (comportamiento pre-Fase 3).')
  ON CONFLICT (clave) DO NOTHING;
  PERFORM set_config('donaji.replicando', 'off', true);
END $$;


-- 5. `core.buscar_salidas` — cambia el `RETURNS TABLE` (gana `tarifas jsonb`),
--    así que DROP + CREATE (patrón 0043). La columna escalar `importe` sigue
--    siendo la tarifa 'general' (el `LEFT JOIN t` filtrado a 'general' — sin él
--    matchearía 3 filas por tramo y duplicaría salidas). `tarifas` lleva el mapa
--    { categoria: importe } para que la SPA arme el selector por pasajero (D4).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.buscar_salidas(date, uuid, uuid, integer, uuid, boolean, timestamptz);

CREATE FUNCTION core.buscar_salidas(
  p_fecha               date,
  p_origen              uuid,
  p_destino             uuid,
  p_n_personas          integer,
  p_sucursal_vendedora  uuid,
  p_con_conexion        boolean DEFAULT true,
  p_ahora               timestamptz DEFAULT now()
)
RETURNS TABLE (
  salida_id          uuid,
  horario_id         uuid,
  fecha_operacion    date,
  hora_salida_origen timestamptz,
  origen_orden       smallint,
  destino_orden      smallint,
  estado             text,
  cierre_venta_en    timestamptz,
  importe            numeric,
  asientos_ofrecibles smallint[],
  disponibles        integer,
  seleccionable      boolean,
  ruta_nombre        text,
  origen_nombre      text,
  destino_nombre     text,
  escalas            text[],
  tarifas            jsonb
)
LANGUAGE sql STABLE AS $$
  SELECT s.id,
         s.horario_id,
         s.fecha_operacion,
         spo.hora_paso_programada,
         spo.orden,
         spd.orden,
         s.estado,
         spo.cierre_venta_en,
         t.importe,
         ofr.asientos,
         cardinality(ofr.asientos),
         s.estado = 'programada'
           AND spo.cierre_venta_en > p_ahora
           AND cardinality(ofr.asientos) >= p_n_personas,
         r.nombre,
         puo.nombre,
         pud.nombre,
         COALESCE((
           SELECT array_agg(pux.nombre ORDER BY spx.orden)
             FROM core.salida_parada spx
             JOIN core.punto_ruta pux ON pux.id = spx.punto_id
            WHERE spx.salida_id = s.id
              AND spx.orden > spo.orden
              AND spx.orden < spd.orden
         ), ARRAY[]::text[]),
         COALESCE((
           SELECT jsonb_object_agg(x.categoria_pasajero, x.importe)
             FROM (
               SELECT DISTINCT ON (t2.categoria_pasajero)
                      t2.categoria_pasajero, t2.importe
                 FROM core.v_tarifa_vigente t2
                WHERE t2.ruta_id = h.ruta_id
                  AND t2.parada_origen_orden = spo.orden
                  AND t2.parada_destino_orden = spd.orden
                ORDER BY t2.categoria_pasajero, t2.effective_from DESC
             ) x
         ), '{}'::jsonb)
    FROM core.salida s
    JOIN core.salida_parada spo
      ON spo.salida_id = s.id AND spo.punto_id = p_origen
    JOIN core.salida_parada spd
      ON spd.salida_id = s.id AND spd.punto_id = p_destino
    JOIN core.horario h ON h.id = s.horario_id
    JOIN core.ruta    r ON r.id = h.ruta_id
    -- El origen debe permitir ascenso en ESTA ruta (D2 / P-1): una parada de solo
    -- descenso nunca origina una venta.
    -- CAMBIO DE COMPORTAMIENTO (F1-D2): antes no había join a `ruta_parada`, así
    -- que una parada dada de baja (`activo = false`) seguía apareciendo como
    -- origen mientras existiera su `salida_parada`. Ahora `rpo.activo` la quita de
    -- la búsqueda para ese origen — intencional y coherente con D5 (baja lógica
    -- de parada de ruta).
    JOIN core.ruta_parada rpo
      ON rpo.ruta_id = h.ruta_id AND rpo.punto_id = p_origen
     AND rpo.permite_ascenso AND rpo.activo
    JOIN core.punto_ruta puo ON puo.id = p_origen
    JOIN core.punto_ruta pud ON pud.id = p_destino
    -- Tarifa 'general' para el listado; los descuentos por categoría se resuelven
    -- en la venta (D4), no se muestran en la búsqueda.
    LEFT JOIN core.v_tarifa_vigente t
      ON t.ruta_id = h.ruta_id
     AND t.parada_origen_orden = spo.orden
     AND t.parada_destino_orden = spd.orden
     AND t.categoria_pasajero = 'general'
    CROSS JOIN LATERAL (
      SELECT core.asientos_ofrecibles(
        s.id, spo.orden, spd.orden, p_sucursal_vendedora, p_con_conexion, p_ahora
      ) AS asientos
    ) ofr
   WHERE s.activo
     AND h.activo
     AND r.activo
     AND s.fecha_operacion = p_fecha
     AND s.estado = 'programada'
     AND spo.orden < spd.orden
   ORDER BY spo.hora_paso_programada, r.nombre
$$;

COMMENT ON FUNCTION core.buscar_salidas(date, uuid, uuid, integer, uuid, boolean, timestamptz) IS
  'Paso 2 del flujo de venta: salidas del día origen→destino (origen/destino = core.punto_ruta.id) con ruta, escalas, disponibilidad, tarifa general (columna `importe`) y el mapa `tarifas` {categoria: importe} para el selector por pasajero. El origen debe permitir ascenso. Blueprint F4 · 05 §4.';


-- 6. `core.registrar_venta` — copia vigente de 0050 + resolución de la tarifa por
--    categoría de pasajero y validación estricta del importe (D4 / P-2).
-- ---------------------------------------------------------------------------
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
  v_tramo_ocup    int4range;
  v_ruta_id       uuid;
  v_validar_estr  boolean;
  v_categoria     text;
  v_tarifa        numeric;
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

    -- D4: el descuento solo aplica terminal-extremo → terminal-extremo (HJP↔CDMX),
    -- nunca en una parada intermedia.
    IF v_categoria <> 'general'
       AND NOT (p_origen_orden = 0 AND p_destino_orden = v_n_paradas - 1) THEN
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
END $$;

COMMENT ON FUNCTION core.registrar_venta(uuid, uuid, uuid, text, integer, integer, jsonb, boolean, uuid, jsonb, boolean, timestamptz) IS
  'Registra una venta o reservación: N boletos (viaje + ocupación), N ocupaciones firmes, pago opcional. Valida el importe de cada pasajero contra core.tarifa por categoría (D4, si validar_tarifa_estricta). Blueprint F4 · 05 §3-§4.';
