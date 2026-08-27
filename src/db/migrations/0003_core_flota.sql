-- =============================================================================
-- 0003 · Flota: tipo de unidad con mapa declarativo, unidades y conductores.
--
-- Delta D-6: el mapa de asientos es DATO, no código. Ningún layout se hardcodea
--            (el requerimiento menciona Sprinter, Suburban y Urvan en secciones
--            distintas). La Sprinter de 18 se siembra en src/db/seed/.
-- Delta D-7: cadena conductor -> unidad -> tipo_unidad -> esquema.
--
-- Blueprint v0.2 · docs/architecture/02-modelo-datos.md §3 y §4
-- =============================================================================

CREATE TABLE core.tipo_unidad (
  id           uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  clave        text NOT NULL UNIQUE,        -- 'SPRINTER-18'
  nombre       text NOT NULL,
  marca        text,
  modelo       text,
  num_asientos smallint NOT NULL CHECK (num_asientos > 0),
  mapa         jsonb NOT NULL
);
SELECT core.registrar_entidad('core.tipo_unidad');

COMMENT ON COLUMN core.tipo_unidad.mapa IS
  'Layout declarativo. Claves: version, filas, columnas, pasillo_despues_columna, '
  'frente, accesos[], asientos[{num,fila,col,tipo,vendible}], '
  'bloques[{clave,etiqueta,asientos[]}]. Los bloques NO son decorativos: son la '
  'unidad de reparto de cupos offline (01b-consistencia-asientos.md §3.2).';


-- Validación estructural del mapa. Se hace en la base y no solo en la aplicación
-- porque un mapa mal formado rompe la invariante de asiento, que es la garantía
-- más importante del sistema.
CREATE OR REPLACE FUNCTION core.validar_mapa_unidad() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_asientos smallint[];
  v_bloques  smallint[];
BEGIN
  IF NEW.mapa->'asientos' IS NULL OR jsonb_typeof(NEW.mapa->'asientos') <> 'array' THEN
    RAISE EXCEPTION 'mapa.asientos debe ser un arreglo';
  END IF;

  SELECT array_agg((a->>'num')::smallint ORDER BY (a->>'num')::smallint)
    INTO v_asientos
    FROM jsonb_array_elements(NEW.mapa->'asientos') a
   WHERE COALESCE((a->>'vendible')::boolean, true);

  IF array_length(v_asientos, 1) IS DISTINCT FROM NEW.num_asientos THEN
    RAISE EXCEPTION 'num_asientos (%) no coincide con los asientos vendibles del mapa (%)',
      NEW.num_asientos, COALESCE(array_length(v_asientos, 1), 0);
  END IF;

  IF EXISTS (SELECT (a->>'num')::smallint
               FROM jsonb_array_elements(NEW.mapa->'asientos') a
              GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'el mapa tiene números de asiento duplicados';
  END IF;

  -- Los bloques deben cubrir EXACTAMENTE los asientos vendibles, sin traslape y
  -- sin huecos: de lo contrario el reparto de cupos dejaría asientos huérfanos
  -- que ninguna sucursal podría vender offline.
  IF NEW.mapa->'bloques' IS NOT NULL THEN
    SELECT array_agg(x ORDER BY x) INTO v_bloques
      FROM jsonb_array_elements(NEW.mapa->'bloques') b,
           jsonb_array_elements_text(b->'asientos') s,
           LATERAL (SELECT s::smallint) t(x);

    IF v_bloques IS DISTINCT FROM v_asientos THEN
      RAISE EXCEPTION 'los bloques no cubren exactamente los asientos vendibles';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_validar_mapa BEFORE INSERT OR UPDATE OF mapa, num_asientos
  ON core.tipo_unidad FOR EACH ROW EXECUTE FUNCTION core.validar_mapa_unidad();


CREATE TABLE core.unidad (
  id               uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  tipo_unidad_id   uuid NOT NULL REFERENCES core.tipo_unidad(id),
  numero_economico text NOT NULL,   -- se imprime en el ticket (paso 5 del flujo)
  placas           text,
  sucursal_base_id uuid REFERENCES core.sucursal(id),
  UNIQUE (numero_economico)
);
SELECT core.registrar_entidad('core.unidad');


-- -----------------------------------------------------------------------------
-- Conductores (D-7).
-- Queda como catálogo PROPIO, no dentro del módulo de horarios. El requerimiento
-- dejaba abierta esa duda; se resuelve así porque el conductor es ahora el
-- portador de la relación con el tipo de unidad y el esquema, y en Etapa 2 será
-- además quien lleva la paquetería. La UI puede seguir mostrándolo dentro de la
-- pantalla de horarios; separar el dato no obliga a separar la pantalla.
-- -----------------------------------------------------------------------------
CREATE TABLE core.conductor (
  id                 uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  nombre             text NOT NULL,
  direccion          text,
  telefono           text,
  ine_numero         text,
  ine_archivo_url    text,
  contacto_nombre    text,      -- opcional, según el requerimiento
  contacto_telefono  text,
  -- Cadena conductor -> unidad -> tipo_unidad -> esquema
  tipo_unidad_id     uuid NOT NULL REFERENCES core.tipo_unidad(id),
  unidad_habitual_id uuid REFERENCES core.unidad(id)
);
SELECT core.registrar_entidad('core.conductor');

-- Coherencia de la cadena: si el conductor tiene unidad habitual, su tipo debe
-- ser el mismo. Se valida por trigger porque un CHECK no puede consultar otra
-- tabla.
CREATE OR REPLACE FUNCTION core.validar_conductor_unidad() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unidad_habitual_id IS NOT NULL
     AND NEW.tipo_unidad_id IS DISTINCT FROM
         (SELECT tipo_unidad_id FROM core.unidad WHERE id = NEW.unidad_habitual_id) THEN
    RAISE EXCEPTION
      'el tipo_unidad del conductor no coincide con el de su unidad habitual';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_conductor_unidad
  BEFORE INSERT OR UPDATE OF tipo_unidad_id, unidad_habitual_id
  ON core.conductor FOR EACH ROW EXECUTE FUNCTION core.validar_conductor_unidad();

CREATE INDEX conductor_tipo_idx ON core.conductor (tipo_unidad_id) WHERE activo;
