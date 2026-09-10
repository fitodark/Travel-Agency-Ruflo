-- =============================================================================
-- 0063 · Catch-up antes de vender asientos fuera de cupo (arrastre de F1).
--        docs/architecture/01-sincronizacion.md §3.3 (cadencia — "catch-up antes
--        de vender asientos fuera de cupo") · 01b §4 (regla de oro del modo
--        offline) · engine.ts (stale-guard: "se prohíben overrides de asiento
--        fuera de cupo").
--
-- QUÉ RESUELVE. Único arrastre abierto de F1 (`it.todo` en
-- `tests/sync/engine.test.ts`): una terminal que lleva demasiado tiempo sin
-- sincronizar cree estar "online" (`p_con_conexion = true`) y puede tomar
-- cualquier asiento libre por lease — pero su vista de las ventas de las demás
-- sucursales está vieja, así que "libre" puede estar vendido en otra parte. El
-- motor ya expone la señal (`sync.salud.ultima_sync_exitosa`); faltaba que el
-- camino de venta la consultara.
--
-- CÓMO. Mientras el nodo está **degradado** (más de `umbral_sync_degradado_horas`
-- —72 h por defecto— sin sync), la venta se restringe al **cupo propio** aunque
-- diga tener conexión: como si estuviera offline. Sale del bloqueo solo cuando el
-- motor vuelve a sincronizar (refresca `ultima_sync_exitosa`). Un nodo que nunca
-- ha sincronizado (recién instalado) NO se considera degradado — está empezando,
-- no atrasado (misma convención que `engine.ts` / `reporte.v_salud_sucursal`).
--   * `core.sync_degradado(sucursal, ahora)` — la señal.
--   * `core.asiento_en_cupo(salida, asiento, desde, hasta, sucursal, ahora)` — el
--     predicado del cupo vigente (con zona muerta), extraído para no duplicarlo.
--   * `core.asientos_ofrecibles` — el paso 2/3 deja de ofrecer asientos fuera de
--     cupo si el nodo está degradado (para que el operador ni los vea).
--   * `core.adquirir_lease` — rechaza un lease fuera de cupo si el nodo está
--     degradado.
--   * `core.registrar_venta` — backstop: sin lease, exige cupo si offline O
--     degradado.
--
-- DEPLOY. `CREATE OR REPLACE` de 2 funciones nuevas + 3 re-emitidas. Sin datos
-- que migrar, sin ventana coordinada. Inerte para un nodo que sincroniza a
-- diario: `ultima_sync_exitosa` siempre está fresca.
-- =============================================================================


-- 1. `core.sync_degradado` — ¿el nodo lleva demasiado sin sincronizar?
--    Misma regla que `reporte.v_salud_sucursal.degradado` (0029).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.sync_degradado(
  p_sucursal_id uuid,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  -- El COALESCE externo cubre los dos casos "no degradado": no hay fila en
  -- `sync.salud` para esta sucursal, o la hay pero `ultima_sync_exitosa` es NULL
  -- (reportó pero aún no sincronizó — arrancando, no atrasado).
  SELECT COALESCE(
    (SELECT sa.ultima_sync_exitosa < p_ahora - make_interval(hours => COALESCE(
       (SELECT (valor)::text::int FROM core.parametro
         WHERE clave = 'umbral_sync_degradado_horas' AND effective_from <= p_ahora
         ORDER BY effective_from DESC LIMIT 1), 72))
       FROM sync.salud sa
      WHERE sa.sucursal_id = p_sucursal_id),
    false)
$$;

COMMENT ON FUNCTION core.sync_degradado(uuid, timestamptz) IS
  'F1/§3.3. true si la sucursal lleva más del umbral (72 h) sin sincronizar. Un nodo que nunca sincronizó = false (arrancando, no atrasado).';


-- 2. `core.asiento_en_cupo` — el asiento está en el cupo offline vigente de la
--    sucursal para el tramo, descontando la zona muerta (01b §4).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.asiento_en_cupo(
  p_salida_id   uuid,
  p_asiento     smallint,
  p_desde       integer,
  p_hasta       integer,
  p_sucursal_id uuid,
  p_ahora       timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.cupo_offline co
     WHERE co.salida_id = p_salida_id
       AND co.sucursal_id = p_sucursal_id
       AND p_asiento = ANY (co.asientos)
       AND co.tramos @> int4range(p_desde, p_hasta)
       AND co.vigente_desde <= p_ahora
       AND co.vigente_hasta - make_interval(mins => COALESCE(
         (SELECT (valor)::text::integer FROM core.parametro
           WHERE clave = 'minutos_zona_muerta' AND effective_from <= p_ahora
           ORDER BY effective_from DESC LIMIT 1), 15)) > p_ahora
  )
$$;

COMMENT ON FUNCTION core.asiento_en_cupo(uuid, smallint, integer, integer, uuid, timestamptz) IS
  '01b §4. El asiento está en el cupo offline vigente de la sucursal para el tramo (con zona muerta descontada).';


-- 3. `core.asientos_ofrecibles` — no ofrece asientos fuera de cupo si el nodo
--    está degradado. Idéntica a 0021 salvo esa condición.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.asientos_ofrecibles(
  p_salida_id           uuid,
  p_desde               integer,
  p_hasta               integer,
  p_sucursal_vendedora  uuid,
  p_con_conexion        boolean DEFAULT true,
  p_ahora               timestamptz DEFAULT now()
)
RETURNS smallint[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_libres    smallint[];
  v_cupo      smallint[];
  v_zona_min  integer;
BEGIN
  v_libres := core.asientos_libres(p_salida_id, p_desde, p_hasta, p_ahora);

  -- Con conexión y al día: cualquier asiento libre. Degradado (§3.3): aunque
  -- diga tener conexión, solo el cupo propio — la vista de otras sucursales
  -- está vieja y "libre" puede estar vendido en otra parte.
  IF p_con_conexion AND NOT core.sync_degradado(p_sucursal_vendedora, p_ahora) THEN
    RETURN v_libres;
  END IF;

  v_zona_min := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_zona_muerta' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1),
    15);

  SELECT co.asientos INTO v_cupo
    FROM core.cupo_offline co
   WHERE co.salida_id = p_salida_id
     AND co.sucursal_id = p_sucursal_vendedora
     AND co.tramos @> int4range(p_desde, p_hasta)
     AND co.vigente_desde <= p_ahora
     AND co.vigente_hasta - make_interval(mins => v_zona_min) > p_ahora;

  IF v_cupo IS NULL THEN
    RETURN ARRAY[]::smallint[];
  END IF;

  RETURN ARRAY(
    SELECT n FROM unnest(v_libres) n
     WHERE n = ANY (v_cupo)
     ORDER BY n
  );
END $$;

COMMENT ON FUNCTION core.asientos_ofrecibles(uuid, integer, integer, uuid, boolean, timestamptz) IS
  'Asientos que una sucursal puede ofrecer en el paso 3: libres, y solo los de su cupo vigente si está offline O degradada (§3.3). 01b §3.4.';


-- 4. `core.adquirir_lease` — rechaza un lease fuera de cupo si el nodo está
--    degradado. Idéntica a 0058 salvo ese guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.adquirir_lease(
  p_salida_id uuid, p_asiento_num smallint, p_desde integer, p_hasta integer,
  p_sucursal_id uuid, p_duracion_seg integer DEFAULT NULL::integer,
  p_ahora timestamp with time zone DEFAULT now()
)
RETURNS TABLE(estado text, lease_id uuid, expira_en timestamp with time zone)
LANGUAGE plpgsql AS $function$
DECLARE
  v_estado_salida text;
  v_n_tramos      integer;
  v_dur_seg       integer;
  v_id            uuid;
  v_exp           timestamptz;
  v_ocup          int4range;
BEGIN
  SELECT s.estado INTO v_estado_salida FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado_salida <> 'programada' THEN
    RAISE EXCEPTION 'la salida % está % : no se puede reservar asiento', p_salida_id, v_estado_salida;
  END IF;

  SELECT count(*)::int INTO v_n_tramos
    FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF p_desde < 0 OR p_hasta <= p_desde OR p_hasta > v_n_tramos - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_desde, p_hasta, p_salida_id, v_n_tramos;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM core.salida_parada sp
      JOIN core.salida sa      ON sa.id = sp.salida_id
      JOIN core.horario h      ON h.id  = sa.horario_id
      JOIN core.ruta_parada rp ON rp.ruta_id = h.ruta_id AND rp.punto_id = sp.punto_id
     WHERE sp.salida_id = p_salida_id
       AND sp.orden = p_desde
       AND rp.permite_ascenso AND rp.activo
  ) THEN
    RAISE EXCEPTION 'la parada de origen (orden %) de la salida % no permite ascenso',
      p_desde, p_salida_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM core.salida s
      CROSS JOIN LATERAL jsonb_array_elements(s.mapa_snapshot->'asientos') e
     WHERE s.id = p_salida_id
       AND (e->>'num')::smallint = p_asiento_num
       AND COALESCE((e->>'vendible')::boolean, true)
  ) THEN
    RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida %', p_asiento_num, p_salida_id;
  END IF;

  -- §3.3: un lease es "venta con conexión fuera del cupo propio". Si el nodo
  -- lleva demasiado sin sincronizar, no se concede fuera de cupo: el arbitraje
  -- sería a ciegas y podría sobrevender.
  IF core.sync_degradado(p_sucursal_id, p_ahora)
     AND NOT core.asiento_en_cupo(p_salida_id, p_asiento_num, p_desde, p_hasta, p_sucursal_id, p_ahora)
  THEN
    RAISE EXCEPTION 'la terminal lleva demasiado tiempo sin sincronizar: hasta ponerse al día solo puede vender los asientos de su cupo (evita sobreventa entre sucursales)';
  END IF;

  v_ocup := core.tramo_ocupacion(p_salida_id, p_desde, p_hasta);

  -- D9: materializa la caducidad de reservas sin pagar de esta salida.
  PERFORM core.liberar_reservas_caducas(p_salida_id, p_ahora);

  UPDATE core.asiento_lease AS al
     SET liberado_en = al.expira_en
   WHERE al.salida_id = p_salida_id
     AND al.asiento_num = p_asiento_num
     AND al.consumido_por_boleto_id IS NULL
     AND al.liberado_en IS NULL
     AND al.expira_en <= p_ahora;

  IF EXISTS (
    SELECT 1 FROM core.asiento_ocupacion o
     WHERE o.salida_id = p_salida_id
       AND o.asiento_num = p_asiento_num
       AND o.estado = 'firme'
       AND o.tramos_ocupacion && v_ocup
  ) THEN
    estado := 'ocupado'; RETURN NEXT; RETURN;
  END IF;

  v_dur_seg := COALESCE(
    p_duracion_seg,
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_lease' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1) * 60,
    900);
  v_exp := p_ahora + make_interval(secs => v_dur_seg);

  BEGIN
    INSERT INTO core.asiento_lease
      (salida_id, asiento_num, tramos, tramos_ocupacion, sucursal_id, otorgado_en, expira_en)
    VALUES
      (p_salida_id, p_asiento_num, int4range(p_desde, p_hasta), v_ocup, p_sucursal_id,
       p_ahora, v_exp)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    estado := 'lease_ajeno'; RETURN NEXT; RETURN;
  END;

  estado := 'otorgado'; lease_id := v_id; expira_en := v_exp;
  RETURN NEXT;
END $function$;


-- 5. `core.registrar_venta` — backstop: sin lease, el asiento debe estar en el
--    cupo propio si la terminal está offline O degradada. Idéntica a 0058 salvo
--    ese bloque.
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

  -- D9: materializa la caducidad de reservas sin pagar de esta salida antes de
  -- evaluar la disponibilidad del asiento.
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

  -- §3.3: si el nodo lleva demasiado sin sincronizar, la venta sin lease se
  -- restringe al cupo propio aunque diga tener conexión.
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
  'Venta / reserva de una salida. Tarifa estricta + categoría (D4); descuento por tipo de punto (F3-D2); pago `corresponsal` (D8); libera reservas caducas (D9); sin lease exige cupo propio si offline o degradado (§3.3). 02b §4 / 05 §4.';
