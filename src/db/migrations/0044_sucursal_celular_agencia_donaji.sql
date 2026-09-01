-- =============================================================================
-- 0044 · `core.sucursal.celular` + la agencia pasa a llamarse "Agencia Donaji".
-- Blueprint v0.2 · docs/architecture/02-modelo-datos.md §3 (catálogo de sucursales)
--
-- CARGA INICIAL REAL (Ses. 52). El cliente entregó sus 4 sucursales
-- (`knowledge/sucursales.md`), cada una con un teléfono FIJO y —algunas— un
-- CELULAR. `core.sucursal` solo tenía `telefono_principal`; se agrega `celular`,
-- opcional (NULL = la sucursal no dio uno).
--
-- El backfill y el rename se hacen bajo `donaji.replicando = on` para que NO
-- disparen el reloj híbrido, el outbox ni el `cambio_log`: cada base (nube y
-- nodos) recibe estos valores al correr ESTA migración, no por sincronización.
-- `sync.ingest_fila` toma cualquier columna real y escribible del payload
-- (0031), así que una vez las dos bases tienen la columna, un bootstrap/pull
-- futuro replica `celular` solo, sin más cambios.
--
-- El rename apunta a la fila por su nombre actual ("Donaji Caos", heredado de un
-- fixture de la suite de caos que un `seed:qa` viejo reutilizó como agencia
-- principal). En una base nueva no afecta ninguna fila.
-- =============================================================================

ALTER TABLE core.sucursal ADD COLUMN IF NOT EXISTS celular text;

COMMENT ON COLUMN core.sucursal.celular IS
  'Segundo teléfono (celular) de la sucursal. Opcional: NULL si no tiene.';

DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);

  -- Celulares reales (knowledge/sucursales.md). La sucursal 2 (Acatlán de
  -- Osorio) no dio celular -> queda NULL.
  UPDATE core.sucursal SET celular = '953 157 9395' WHERE codigo = '1' AND celular IS NULL;
  UPDATE core.sucursal SET celular = '556 198 6891' WHERE codigo = '3' AND celular IS NULL;
  UPDATE core.sucursal SET celular = '554 562 5879' WHERE codigo = '4' AND celular IS NULL;

  UPDATE core.agencia SET nombre = 'Agencia Donaji' WHERE nombre = 'Donaji Caos';

  PERFORM set_config('donaji.replicando', 'off', true);
END $$;
