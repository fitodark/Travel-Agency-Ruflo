-- =============================================================================
-- SEED · Puntos terminal de las sucursales.
--
-- La migración 0048 crea `core.punto_ruta` y backfilla un punto tipo='terminal'
-- por cada sucursal existente al momento de migrar. Pero las 4 sucursales REALES
-- no viven en migración ni seed: las siembra `scripts/sembrar-qa.ts` contra la
-- nube (o la carga inicial real). Este seed es la RED DE SEGURIDAD: garantiza
-- que toda `core.sucursal` tenga su punto terminal aunque se haya dado de alta
-- después de 0048, sin que nadie tenga que acordarse de crearlo a mano.
--
-- Idempotente: id determinista `md5('core.punto_ruta:' || sucursal_id)` + guarda
-- `NOT EXISTS` + `ON CONFLICT DO NOTHING`. Corre bajo `donaji.replicando = on`
-- (igual que el backfill de 0048): estos puntos los deriva cada base al sembrar,
-- no se propagan por sync.
--
-- Solo catálogo de puntos. Ninguna ruta ni parada de QA: eso lo arma el fixture
-- de pruebas (`tests/fleet/`) y, si hace falta, `scripts/sembrar-qa.ts`.
-- =============================================================================

DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);

  INSERT INTO core.punto_ruta (id, nombre, tipo, sucursal_id, zona_horaria)
  SELECT md5('core.punto_ruta:' || s.id::text)::uuid,
         s.nombre, 'terminal', s.id, s.zona_horaria
    FROM core.sucursal s
   WHERE NOT EXISTS (
           SELECT 1 FROM core.punto_ruta p
            WHERE p.sucursal_id = s.id AND p.tipo = 'terminal'
         )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('donaji.replicando', 'off', true);
END $$;
