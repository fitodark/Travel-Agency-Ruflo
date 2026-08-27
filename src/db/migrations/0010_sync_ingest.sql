-- =============================================================================
-- 0010 · Ingesta idempotente de lotes (push sucursal -> nube).
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.1
--
-- Esta es la pieza que convierte "at-least-once" en "efectivamente-una-vez":
-- el nodo reenvía sin miedo porque la nube absorbe los duplicados.
--
-- Se aplica en LAS DOS bases aunque solo la nube la ejecute. Mantener un único
-- juego de migraciones es lo que permite que un nodo pueda promoverse a nube en
-- una recuperación, y evita el "funciona en local y no en la nube".
-- =============================================================================


-- Lista blanca de tablas ingeribles, derivada del catálogo y no de una lista a mano.
--
-- Una tabla es ingerible si vive en `core` y tiene las cuatro columnas de sync. Se
-- deriva en vez de enumerarse porque el SQL dinámico de abajo interpola el nombre de
-- tabla: una lista escrita a mano se desactualiza y se vuelve un hueco de inyección
-- el día que alguien agrega una tabla y la ingesta la acepta sin pensar.
CREATE OR REPLACE FUNCTION sync.es_tabla_ingerible(p_tabla text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT count(*) = 4
    FROM information_schema.columns c
   WHERE c.table_schema = split_part(p_tabla, '.', 1)
     AND c.table_name   = split_part(p_tabla, '.', 2)
     AND c.table_schema = 'core'
     AND c.column_name IN ('sync_sucursal_id', 'hlc_ts', 'hlc_cnt', 'version');
$$;


-- Aplica UNA fila. Devuelve 'aceptada' | 'ignorada_hlc' | 'conflicto' | 'rechazada'.
--
-- `ignorada_hlc` no es un error: es el reenvío de una versión vieja llegando después
-- de una nueva. Ocurre de forma rutinaria cuando un ACK se pierde y el nodo reintenta.
CREATE OR REPLACE FUNCTION sync.ingest_fila(
  p_tabla   text,
  p_fila_id uuid,
  p_payload jsonb,
  OUT estado text,
  OUT motivo text
) LANGUAGE plpgsql AS $$
DECLARE
  v_cols     text;
  v_sets     text;
  v_sql      text;
  v_afectadas integer;
BEGIN
  IF NOT sync.es_tabla_ingerible(p_tabla) THEN
    estado := 'rechazada';
    motivo := format('tabla no ingerible: %s', p_tabla);
    RETURN;
  END IF;

  -- Solo las claves del payload que existen realmente como columnas. Un nodo en
  -- versión N+1 puede mandar columnas que esta nube todavía no tiene (D-8: conviven
  -- N y N-1 durante días); esas se ignoran en vez de tumbar el lote entero.
  SELECT string_agg(quote_ident(k), ', '),
         string_agg(format('%I = EXCLUDED.%I', k, k), ', ')
    INTO v_cols, v_sets
    FROM jsonb_object_keys(p_payload) AS k
   WHERE EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = split_part(p_tabla, '.', 1)
        AND c.table_name   = split_part(p_tabla, '.', 2)
        AND c.column_name  = k
   );

  IF v_cols IS NULL THEN
    estado := 'rechazada';
    motivo := 'el payload no trae ninguna columna conocida';
    RETURN;
  END IF;

  -- El WHERE del DO UPDATE es el corazón de la protección contra reenvíos viejos:
  -- una fila solo avanza si su reloj híbrido es estrictamente mayor que el guardado.
  v_sql := format($f$
    INSERT INTO %1$s (%2$s)
    SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, $1)
    ON CONFLICT (id) DO UPDATE SET %3$s
     WHERE (EXCLUDED.hlc_ts, EXCLUDED.hlc_cnt) > (%1$s.hlc_ts, %1$s.hlc_cnt)
  $f$, p_tabla, v_cols, v_sets);

  BEGIN
    EXECUTE v_sql USING p_payload;
    GET DIAGNOSTICS v_afectadas = ROW_COUNT;
    estado := CASE WHEN v_afectadas > 0 THEN 'aceptada' ELSE 'ignorada_hlc' END;

  EXCEPTION
    WHEN exclusion_violation THEN
      -- Clase D: dos sucursales vendieron el mismo asiento en tramos traslapados.
      -- NO se pierde ni se sobrescribe: se marca conflicto y lo arbitra el proceso
      -- de reconciliación, que aplica una prioridad determinista (S2 del blueprint).
      estado := 'conflicto';
      motivo := 'traslape de asiento (exclusion_violation)';
    WHEN unique_violation THEN
      estado := 'conflicto';
      motivo := format('violación de unicidad: %s', SQLERRM);
    WHEN foreign_key_violation THEN
      -- La fila padre aún no llegó. Es recuperable: el nodo reintenta el lote y el
      -- orden por `seq` normalmente ya trae al padre antes que al hijo.
      estado := 'rechazada';
      motivo := format('falta la fila referenciada: %s', SQLERRM);
    WHEN OTHERS THEN
      estado := 'rechazada';
      motivo := format('%s: %s', SQLSTATE, SQLERRM);
  END;
END $$;


-- Ingesta de un lote completo.
--
-- Contrato de entrada:
--   { lote_id, sucursal_id, version_nodo, filas: [{seq, tabla, fila_id, payload}, ...] }
-- Contrato de salida:
--   { lote_id, idempotente, aceptadas, ignoradas, conflictos, rechazadas,
--     filas: [{seq, fila_id, estado, motivo}, ...] }
CREATE OR REPLACE FUNCTION sync.ingest_batch(p_lote jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_lote_id     uuid := (p_lote->>'lote_id')::uuid;
  v_sucursal_id uuid := (p_lote->>'sucursal_id')::uuid;
  v_version     text := p_lote->>'version_nodo';
  v_fila        jsonb;
  v_res         record;
  v_detalle     jsonb := '[]'::jsonb;
  v_ack         jsonb;
  v_previo      jsonb;
  v_aceptadas   integer := 0;
  v_ignoradas   integer := 0;
  v_conflictos  integer := 0;
  v_rechazadas  integer := 0;
BEGIN
  IF v_lote_id IS NULL OR v_sucursal_id IS NULL THEN
    RAISE EXCEPTION 'lote inválido: falta lote_id o sucursal_id';
  END IF;

  -- Idempotencia: si este lote ya se procesó, se devuelve EL MISMO ACK sin volver a
  -- aplicar nada. Sin esto, un ACK perdido en una red intermitente —que es el caso
  -- normal aquí, no el excepcional— duplicaría boletos en cada reintento.
  SELECT ack INTO v_previo FROM sync.lote_recibido WHERE lote_id = v_lote_id;
  IF FOUND THEN
    RETURN jsonb_set(v_previo, '{idempotente}', 'true'::jsonb);
  END IF;

  -- El orden por `seq` preserva la causalidad dentro de la sucursal: el corte de caja
  -- entra antes que sus movimientos, la venta antes que sus boletos.
  FOR v_fila IN
    SELECT value FROM jsonb_array_elements(coalesce(p_lote->'filas', '[]'::jsonb))
     ORDER BY (value->>'seq')::bigint
  LOOP
    SELECT * INTO v_res
      FROM sync.ingest_fila(
        v_fila->>'tabla',
        (v_fila->>'fila_id')::uuid,
        v_fila->'payload'
      );

    v_detalle := v_detalle || jsonb_build_object(
      'seq',     (v_fila->>'seq')::bigint,
      'fila_id', v_fila->>'fila_id',
      'estado',  v_res.estado,
      'motivo',  v_res.motivo
    );

    CASE v_res.estado
      WHEN 'aceptada'     THEN v_aceptadas  := v_aceptadas + 1;
      WHEN 'ignorada_hlc' THEN v_ignoradas  := v_ignoradas + 1;
      WHEN 'conflicto'    THEN v_conflictos := v_conflictos + 1;
      ELSE                     v_rechazadas := v_rechazadas + 1;
    END CASE;

    -- Conflictos y rechazos van a la cola de excepciones: se ven en la caja de la
    -- sucursal y en el tablero del administrador. Una fila perdida en un log es una
    -- fila perdida, con las sucursales a 3-6 h de distancia.
    IF v_res.estado IN ('conflicto', 'rechazada') THEN
      INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, entidad_id, detalle)
      VALUES (
        CASE WHEN v_res.estado = 'conflicto' THEN 'sobreventa' ELSE 'rechazo_ingesta' END,
        CASE WHEN v_res.estado = 'conflicto' THEN 'critica'    ELSE 'alta' END,
        v_sucursal_id,
        v_fila->>'tabla',
        (v_fila->>'fila_id')::uuid,
        jsonb_build_object('motivo', v_res.motivo, 'lote_id', v_lote_id)
      );
    END IF;
  END LOOP;

  v_ack := jsonb_build_object(
    'lote_id',     v_lote_id,
    'idempotente', false,
    'aceptadas',   v_aceptadas,
    'ignoradas',   v_ignoradas,
    'conflictos',  v_conflictos,
    'rechazadas',  v_rechazadas,
    'filas',       v_detalle
  );

  INSERT INTO sync.lote_recibido (lote_id, sucursal_id, version_nodo, filas, ack)
  VALUES (v_lote_id, v_sucursal_id, v_version, jsonb_array_length(v_detalle), v_ack);

  RETURN v_ack;
END $$;


COMMENT ON FUNCTION sync.ingest_batch(jsonb) IS
  'Ingesta idempotente de un lote del outbox de una sucursal. Blueprint §3.1.';
