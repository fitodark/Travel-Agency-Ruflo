-- =============================================================================
-- 0041 · El sello del reloj híbrido deja de ser un candado global y deja de
--        quedarse adelantado para siempre; y el nodo por fin avanza su reloj al
--        máximo observado en un lote remoto.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §2.2
--
-- Cierra tres defectos entrelazados (docs/historial.md · "Defectos conocidos"):
--
--  D2 · `sync.hlc_siguiente()` hacía `UPDATE sync.hlc_estado ... WHERE singleton`
--       en CADA INSERT/UPDATE de toda tabla de `core` (vía
--       `core.trg_columnas_estandar`). Una fila única, un lock por transacción:
--       cualquier transacción abierta que tocara `core` bloqueaba TODA otra
--       escritura de la base, aunque fuera de otra tabla y otra fila. En la nube,
--       mientras una sucursal drenaba 72 h de outbox, las otras tres esperaban.
--
--  D3 · `ultimo_ts = GREATEST(ultimo_ts, clock_timestamp())` es un trinquete:
--       sube y no baja. Un arranque con la BIOS corrida una hora dejaba el HLC
--       una hora adelantado PARA SIEMPRE, aunque NTP corrigiera el reloj del SO.
--       Ese nodo ganaba toda comparación por HLC de forma permanente y sin señal.
--
--  D1 · `sync.hlc_observar()` existe desde 0001 y no la llamaba nadie: el reloj
--       local nunca saltaba al máximo observado en un pull, así que el HLC no era
--       un reloj híbrido sino un reloj de pared con otro nombre.
--
-- DISEÑO CONJUNTO (los tres se tocan y no admiten parches sueltos):
--
--   * `sync.hlc_estado.ultimo_ts` pasa a ser un PISO OBSERVADO: el máximo `hlc_ts`
--     que este nodo ha visto de cualquier origen. NADA lo escribe en el camino de
--     una escritura normal.
--   * El contador sale de una SECUENCIA (`sync.hlc_seq`): `nextval` no toma lock
--     ni sufre contención por rollback. El orden total sigue siendo
--     `(hlc_ts, hlc_cnt, origen)`, determinista y calculado igual por cada réplica
--     porque los tres campos viajan intactos en la replicación (0014).
--   * `hlc_siguiente()` solo LEE el piso (sin lock) y ACOTA el sello: nunca más de
--     `hlc_deriva_max_seg` por delante del piso ni del reloj de pared. Cuando NTP
--     corrige, el sello vuelve solo a la hora real (es `LEAST(wall, ...)`).
--   * `hlc_observar()` sube el piso hacia el máximo remoto, PERO acotado a
--     `clock_timestamp() + hlc_deriva_max_seg`: un remoto con el reloj disparado
--     no envenena el piso, y un piso ya envenenado se sana en la siguiente
--     observación.
--   * `hlc_observar()` se cablea en `sync.ingest_fila`, que es el único camino de
--     escritura replicada en los dos lados (pull del nodo y push a la nube).
--
-- CAMBIO DE SEMÁNTICA (documentado también en 01-sincronizacion.md §2.2):
-- `hlc_cnt` deja de ser "eventos desde que avanzó el ts" y pasa a ser una
-- secuencia global monótona. `sync.calcular_checksum` (hashea `id || version`) y
-- la guarda `(EXCLUDED.hlc_ts, EXCLUDED.hlc_cnt) > (almacenado)` no se ven
-- afectadas; `src/sync/arbitraje.ts` ya usa `origen` como desempate final.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Parámetro de deriva máxima del sello (R5 / D-3).
-- -----------------------------------------------------------------------------
-- Concepto distinto del umbral de modo degradado (`deriva_reloj_degradado_seg`,
-- que decide si se puede vender cerca de la frontera de expiración de cupos).
-- Este acota el SELLO, para que una excursión no contamine el orden causal.
INSERT INTO core.parametro (clave, valor, descripcion) VALUES
  ('hlc_deriva_max_seg', '300',
   'D-3 / R5. Tope de deriva del sello HLC. hlc_siguiente() nunca pone un hlc_ts '
   'más de este margen por delante del piso observado ni del reloj de pared; '
   'hlc_observar() no deja que un lote remoto empuje el piso más allá de '
   'clock_timestamp() + este margen. Cuando el clamp actúa se abre una excepción '
   'deriva_reloj. NTP corrige el reloj del SO; esto corrige el HLC.')
ON CONFLICT (clave) DO NOTHING;

CREATE OR REPLACE FUNCTION sync.hlc_deriva_max() RETURNS interval
LANGUAGE sql VOLATILE AS $$
  SELECT make_interval(secs => coalesce(
    (SELECT (valor)::text::numeric
       FROM core.parametro
      WHERE clave = 'hlc_deriva_max_seg' AND activo AND effective_from <= clock_timestamp()
      ORDER BY effective_from DESC
      LIMIT 1),
    300));
$$;


-- -----------------------------------------------------------------------------
-- 2. Secuencia del contador. Cicla en INT_MAX (el OUT de hlc_siguiente es
--    integer); una colisión de contador tras un ciclo es inofensiva porque el
--    hlc_ts ya difiere y `origen` desempata.
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS sync.hlc_seq
  AS integer MINVALUE 0 MAXVALUE 2147483647 CYCLE;

-- El rol acotado de la consola llama a hlc_siguiente() por los triggers de una
-- escritura de configuración (ver 0037).
GRANT USAGE ON SEQUENCE sync.hlc_seq TO donaji_consola;


-- -----------------------------------------------------------------------------
-- 3. Un piso que arranca en '-infinity' es equivalente a "sin piso" en el nuevo
--    esquema (hlc_siguiente cae al reloj de pared), pero se normaliza para que el
--    tablero y las pruebas lean un valor con sentido.
-- -----------------------------------------------------------------------------
ALTER TABLE sync.hlc_estado ALTER COLUMN ultimo_ts SET DEFAULT clock_timestamp();
UPDATE sync.hlc_estado SET ultimo_ts = clock_timestamp() WHERE singleton AND ultimo_ts = '-infinity';


-- -----------------------------------------------------------------------------
-- 4. Excepción de deriva del reloj, deduplicada. Solo en un nodo: en la nube
--    `sync.sucursal_local()` es NULL y `sync.excepcion.sucursal_id` es NOT NULL.
--    Misma forma que `src/sync/salud.ts` registrarDeriva().
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.registrar_deriva_reloj(p_seg numeric, p_clase text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_sucursal uuid := sync.sucursal_local();
BEGIN
  IF v_sucursal IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM sync.excepcion
     WHERE tipo = 'deriva_reloj' AND estado = 'abierta' AND sucursal_id = v_sucursal
  ) THEN
    RETURN;
  END IF;
  INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, detalle)
  VALUES ('deriva_reloj', 'alta', v_sucursal,
          jsonb_build_object('deriva_seg', round(p_seg, 1), 'clase', p_clase));
END $$;


-- -----------------------------------------------------------------------------
-- 5. hlc_siguiente: lee el piso (sin lock), acota el sello, contador de secuencia.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.hlc_siguiente(OUT o_ts timestamptz, OUT o_cnt integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_wall     timestamptz := clock_timestamp();
  v_piso     timestamptz;
  v_max      interval    := sync.hlc_deriva_max();
  v_piso_cap timestamptz;
BEGIN
  -- SELECT plano: lectura MVCC, sin lock. Aquí estaba el candado global (D2).
  SELECT ultimo_ts INTO v_piso FROM sync.hlc_estado WHERE singleton;

  -- El piso nunca arrastra el sello más de v_max por delante del reloj de pared:
  -- un piso envenenado (D3) o una excursión quedan acotados en la LECTURA.
  v_piso_cap := LEAST(v_piso, v_wall + v_max);

  -- Normalmente o_ts = v_wall. Si hay un piso observado por delante (skew real de
  -- otra réplica), se sigue hasta v_wall + v_max. Nunca por debajo del piso.
  o_ts  := GREATEST(v_wall, v_piso_cap);
  o_cnt := nextval('sync.hlc_seq')::integer;

  IF v_piso > v_wall + v_max THEN
    PERFORM sync.registrar_deriva_reloj(
      extract(epoch FROM (v_piso - v_wall))::numeric, 'piso_adelantado');
  END IF;
END $$;

COMMENT ON FUNCTION sync.hlc_siguiente() IS
  'Sello HLC del siguiente evento local. 0041: sin lock sobre sync.hlc_estado '
  '(solo lo lee), acotado a hlc_deriva_max_seg, contador de sync.hlc_seq.';


-- -----------------------------------------------------------------------------
-- 6. hlc_observar: sube el piso hacia el máximo remoto, acotado; sana un piso
--    envenenado; el UPDATE es no-op (sin lock) cuando el piso no cambia.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.hlc_observar(p_ts timestamptz, p_cnt integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_wall  timestamptz := clock_timestamp();
  v_max   interval     := sync.hlc_deriva_max();
  v_tope  timestamptz;
  v_nuevo timestamptz;
BEGIN
  v_tope  := v_wall + v_max;
  v_nuevo := LEAST(GREATEST((SELECT ultimo_ts FROM sync.hlc_estado WHERE singleton), p_ts), v_tope);

  -- `<>` y no `<`: además de subir hacia el máximo remoto, BAJA un piso que
  -- quedó por encima del tope (D3 se sana). Un piso que no cambia = 0 filas = sin
  -- lock, que es lo que mantiene barato llamar a esto por cada fila del pull.
  UPDATE sync.hlc_estado
     SET ultimo_ts  = v_nuevo,
         ultimo_cnt = GREATEST(ultimo_cnt, p_cnt)
   WHERE singleton AND ultimo_ts <> v_nuevo;

  IF p_ts > v_tope THEN
    PERFORM sync.registrar_deriva_reloj(
      extract(epoch FROM (p_ts - v_wall))::numeric, 'remoto_adelantado');
  END IF;
END $$;

COMMENT ON FUNCTION sync.hlc_observar(timestamptz, integer) IS
  'Avanza el piso HLC del nodo hacia el máximo observado en un lote remoto, '
  'acotado a clock_timestamp() + hlc_deriva_max_seg. Blueprint §2.2. Cableada '
  'en sync.ingest_fila desde 0041.';


-- -----------------------------------------------------------------------------
-- 7. ingest_fila: cablea hlc_observar. Parte de la versión de 0031 (filtro
--    is_generated + envoltura donaji.replicando); lo único que se añade es la
--    llamada a hlc_observar tras procesar la fila.
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

  -- D1: el nodo (y la nube) avanzan su piso HLC al máximo observado. Se hace
  -- también cuando la fila se ignoró por HLC (el valor se vio igual) y no cuando
  -- salió por excepción (no se aplicó nada). Cableado que faltaba desde 0001.
  IF estado IN ('aceptada', 'ignorada_hlc')
     AND (p_payload ? 'hlc_ts') AND (p_payload ? 'hlc_cnt')
     AND (p_payload->>'hlc_ts') IS NOT NULL THEN
    PERFORM sync.hlc_observar(
      (p_payload->>'hlc_ts')::timestamptz,
      coalesce((p_payload->>'hlc_cnt')::integer, 0));
  END IF;
END $$;
