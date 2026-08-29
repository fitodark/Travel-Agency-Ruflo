-- =============================================================================
-- 0039 · Bootstrap robusto: identidad determinista de `tipo_unidad` y
--        clasificación correcta de la excepción de ingesta por unicidad.
-- Blueprint v0.2 · docs/architecture/01-sincronizacion.md §5
--
-- DEFECTO D4 (docs/historial.md · "Defectos conocidos aún vivos"):
-- Una terminal instalada CON seeds no puede hacer bootstrap. Cadena de tres:
--
--  1. `src/db/seed/0001_tipo_unidad_sprinter18.sql` inserta la Sprinter sin fijar
--     `id`, así que el DEFAULT `core.uuid_v7()` genera uno DISTINTO en cada base
--     para la misma `clave` (que es UNIQUE). La Sprinter de la nube y la del nodo
--     acaban siendo la misma unidad con identidades incompatibles.
--  2. `sync.ingest_fila` hace `ON CONFLICT (id)`; un choque por la constraint
--     `tipo_unidad_clave_key` NO lo absorbe: sale por `unique_violation` y se
--     devuelve `conflicto`. `sync.ingest_batch` lo archivaba como
--     `sobreventa`/`critica` — que no tiene nada que ver con una colisión de
--     catálogo. El tipo `folio_duplicado` existe en el CHECK de 0008 y no lo
--     usaba nadie.
--  3. `bootstrap` solo aborta ante `rechazada`; `conflicto` lo ignora en silencio
--     (eso se corrige en `src/sync/bootstrap.ts`, no aquí). El fallo aflora
--     niveles después como una FK rota en `core.salida`.
--
-- Esta migración cierra (1) y (2). El (3) es TypeScript.
--
-- Mismo patrón de identidad determinista que `core.rol_permiso` (0012) y
-- `core.parametro` (0013): `id` derivado del par natural con `md5(...)::uuid`, y
-- un trigger que lo mantiene para filas nuevas. Se aplica IDÉNTICA en nube y
-- local; como las dos convergen al mismo `id` por `clave`, el `UPDATE` es una
-- corrección en sitio sin insertar ni borrar filas.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. core.tipo_unidad — identidad determinista por `clave`.
-- -----------------------------------------------------------------------------
-- El DEFAULT aleatorio se retira: a partir de aquí el `id` lo pone el trigger de
-- derivación cuando el INSERT no lo trae (que es lo que hace el seed).
ALTER TABLE core.tipo_unidad ALTER COLUMN id DROP DEFAULT;

CREATE OR REPLACE FUNCTION core.trg_tipo_unidad_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := md5('core.tipo_unidad:' || NEW.clave)::uuid;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_tipo_unidad_id
  BEFORE INSERT OR UPDATE ON core.tipo_unidad
  FOR EACH ROW EXECUTE FUNCTION core.trg_tipo_unidad_id();

-- Convergencia de las filas ya sembradas por separado en cada base. Ninguna FK
-- apunta todavía a `core.tipo_unidad` en operación (unidad y salida se pueblan
-- después), así que reescribir la PK en sitio es seguro. En la nube este UPDATE
-- se publica por `trg_cambio_log` y los nodos convergen al mismo `id`.
UPDATE core.tipo_unidad
   SET id = md5('core.tipo_unidad:' || clave)::uuid
 WHERE id IS DISTINCT FROM md5('core.tipo_unidad:' || clave)::uuid;


-- -----------------------------------------------------------------------------
-- 2. sync.ingest_batch — una colisión de unicidad de catálogo NO es sobreventa.
-- -----------------------------------------------------------------------------
-- Parte de la versión de 0010. Lo único que cambia es el bloque que archiva la
-- excepción: se distingue el traslape de asiento (clase D real, `sobreventa` /
-- `critica`) de cualquier otra `unique_violation` (`folio_duplicado` / `alta`),
-- usando el `motivo` que ya rellena `sync.ingest_fila` (0031).
CREATE OR REPLACE FUNCTION sync.ingest_batch(p_lote jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_lote_id     uuid := (p_lote->>'lote_id')::uuid;
  v_sucursal_id uuid := (p_lote->>'sucursal_id')::uuid;
  v_version     text := p_lote->>'version_nodo';
  v_fila        jsonb;
  v_res         record;
  v_detalle     jsonb := '[]'::jsonb;
  v_ack         jsonb;
  v_previo      jsonb;
  v_aceptadas   integer := 0;
  v_ignoradas   integer := 0;
  v_conflictos  integer := 0;
  v_rechazadas  integer := 0;
  v_es_traslape boolean;
BEGIN
  IF v_lote_id IS NULL OR v_sucursal_id IS NULL THEN
    RAISE EXCEPTION 'lote inválido: falta lote_id o sucursal_id';
  END IF;

  SELECT ack INTO v_previo FROM sync.lote_recibido WHERE lote_id = v_lote_id;
  IF FOUND THEN
    RETURN jsonb_set(v_previo, '{idempotente}', 'true'::jsonb);
  END IF;

  FOR v_fila IN
    SELECT value FROM jsonb_array_elements(coalesce(p_lote->'filas', '[]'::jsonb))
     ORDER BY (value->>'seq')::bigint
  LOOP
    SELECT * INTO v_res
      FROM sync.ingest_fila(
        v_fila->>'tabla',
        (v_fila->>'fila_id')::uuid,
        v_fila->'payload'
      );

    v_detalle := v_detalle || jsonb_build_object(
      'seq',     (v_fila->>'seq')::bigint,
      'fila_id', v_fila->>'fila_id',
      'estado',  v_res.estado,
      'motivo',  v_res.motivo
    );

    CASE v_res.estado
      WHEN 'aceptada'     THEN v_aceptadas  := v_aceptadas + 1;
      WHEN 'ignorada_hlc' THEN v_ignoradas  := v_ignoradas + 1;
      WHEN 'conflicto'    THEN v_conflictos := v_conflictos + 1;
      ELSE                     v_rechazadas := v_rechazadas + 1;
    END CASE;

    IF v_res.estado IN ('conflicto', 'rechazada') THEN
      -- Traslape de asiento = clase D (dos sucursales vendieron el mismo lugar):
      -- lo arbitra la reconciliación y es crítico. Cualquier otra violación de
      -- unicidad (folio repetido de una terminal reinstalada, colisión de
      -- catálogo por identidad no determinista) es un problema de identidad, no
      -- de negocio: severidad alta y a revisión, no `sobreventa`.
      v_es_traslape := v_res.estado = 'conflicto'
                       AND v_res.motivo LIKE '%exclusion_violation%';

      INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, entidad_id, detalle)
      VALUES (
        CASE
          WHEN v_res.estado = 'rechazada' THEN 'rechazo_ingesta'
          WHEN v_es_traslape              THEN 'sobreventa'
          ELSE                                 'folio_duplicado'
        END,
        CASE
          WHEN v_es_traslape THEN 'critica'
          ELSE                    'alta'
        END,
        v_sucursal_id,
        v_fila->>'tabla',
        (v_fila->>'fila_id')::uuid,
        jsonb_build_object('motivo', v_res.motivo, 'lote_id', v_lote_id)
      );
    END IF;
  END LOOP;

  v_ack := jsonb_build_object(
    'lote_id',     v_lote_id,
    'idempotente', false,
    'aceptadas',   v_aceptadas,
    'ignoradas',   v_ignoradas,
    'conflictos',  v_conflictos,
    'rechazadas',  v_rechazadas,
    'filas',       v_detalle
  );

  INSERT INTO sync.lote_recibido (lote_id, sucursal_id, version_nodo, filas, ack)
  VALUES (v_lote_id, v_sucursal_id, v_version, jsonb_array_length(v_detalle), v_ack);

  RETURN v_ack;
END $$;

COMMENT ON FUNCTION sync.ingest_batch(jsonb) IS
  'Ingesta idempotente de un lote del outbox de una sucursal. Blueprint §3.1. '
  '0039: la unique_violation que no es traslape de asiento se archiva como '
  'folio_duplicado/alta, no sobreventa/critica.';
