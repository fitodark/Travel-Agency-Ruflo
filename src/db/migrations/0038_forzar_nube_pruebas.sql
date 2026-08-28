-- =============================================================================
-- 0038 · `trg_cambio_log` acepta un override por GUC para las pruebas.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.1
--
-- `sync.trg_cambio_log` solo publica si `sync.nodo.es_nube`. Para ejercitar la
-- publicación, las pruebas hacían `UPDATE sync.nodo SET es_nube = true` dentro de
-- su transacción — y eso toma el lock de la fila ÚNICA `sync.nodo`, que serializa
-- con cualquier otra prueba que también la toque. Con una decena de pruebas de la
-- consola en paralelo, alguna se quedaba esperando y superaba el timeout.
--
-- Se añade un escape por GUC de sesión, igual que `sync.replicando()` (0014):
-- `SET LOCAL donaji.forzar_nube = 'on'` hace que el trigger publique sin tocar
-- `sync.nodo`. NO tiene efecto en producción: nadie fija ese GUC ahí.
-- =============================================================================

CREATE OR REPLACE FUNCTION sync.forzar_nube() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('donaji.forzar_nube', true), 'off') = 'on';
$$;

COMMENT ON FUNCTION sync.forzar_nube() IS
  'true si SET donaji.forzar_nube=on. Solo para pruebas: publicar sin tocar sync.nodo.';

CREATE OR REPLACE FUNCTION sync.trg_cambio_log() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (sync.forzar_nube()
          OR (SELECT es_nube FROM sync.nodo WHERE singleton)) THEN
    RETURN NEW;
  END IF;

  -- Una fila que la nube recibió de una sucursal no debe volver a publicarse como
  -- si fuera un cambio de configuración del administrador.
  IF sync.replicando() THEN RETURN NEW; END IF;

  INSERT INTO sync.cambio_log (tabla, fila_id, payload)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, NEW.id, to_jsonb(NEW));
  RETURN NEW;
END $$;
