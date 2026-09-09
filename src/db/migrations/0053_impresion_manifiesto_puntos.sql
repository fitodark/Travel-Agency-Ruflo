-- =============================================================================
-- 0053 · Impresión y manifiesto sobre core.punto_ruta + reimpresión de boleto.
--        Fase 5a de "paradas autorizadas".
--        docs/architecture/05-paradas-autorizadas-tarifas.md §4-§5.
--
-- CIERRA:
--  * F4-D1: los joins INNER a `core.sucursal` por `salida_parada.sucursal_id` en
--    `snapshot_boleto` (0046), `salidas_del_dia` / `datos_manifiesto` /
--    `generar_manifiestos` (0026) hacían DESAPARECER del manifiesto (y devolver
--    `NULL` en el detalle del boleto) las paradas de ascenso / descenso, que no
--    tienen `sucursal_id`. Ahora leen `core.punto_ruta` (`LEFT JOIN core.sucursal`
--    solo para dirección/teléfono/zona de las terminales).
--  * D7: el boleto muestra el nombre del PUNTO (no el de la sucursal) y el punto
--    de ascenso del pasajero; sin `referencia` (nunca la tuvo, se mantiene así).
--  * N-4: `core.reimprimir_boleto` encola una reimpresión con el MISMO snapshot
--    que el original + `es_reimpresion=true` + `motivo_reimpresion`; el pie con la
--    leyenda lo agrega la plantilla desde `config_ticket.leyenda_reimpresion`.
--
-- FUERA DE 5a:
--  * `DROP COLUMN core.salida_parada.sucursal_id` + retiro de
--    `trg_salida_parada_compat_punto` / `trg_aa_tramos_ocupacion_compat` (0050)
--    + re-cableo de las vistas `api.*` (0030) → Fase 5b.
--  * Rediseño del manifiesto a "lista única por pasajero" (D11) → sub-PR aparte.
--
-- DEPLOY: única DDL nueva = `config_ticket.leyenda_reimpresion text` (nullable ⇒
-- un nodo en 0052 que ingiere `config_ticket` sin la columna cae a NULL, sin
-- compat trigger). El resto son `CREATE OR REPLACE` de funciones. `0052`+`0053`
-- se despliegan juntos contra nube-`0049`.
-- =============================================================================


-- 1. Leyenda de reimpresión (N-4). `v_config_ticket_vigente` es `SELECT *`, así
--    que hay que recrearla para que adopte la columna nueva.
-- ---------------------------------------------------------------------------
ALTER TABLE core.config_ticket ADD COLUMN leyenda_reimpresion text;

COMMENT ON COLUMN core.config_ticket.leyenda_reimpresion IS
  'N-4. Texto al pie de un boleto reimpreso ("REIMPRESIÓN — ..."). NULL = sin leyenda.';

CREATE OR REPLACE VIEW core.v_config_ticket_vigente AS
SELECT DISTINCT ON (agencia_id) *
  FROM core.config_ticket
 WHERE activo
   AND effective_from <= now()
 ORDER BY agencia_id, effective_from DESC;


-- 2. `core.snapshot_boleto` — nombres desde `core.punto_ruta`; punto de ascenso.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.snapshot_boleto(p_boleto_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'boleto_id',        b.id,
    'folio',            b.folio,
    'pasajero',         b.pasajero_nombre,
    'asiento',          b.asiento_num,
    'tramos',           b.tramos::text,
    'importe',          b.importe,
    'saldo_pendiente',  vs.saldo_pendiente,
    'salida_id',        s.id,
    'fecha_operacion',  s.fecha_operacion,
    'conductor',        s.conductor_nombre_snapshot,
    'unidad',           un.numero_economico,
    'origen',           puo.nombre,
    'punto_ascenso',    puo.nombre,
    'origen_direccion', so.direccion_completa,
    'origen_telefono',  so.telefono_principal,
    'destino',          pud.nombre,
    'hora_salida',      spo.hora_paso_programada,
    'fecha_hora_viaje', to_char(spo.hora_paso_programada
                                AT TIME ZONE COALESCE(so.zona_horaria, puo.zona_horaria),
                                'YYYY-MM-DD HH24:MI'),
    'emitido_en',       to_char(b.creado_en
                                AT TIME ZONE COALESCE(so.zona_horaria, puo.zona_horaria),
                                'YYYY-MM-DD HH24:MI'),
    'sucursal_venta',   sv.nombre,
    'vendedor',         u.nombre,
    'es_reservacion',   v.es_reservacion
  )
  FROM core.boleto b
  JOIN core.venta v               ON v.id  = b.venta_id
  JOIN core.salida s              ON s.id  = b.salida_id
  JOIN core.sucursal sv           ON sv.id = v.sucursal_venta_id
  JOIN core.usuario u             ON u.id  = v.usuario_id
  LEFT JOIN core.unidad un        ON un.id = s.unidad_id
  LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = v.id
  JOIN core.salida_parada spo     ON spo.salida_id = s.id AND spo.orden = lower(b.tramos)
  JOIN core.punto_ruta puo        ON puo.id = spo.punto_id
  LEFT JOIN core.sucursal so      ON so.id = puo.sucursal_id
  JOIN core.salida_parada spd     ON spd.salida_id = s.id AND spd.orden = upper(b.tramos)
  JOIN core.punto_ruta pud        ON pud.id = spd.punto_id
  LEFT JOIN core.sucursal sd      ON sd.id = pud.sucursal_id
  WHERE b.id = p_boleto_id
$$;

COMMENT ON FUNCTION core.snapshot_boleto(uuid) IS
  'Datos congelados de un boleto para el ticket (print_job.datos). Nombres desde core.punto_ruta; punto de ascenso del pasajero (D7). Blueprint 02b §6 / 03 §2.4 / 05 §4.';


-- 3. `core.salidas_del_dia` — origen/destino desde `core.punto_ruta`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.salidas_del_dia(
  p_fecha       date,
  p_sucursal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  salida_id    uuid,
  horario_id   uuid,
  estado       text,
  hora_salida  timestamptz,
  origen       text,
  destino      text,
  conductor    text,
  boletos      integer
)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.horario_id, s.estado,
         spo.hora_paso_programada,
         puo.nombre,
         pud.nombre,
         s.conductor_nombre_snapshot,
         (SELECT count(*)::int FROM core.boleto b
           WHERE b.salida_id = s.id AND b.activo AND b.estado <> 'cancelado')
    FROM core.salida s
    JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = 0
    JOIN core.punto_ruta puo ON puo.id = spo.punto_id
    JOIN core.salida_parada spd ON spd.salida_id = s.id
     AND spd.orden = (SELECT max(orden) FROM core.salida_parada WHERE salida_id = s.id)
    JOIN core.punto_ruta pud ON pud.id = spd.punto_id
   WHERE s.activo
     AND s.fecha_operacion = p_fecha
     AND (p_sucursal_id IS NULL OR EXISTS (
       SELECT 1 FROM core.salida_parada sp
        JOIN core.punto_ruta pr ON pr.id = sp.punto_id
       WHERE sp.salida_id = s.id AND pr.sucursal_id = p_sucursal_id))
   ORDER BY spo.hora_paso_programada
$$;

COMMENT ON FUNCTION core.salidas_del_dia(date, uuid) IS
  'Listado de viajes del día para el módulo de viajes efectuados. Origen/destino desde core.punto_ruta. F7 · 05 §4.';


-- 4. `core.datos_manifiesto` — puntos en `paradas` / `ascensos`; estatus de pago
--    por pasajero (N-8). La forma agrupada por ascenso se mantiene (la "lista
--    única" de D11 es un sub-PR aparte).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.datos_manifiesto(
  p_salida_id uuid,
  p_copia     text        DEFAULT 'terminal',
  p_ahora     timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sal         record;
  v_es_terminal boolean := (p_copia = 'terminal');
  v_n_paradas   integer;
  v_paradas     jsonb;
  v_ascensos    jsonb;
  v_ocup        jsonb;
BEGIN
  IF p_copia NOT IN ('conductor', 'terminal') THEN
    RAISE EXCEPTION 'copia de manifiesto inválida: %', p_copia;
  END IF;

  SELECT s.id, s.fecha_operacion, s.conductor_nombre_snapshot, s.estado,
         u.numero_economico, tu.clave AS tipo_unidad
    INTO v_sal
    FROM core.salida s
    LEFT JOIN core.unidad u      ON u.id  = s.unidad_id
    JOIN core.tipo_unidad tu     ON tu.id = s.tipo_unidad_id
   WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  SELECT count(*)::int INTO v_n_paradas
    FROM core.salida_parada WHERE salida_id = p_salida_id;

  SELECT jsonb_agg(jsonb_build_object(
           'orden', sp.orden, 'punto', pr.nombre, 'tipo', pr.tipo,
           'hora_paso', sp.hora_paso_programada) ORDER BY sp.orden)
    INTO v_paradas
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id;

  SELECT jsonb_agg(a ORDER BY (a->>'parada_orden')::int)
    INTO v_ascensos
    FROM (
      SELECT jsonb_build_object(
        'parada_orden', spo.orden,
        'sucursal', puo.nombre,
        'pasajeros', COALESCE(jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'folio', b.folio,
            'asiento', b.asiento_num,
            'nombre', b.pasajero_nombre,
            'destino_orden', upper(b.tramos),
            'destino', pud.nombre,
            'conflicto', (b.estado = 'conflicto_sobreventa'),
            'estatus_pago', CASE WHEN COALESCE(vs.saldo_pendiente, 0) <= 0
                                 THEN 'pagado' ELSE 'pendiente' END,
            'importe', CASE WHEN v_es_terminal THEN b.importe END,
            'saldo_pendiente', CASE WHEN v_es_terminal THEN vs.saldo_pendiente END
          )) ORDER BY b.asiento_num
        ) FILTER (WHERE b.id IS NOT NULL), '[]'::jsonb)
      ) AS a
      FROM core.salida_parada spo
      JOIN core.punto_ruta puo ON puo.id = spo.punto_id
      LEFT JOIN core.boleto b
        ON b.salida_id = p_salida_id AND lower(b.tramos) = spo.orden
       AND b.activo AND b.estado <> 'cancelado'
      LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = b.venta_id
      LEFT JOIN core.salida_parada spd
        ON spd.salida_id = p_salida_id AND spd.orden = upper(b.tramos)
      LEFT JOIN core.punto_ruta pud ON pud.id = spd.punto_id
      WHERE spo.salida_id = p_salida_id
        AND spo.orden < v_n_paradas - 1
      GROUP BY spo.orden, puo.nombre
    ) q;

  IF v_es_terminal THEN
    SELECT jsonb_agg(jsonb_build_object(
             'tramo', format('[%s,%s)', g, g + 1),
             'vendidos', (SELECT count(*) FROM core.asiento_ocupacion o
                           WHERE o.salida_id = p_salida_id AND o.estado = 'firme'
                             AND o.tramos && int4range(g, g + 1))
           ) ORDER BY g)
      INTO v_ocup
      FROM generate_series(0, v_n_paradas - 2) g;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'salida_id',           v_sal.id,
    'copia',               p_copia,
    'fecha_operacion',     v_sal.fecha_operacion,
    'estado_salida',       v_sal.estado,
    'conductor',           v_sal.conductor_nombre_snapshot,
    'unidad',              v_sal.numero_economico,
    'tipo_unidad',         v_sal.tipo_unidad,
    'generado_en',         p_ahora,
    'paradas',             v_paradas,
    'ascensos',            COALESCE(v_ascensos, '[]'::jsonb),
    'ocupacion_por_tramo', v_ocup
  ));
END $$;

COMMENT ON FUNCTION core.datos_manifiesto(uuid, text, timestamptz) IS
  'Datos congelados de un manifiesto (copia conductor o terminal). Puntos desde core.punto_ruta; estatus de pago por pasajero (N-8). Blueprint 03 §2.5 / 05 §4.';


-- 5. `core.generar_manifiestos` — la sucursal de origen desde `core.punto_ruta`.
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
    SELECT COALESCE(sum(jsonb_array_length(asc_i->'pasajeros')), 0)::int
      INTO v_n
      FROM jsonb_array_elements(v_datos->'ascensos') asc_i;

    INSERT INTO core.print_job (id, sucursal_id, template_key, datos, estado, boleto_id)
    VALUES (core.uuid_v7(), v_sucursal_origen, 'manifiesto_' || v_copia, v_datos, 'pendiente', NULL)
    RETURNING id INTO v_id;

    copia := v_copia; print_job_id := v_id; pasajeros := v_n;
    RETURN NEXT;
  END LOOP;
END $$;

COMMENT ON FUNCTION core.generar_manifiestos(uuid, uuid, timestamptz) IS
  'Encola los dos print_job de manifiesto (conductor y terminal) de una salida. F7 · 05 §4.';


-- 6. `core.reimprimir_boleto` — reimpresión con el mismo snapshot que el original
--    (N-4). Incrementa `boleto.reimpresiones` y deja `nota_auditoria`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.reimprimir_boleto(
  p_boleto_id   uuid,
  p_usuario_id  uuid,
  p_sucursal_id uuid,            -- terminal que hace la reimpresión
  p_motivo      text        DEFAULT 'REIMPRESIÓN',
  p_ahora       timestamptz DEFAULT now()
)
RETURNS TABLE (print_job_id uuid, reimpresiones smallint)
LANGUAGE plpgsql AS $$
DECLARE
  v_b     core.boleto%ROWTYPE;
  v_saldo numeric;
  v_datos jsonb;
  v_pj_id uuid;
  v_reimp smallint;
BEGIN
  SELECT * INTO v_b FROM core.boleto WHERE id = p_boleto_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el boleto % no existe', p_boleto_id;
  END IF;
  IF v_b.estado = 'cancelado' THEN
    RAISE EXCEPTION 'el boleto % está cancelado: no se reimprime', p_boleto_id;
  END IF;

  SELECT COALESCE(vs.saldo_pendiente, 0) INTO v_saldo
    FROM core.boleto b LEFT JOIN core.v_venta_saldo vs ON vs.venta_id = b.venta_id
   WHERE b.id = p_boleto_id;
  IF v_saldo > 0 THEN
    RAISE EXCEPTION 'el boleto % tiene saldo pendiente (%): no se reimprime hasta liquidar',
      p_boleto_id, v_saldo;
  END IF;

  -- Mismo contenido que el original (N-4): el snapshot del print_job original;
  -- si nunca se imprimió, uno fresco.
  SELECT pj.datos INTO v_datos
    FROM core.print_job pj
   WHERE pj.boleto_id = p_boleto_id AND NOT pj.es_reimpresion AND pj.activo
   ORDER BY pj.creado_en LIMIT 1;
  IF v_datos IS NULL THEN
    v_datos := core.snapshot_boleto(p_boleto_id);
  END IF;

  INSERT INTO core.print_job (id, sucursal_id, template_key, datos, estado,
                              es_reimpresion, motivo_reimpresion, boleto_id)
  VALUES (core.uuid_v7(), p_sucursal_id, 'boleto', v_datos, 'pendiente',
          true, p_motivo, p_boleto_id)
  RETURNING id INTO v_pj_id;

  -- Alias `bo`: el OUT param `reimpresiones` haría ambigua la columna sin calificar.
  UPDATE core.boleto AS bo SET reimpresiones = bo.reimpresiones + 1
   WHERE bo.id = p_boleto_id
  RETURNING bo.reimpresiones INTO v_reimp;

  INSERT INTO core.nota_auditoria (id, entidad, entidad_id, tipo, detalle,
                                   usuario_id, sucursal_id, ocurrido_en)
  VALUES (core.uuid_v7(), 'core.boleto', p_boleto_id, 'reimpresion',
          jsonb_build_object('motivo', p_motivo, 'print_job_id', v_pj_id),
          p_usuario_id, p_sucursal_id, p_ahora);

  print_job_id := v_pj_id; reimpresiones := v_reimp;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.reimprimir_boleto(uuid, uuid, uuid, text, timestamptz) IS
  'Encola una reimpresión de boleto (mismo snapshot que el original + leyenda de reimpresión, N-4). Incrementa boleto.reimpresiones y deja nota_auditoria. 05 §4.';
