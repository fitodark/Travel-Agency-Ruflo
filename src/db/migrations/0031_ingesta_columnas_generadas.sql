-- =============================================================================
-- 0031 · La ingesta no debe intentar escribir columnas GENERADAS.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.1
--
-- DEFECTO: `sync.ingest_fila` armaba la lista de columnas a insertar a partir de
-- las claves del payload que existen en `information_schema.columns`, sin excluir
-- las columnas `GENERATED ALWAYS AS ... STORED`. El trigger de outbox manda la
-- fila completa (`to_jsonb(NEW)`), que incluye esas columnas, así que la ingesta
-- generaba:
--
--   INSERT INTO core.cliente (..., telefono_normalizado, ...) SELECT ...
--   -> ERROR 428C9: cannot insert a non-DEFAULT value into column
--                   "telefono_normalizado"
--
-- Resultado: NINGÚN `core.cliente` podía replicar a la nube; la fila quedaba
-- `rechazada` en el outbox para siempre.
--
-- Corrección: filtrar `is_generated = 'NEVER'`. La nube recalcula la columna
-- generada sola desde las columnas base.
--
-- Esta definición PARTE de la de 0014 (que envuelve la aplicación en el bloque
-- `donaji.replicando` para que los triggers estándar no toquen la fila
-- replicada). Lo único que cambia respecto de 0014 es el filtro de columnas.
-- =============================================================================

CREATE OR REPLACE FUNCTION sync.ingest_fila(
  p_tabla   text,
  p_fila_id uuid,
  p_payload jsonb,
  OUT estado text,
  OUT motivo text
) LANGUAGE plpgsql AS $$
DECLARE
  v_cols      text;
  v_sets      text;
  v_sql       text;
  v_afectadas integer;
  v_previo    text;
BEGIN
  IF NOT sync.es_tabla_ingerible(p_tabla) THEN
    estado := 'rechazada';
    motivo := format('tabla no ingerible: %s', p_tabla);
    RETURN;
  END IF;

  -- Solo las claves del payload que existen como columnas REALES y ESCRIBIBLES.
  -- Un nodo en versión N+1 puede mandar columnas que esta nube no tiene (D-8):
  -- se ignoran. Y las columnas GENERATED ALWAYS no se pueden escribir: la nube
  -- las recalcula sola desde las columnas base.
  SELECT string_agg(quote_ident(k), ', '),
         string_agg(format('%I = EXCLUDED.%I', k, k), ', ')
    INTO v_cols, v_sets
    FROM jsonb_object_keys(p_payload) AS k
   WHERE EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = split_part(p_tabla, '.', 1)
        AND c.table_name   = split_part(p_tabla, '.', 2)
        AND c.column_name  = k
        AND c.is_generated = 'NEVER'
   );

  IF v_cols IS NULL THEN
    estado := 'rechazada';
    motivo := 'el payload no trae ninguna columna conocida';
    RETURN;
  END IF;

  v_sql := format($f$
    INSERT INTO %1$s (%2$s)
    SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, $1)
    ON CONFLICT (id) DO UPDATE SET %3$s
     WHERE (EXCLUDED.hlc_ts, EXCLUDED.hlc_cnt) > (%1$s.hlc_ts, %1$s.hlc_cnt)
  $f$, p_tabla, v_cols, v_sets);

  -- Se guarda el valor previo en vez de asumir 'off': `ingest_fila` puede
  -- llamarse desde el bootstrap, que ya está dentro de un bloque replicando.
  v_previo := coalesce(current_setting('donaji.replicando', true), 'off');
  PERFORM set_config('donaji.replicando', 'on', true);

  BEGIN
    EXECUTE v_sql USING p_payload;
    GET DIAGNOSTICS v_afectadas = ROW_COUNT;
    estado := CASE WHEN v_afectadas > 0 THEN 'aceptada' ELSE 'ignorada_hlc' END;

  EXCEPTION
    WHEN exclusion_violation THEN
      estado := 'conflicto';
      motivo := 'traslape de asiento (exclusion_violation)';
    WHEN unique_violation THEN
      estado := 'conflicto';
      motivo := format('violación de unicidad: %s', SQLERRM);
    WHEN foreign_key_violation THEN
      estado := 'rechazada';
      motivo := format('falta la fila referenciada: %s', SQLERRM);
    WHEN OTHERS THEN
      estado := 'rechazada';
      motivo := format('%s: %s', SQLSTATE, SQLERRM);
  END;

  PERFORM set_config('donaji.replicando', v_previo, true);
END $$;


-- Reencolar los `core.cliente` que quedaron `rechazado` por este defecto.
UPDATE sync.outbox
   SET estado = 'pendiente', ultimo_error = NULL
 WHERE tabla = 'core.cliente'
   AND estado = 'rechazado'
   AND ultimo_error LIKE '%telefono_normalizado%';
