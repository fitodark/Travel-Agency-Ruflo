-- =============================================================================
-- 0040 · Las claves foráneas de `core` se declaran DEFERRABLE.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §5
--
-- DEFECTO D6 (docs/historial.md · "Defectos conocidos aún vivos"):
-- `src/sync/bootstrap.ts` hace `SET CONSTRAINTS ALL DEFERRED` "para tolerar
-- orden parcial dentro de un nivel". PostgreSQL solo difiere las constraints
-- declaradas DEFERRABLE, y ninguna de las ~69 FK de `core` lo era: la sentencia
-- no falla, no avisa, y no hace nada. El bootstrap funciona hoy ÚNICAMENTE
-- porque `ORDEN_TOPOLOGICO` está bien escrito a mano; el día que alguien agregue
-- una tabla en el nivel equivocado, el fallo aparece en la cuarta sucursal y no
-- en las tres primeras, de madrugada y por TeamViewer.
--
-- `INITIALLY IMMEDIATE`: el comportamiento por defecto NO cambia — las FK se
-- siguen verificando fila a fila en cada sentencia. Solo el `SET CONSTRAINTS ALL
-- DEFERRED` explícito del bootstrap (y de cualquier transacción que lo pida)
-- empieza a diferirlas hasta el COMMIT. No reescribe tablas; toma un lock
-- ACCESS EXCLUSIVE breve por tabla.
--
-- Se hace en bloque dinámico sobre el catálogo, no con una lista a mano: una
-- lista se desactualiza y vuelve a dejar FK sin diferir sin que nadie lo note.
-- =============================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass::text AS tabla, conname
      FROM pg_constraint
     WHERE contype = 'f'
       AND connamespace = 'core'::regnamespace
       AND NOT condeferrable
  LOOP
    EXECUTE format(
      'ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
      r.tabla, r.conname);
  END LOOP;
END $$;
