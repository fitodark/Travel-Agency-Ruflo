-- =============================================================================
-- 0032 · El outbox NO debe subir tablas de configuración (clase A).
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.2
--
-- La configuración (sucursal, usuario, tipo_unidad, tarifa, salida, …) es
-- AUTORITATIVA EN LA NUBE: baja a los nodos por `trg_cambio_log` y el nodo nunca
-- la escribe en operación normal. Pero un seed de desarrollo (p. ej.
-- `seed:admin`, o el seed de la Sprinter-18) SÍ la escribe localmente, y el
-- trigger de outbox la encolaba hacia arriba. Al hacer push chocaba con la
-- versión de la nube:
--
--   push: 0 aceptadas, 1 conflictos   (tipo_unidad_clave_key)
--
-- ...en CADA ciclo, para siempre, porque `push` reintenta lo no confirmado.
--
-- Corrección: `trg_outbox` salta las tablas que tienen `trg_cambio_log` (es
-- decir, las de clase A). Y se marcan como `confirmado` las filas de esas tablas
-- que ya están en el outbox: no hay nada que subir.
-- =============================================================================

-- Una tabla es de configuración si `sync.publicar_a_nodos` le puso el trigger
-- de publicación hacia los nodos.
CREATE OR REPLACE FUNCTION sync.es_tabla_config(p_tabla text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = p_tabla::regclass
       AND tgname = 'trg_cambio_log'
       AND NOT tgisinternal
  );
$$;

COMMENT ON FUNCTION sync.es_tabla_config(text) IS
  'true si la tabla es clase A (nube-autoritativa): baja por trg_cambio_log, no sube.';


CREATE OR REPLACE FUNCTION sync.trg_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- La nube no genera outbox: es el destino, no un origen.
  IF (SELECT es_nube FROM sync.nodo WHERE singleton) THEN RETURN NEW; END IF;

  -- La configuración es autoritativa en la nube y solo BAJA. Un nodo que la
  -- escribe (un seed, un bug) no debe encolar el cambio hacia arriba.
  IF sync.es_tabla_config(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME) THEN
    RETURN NEW;
  END IF;

  INSERT INTO sync.outbox (tabla, fila_id, payload, hlc_ts, hlc_cnt)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, NEW.id, to_jsonb(NEW),
          NEW.hlc_ts, NEW.hlc_cnt);
  RETURN NEW;
END $$;


-- Limpieza: lo que ya está encolado de tablas de config no tiene a dónde ir.
UPDATE sync.outbox o
   SET estado = 'confirmado',
       ultimo_error = 'clase A: la configuración no sube (0032)'
 WHERE o.estado <> 'confirmado'
   AND sync.es_tabla_config(o.tabla);
