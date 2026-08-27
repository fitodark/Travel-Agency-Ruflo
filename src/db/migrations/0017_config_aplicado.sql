-- =============================================================================
-- 0017 · Marca de la última pasada del aplicador de configuración.
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §3.3
--
-- El aplicador corre en el nodo cada 5 minutos y con una pasada dedicada en la
-- ventana nocturna. Materializa los cambios de configuración cuya fecha de
-- vigencia ya pasó: recalcula vistas, invalida caché en memoria y **cierra las
-- sesiones de usuarios cuya vigencia terminó**.
--
-- Esta tabla singleton guarda cuándo corrió por última vez y qué hizo, para que
-- el tablero de salud pueda mostrar "el aplicador no corre desde hace X" — un
-- aplicador detenido es tan grave como un sync detenido: una baja de usuario
-- programada nunca surtiría efecto.
-- =============================================================================

CREATE TABLE sync.config_aplicado (
  singleton              boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ultima_pasada          timestamptz,
  ultima_epoca           text,
  sesiones_cerradas_total bigint NOT NULL DEFAULT 0
);
INSERT INTO sync.config_aplicado DEFAULT VALUES ON CONFLICT DO NOTHING;
