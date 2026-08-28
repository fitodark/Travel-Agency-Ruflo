-- =============================================================================
-- 0033 · Diff fila a fila de un bloque de checksum.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §6.1
--
-- `sync.calcular_checksum` dice SI un bloque (tabla/día/sucursal) diverge, pero
-- no QUÉ fila. El §6.1 promete "el bloque exacto y un re-push dirigido", y
-- dirigido significa reenviar solo las filas que faltan, no el día entero.
--
-- Esta función devuelve `(id, version)` de cada fila del bloque, ordenado por id
-- —la misma ventana y el mismo corte de día (UTC) que `calcular_checksum`— para
-- que la reconciliación haga la diferencia de conjuntos en el cliente:
--
--   solo_en_local     · el nodo la tiene, la nube no  → re-push dirigido
--   solo_en_nube      · la nube la tiene, el nodo no  → pérdida local (humano)
--   version_distinta  · mismo id, distinta version    → divergencia de contenido
-- =============================================================================

CREATE OR REPLACE FUNCTION sync.filas_bloque(
  p_tabla regclass, p_sucursal_id uuid, p_dia date)
RETURNS TABLE (id uuid, version integer)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY EXECUTE format($f$
    SELECT id, version
      FROM %1$s
     WHERE sync_sucursal_id = %2$L
       AND (creado_en AT TIME ZONE 'UTC')::date = %3$L::date
     ORDER BY id
  $f$, p_tabla, p_sucursal_id, p_dia);
END $$;

COMMENT ON FUNCTION sync.filas_bloque(regclass, uuid, date) IS
  'Filas (id, version) de un bloque día/tabla/sucursal, para el diff dirigido de la reconciliación. Mismo corte UTC que sync.calcular_checksum. Blueprint §6.1.';
