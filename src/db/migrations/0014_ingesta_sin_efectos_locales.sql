-- =============================================================================
-- 0014 · La ingesta de filas replicadas deja de comportarse como escritura local.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §2.2, §3.1 y §4
--
-- CAUSA RAÍZ DE SEIS DEFECTOS ENCONTRADOS EN LAS PRUEBAS DE CAOS DE F1.
--
-- `core.trg_columnas_estandar` y `sync.trg_outbox` son triggers BEFORE/AFTER
-- aplicados a toda tabla de `core`. Se escribieron para el caso "un usuario de
-- esta terminal crea o modifica una fila", y hacen lo correcto ahí: sellan el
-- reloj híbrido local, marcan la sucursal dueña, suben la versión y encolan la
-- fila para subirla.
--
-- Pero corren TAMBIÉN cuando `sync.ingest_fila` aplica una fila que viene de
-- otra réplica, y ahí cada una de esas acciones es exactamente la equivocada:
--
--  1. Se pisa `hlc_ts`/`hlc_cnt` del ORIGEN con el reloj de quien recibe. El
--     blueprint §2.2 exige que el HLC dé "un orden total determinista que todas
--     las réplicas calculan igual"; eso requiere conservarlo, y se perdía justo
--     en el momento en que empezaba a servir.
--
--  2. En consecuencia, la guarda `WHERE (EXCLUDED.hlc_ts, EXCLUDED.hlc_cnt) >
--     (almacenado)` quedaba INERTE. `EXCLUDED` refleja la fila después de los
--     triggers BEFORE, así que su HLC siempre era mayor y la condición se
--     cumplía siempre. El resultado real era "gana el último en llegar a la
--     nube" — precisamente lo que 01b §6 prohíbe, porque premia a la sucursal
--     con mejor internet y castiga a la que el sistema promete proteger.
--
--  3. Un ACK perdido hacía que el reenvío de un payload VIEJO pisara la versión
--     nueva, rompiendo el checksum sin que nadie lo notara.
--
--  4. `version` se recalculaba como OLD.version + 1 en vez de traerse del
--     origen, así que las dos réplicas divergían en el número de versión.
--
--  5. `sync_sucursal_id` se reescribía con la sucursal que recibe: la
--     configuración bajada de la nube quedaba marcada como propiedad del nodo.
--
--  6. `trg_outbox` reencolaba hacia ARRIBA la configuración que acababa de
--     bajar. Peor: ese eco se realimentaba, y pull y push se respondían entre
--     sí sin converger nunca.
--
-- SOLUCIÓN: una bandera de ámbito transaccional que ambos triggers respetan.
-- Se prefiere a `session_replication_role = 'replica'` porque esa requiere
-- superusuario, y el rol de Supabase no lo es. Además es explícita: quien lea
-- el trigger ve la condición en vez de depender de un ajuste de sesión invisible.
-- =============================================================================


-- ¿Estamos aplicando una fila que viene de otra réplica?
CREATE OR REPLACE FUNCTION sync.replicando() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('donaji.replicando', true), 'off') = 'on';
$$;

COMMENT ON FUNCTION sync.replicando() IS
  'true mientras sync.ingest_fila aplica una fila replicada. Blueprint §3.1.';


-- -----------------------------------------------------------------------------
-- Columnas estándar: no tocar nada cuando la fila viene de otra réplica.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.trg_columnas_estandar() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_ts timestamptz; v_cnt integer;
BEGIN
  -- Una fila replicada ya trae su reloj, su versión y su dueño, puestos por la
  -- réplica que la originó. Reescribirlos aquí destruiría el orden causal que
  -- es la única base para decidir quién gana un conflicto.
  IF sync.replicando() THEN
    RETURN NEW;
  END IF;

  SELECT o_ts, o_cnt INTO v_ts, v_cnt FROM sync.hlc_siguiente();

  IF TG_OP = 'INSERT' THEN
    NEW.creado_en     := COALESCE(NEW.creado_en, now());
    NEW.modificado_en := NEW.creado_en;
    NEW.version       := 1;
    NEW.sync_sucursal_id := COALESCE(NEW.sync_sucursal_id, sync.sucursal_local());
  ELSE
    NEW.modificado_en := now();
    NEW.version       := OLD.version + 1;
    NEW.creado_en     := OLD.creado_en;
    NEW.sync_sucursal_id := OLD.sync_sucursal_id;
    IF OLD.activo AND NOT NEW.activo THEN
      NEW.desactivado_en := COALESCE(NEW.desactivado_en, now());
    END IF;
  END IF;

  NEW.hlc_ts  := v_ts;
  NEW.hlc_cnt := v_cnt;
  RETURN NEW;
END $$;


-- -----------------------------------------------------------------------------
-- Outbox: lo replicado NO se reencola.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.trg_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- La nube no genera outbox: es el destino, no un origen.
  IF (SELECT es_nube FROM sync.nodo WHERE singleton) THEN RETURN NEW; END IF;

  -- Lo que acaba de BAJAR no vuelve a SUBIR. Sin esto, el nodo devuelve a la nube
  -- la configuración que la nube le mandó, la nube la vuelve a publicar, y el ciclo
  -- se realimenta indefinidamente consumiendo el enlace que la sucursal necesita
  -- para subir sus ventas.
  IF sync.replicando() THEN RETURN NEW; END IF;

  INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, NEW.id, to_jsonb(NEW),
          NEW.hlc_ts, NEW.hlc_cnt);
  RETURN NEW;
END $$;


-- -----------------------------------------------------------------------------
-- Publicación hacia los nodos: tampoco reemite lo replicado.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.trg_cambio_log() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (SELECT es_nube FROM sync.nodo WHERE singleton) THEN RETURN NEW; END IF;

  -- Una fila que la nube recibió de una sucursal no debe volver a publicarse como
  -- si fuera un cambio de configuración del administrador.
  IF sync.replicando() THEN RETURN NEW; END IF;

  INSERT INTO sync.cambio_log (tabla, fila_id, payload)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, NEW.id, to_jsonb(NEW));
  RETURN NEW;
END $$;


-- -----------------------------------------------------------------------------
-- ingest_fila levanta la bandera mientras aplica.
-- -----------------------------------------------------------------------------
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

  v_sql := format($f$
    INSERT INTO %1$s (%2$s)
    SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, $1)
    ON CONFLICT (id) DO UPDATE SET %3$s
     WHERE (EXCLUDED.hlc_ts, EXCLUDED.hlc_cnt) > (%1$s.hlc_ts, %1$s.hlc_cnt)
  $f$, p_tabla, v_cols, v_sets);

  -- Se guarda el valor previo en vez de asumir 'off': `ingest_fila` puede llamarse
  -- desde el bootstrap, que ya está dentro de un bloque replicando.
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


-- -----------------------------------------------------------------------------
-- El "día operativo" del checksum deja de depender de la zona horaria de la sesión.
-- -----------------------------------------------------------------------------
-- `creado_en >= p_dia::date` compara un timestamptz contra una date, y esa
-- conversión usa el `TimeZone` de la SESIÓN. El nodo (America/Mexico_City) y
-- Supabase (UTC) partían el día en instantes distintos, así que las filas de las
-- últimas horas caían en bloques distintos y el checksum divergía sin que se
-- hubiera perdido un solo dato. Una alarma falsa en la herramienta que existe
-- para detectar pérdidas reales es peor que no tenerla: enseña a ignorarla.
--
-- Se fija UTC de forma explícita en los dos lados. Que el día operativo deba ser
-- el local de cada sucursal es una decisión aparte, ligada a P12 (zonas horarias),
-- y cuando se tome debe aplicarse aquí una sola vez.
CREATE OR REPLACE FUNCTION sync.calcular_checksum(
  p_tabla regclass, p_sucursal_id uuid, p_dia date)
RETURNS TABLE (filas integer, hash text)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE format($f$
    SELECT count(*)::integer,
           md5(coalesce(string_agg(id::text || ':' || version::text, '|'
                                   ORDER BY id), ''))
      FROM %1$s
     WHERE sync_sucursal_id = %2$L
       AND (creado_en AT TIME ZONE 'UTC')::date = %3$L::date
  $f$, p_tabla, p_sucursal_id, p_dia);
END $$;

COMMENT ON FUNCTION sync.calcular_checksum(regclass, uuid, date) IS
  'Checksum de un bloque día/tabla/sucursal. El día se corta en UTC en ambos lados. Blueprint §6.1.';
