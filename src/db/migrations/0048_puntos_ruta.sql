-- =============================================================================
-- 0048 · Catálogo core.punto_ruta + re-cableado estructural de ruta_parada /
--        salida_parada. Fase 0 de "paradas autorizadas".
-- docs/architecture/05-paradas-autorizadas-tarifas.md §3 y §4
--
-- QUÉ RESUELVE. Hoy `ruta_parada.sucursal_id` y `salida_parada.sucursal_id`
-- obligan a que TODA parada de una ruta sea una `core.sucursal` real: quema
-- `sucursal.codigo` (char(1), techo 32), exige `direccion_completa` /
-- `telefono_principal` NOT NULL y mete la parada en el CRUD de sucursales,
-- usuarios y cortes. Una "parada autorizada de solo descenso" (p. ej. Cuautla,
-- sobre carretera a la altura del Home Depot) no es nada de eso.
--
-- CÓMO. Se introduce `core.punto_ruta` (tipo 'terminal' | 'parada'). Toda parada
-- que existe hoy proviene de una sucursal terminal, así que el backfill crea un
-- punto tipo='terminal' por sucursal y re-llavea `ruta_parada` / `salida_parada`
-- a `punto_id`. `sucursal_id` se conserva (deprecado, poblado en paralelo) y se
-- elimina en 0049.
--
-- REFACTOR PURO. Ninguna regla de negocio nueva: las banderas
-- `permite_ascenso` / `permite_descenso` se agregan estructuralmente (backfill
-- true/true para toda parada terminal existente) pero la lógica que las usa es
-- Fase 1+. `core.repartir_cupo_offline` NO se toca (Fase 4).
--
-- IDENTIDAD DETERMINISTA (mismo patrón que 0012/0013/0039). El id del punto
-- terminal se deriva de la sucursal con `md5('core.punto_ruta:' || sucursal_id)`
-- para que la nube y las 4 terminales converjan al MISMO id al correr esta
-- migración en la ventana de deploy (D-8), sin depender de replicación.
--
-- DIFERIDO A 0049 / Fase 1 (ventana coordinada nube + 4 terminales a mano, la
-- misma en que Fase 1 hace `DROP COLUMN sucursal_id`). NADA de esto se hace aquí
-- porque la nube compartida sigue en 0047 y `tests/sync/*` hace `bootstrap()`
-- real contra ella:
--   * `ALTER COLUMN punto_id SET NOT NULL` en ruta_parada y salida_parada
--     (tras backfillear los nodos: el compat trigger ya rellena en el pull, y
--     0049 hará además un backfill explícito de red).
--   * `src/sync/bootstrap.ts`: `core.punto_ruta` en `ORDEN_TOPOLOGICO`, antes
--     de `core.ruta_parada`.
--   * `DROP COLUMN core.ruta_parada.sucursal_id` / `core.salida_parada.sucursal_id`.
--   * Retirar los triggers de compatibilidad `trg_aa_compat_punto` y sus
--     funciones `core.trg_ruta_parada_compat_punto` / `core.trg_salida_parada_compat_punto`.
--
-- COMPAT MIENTRAS TANTO. `punto_id` queda NULLABLE. Un trigger BEFORE INSERT en
-- ruta_parada y salida_parada rellena `punto_id` (y las banderas true/true en
-- ruta_parada) a partir de `sucursal_id` cuando falta: cubre el código que aún
-- inserta por sucursal (`crearRuta`, fixtures) Y —comprobado— la ingesta de
-- `sync.ingest_fila`, que corre con la bandera `donaji.replicando` (0014) y NO
-- con `session_replication_role`, así que los triggers de usuario SÍ disparan
-- durante el pull/bootstrap desde una nube en 0047.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Catálogo de puntos de ruta.
--    FKs DEFERRABLE INITIALLY IMMEDIATE: el comportamiento por defecto no
--    cambia, pero el `SET CONSTRAINTS ALL DEFERRED` del bootstrap (0040) las
--    difiere de verdad.
-- ---------------------------------------------------------------------------
CREATE TABLE core.punto_ruta (
  id           uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  nombre       text NOT NULL,
  referencia   text,                                    -- no se imprime en el boleto
  tipo         text NOT NULL CHECK (tipo IN ('terminal','parada')),
  sucursal_id  uuid REFERENCES core.sucursal(id) DEFERRABLE INITIALLY IMMEDIATE,
  municipio    text,
  zona_horaria text NOT NULL DEFAULT 'America/Mexico_City',
  -- terminal <=> tiene sucursal
  CONSTRAINT punto_ruta_terminal_chk CHECK ((tipo = 'terminal') = (sucursal_id IS NOT NULL))
);
SELECT core.registrar_entidad('core.punto_ruta');   -- columnas estándar + outbox
SELECT sync.publicar_a_nodos('core.punto_ruta');    -- clase A: nube -> nodos

-- Un solo punto terminal por sucursal. Índice parcial: los puntos 'parada' no
-- tienen sucursal y no compiten aquí.
CREATE UNIQUE INDEX punto_ruta_sucursal_key
  ON core.punto_ruta (sucursal_id) WHERE sucursal_id IS NOT NULL;

COMMENT ON TABLE core.punto_ruta IS
  'Catálogo de puntos que toca una ruta: terminal (= sucursal) o parada autorizada. Clase A. 05 §3.';


-- ---------------------------------------------------------------------------
-- 2. Backfill: un punto 'terminal' por cada sucursal (activa o ya referenciada
--    por una parada / salida). id determinista; zona horaria copiada de la
--    sucursal para no cambiar el comportamiento de materializar_salidas.
--
--    Bajo `donaji.replicando = on` (igual que 0044): el backfill NO debe sellar
--    el reloj híbrido, encolar outbox ni publicar cambio_log. Cada base (nube y
--    nodos) obtiene estos valores al correr ESTA migración, no por sync.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);

  INSERT INTO core.punto_ruta (id, nombre, tipo, sucursal_id, municipio, zona_horaria)
  SELECT md5('core.punto_ruta:' || s.id::text)::uuid,
         s.nombre, 'terminal', s.id, NULL, s.zona_horaria
    FROM core.sucursal s
   WHERE s.activo
      OR EXISTS (SELECT 1 FROM core.ruta_parada  rp WHERE rp.sucursal_id = s.id)
      OR EXISTS (SELECT 1 FROM core.salida_parada sp WHERE sp.sucursal_id = s.id)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('donaji.replicando', 'off', true);
END $$;


-- ---------------------------------------------------------------------------
-- 3. ruta_parada: punto_id (nullable en Fase 0) + banderas + sucursal_id deja
--    de ser obligatorio.
-- ---------------------------------------------------------------------------
ALTER TABLE core.ruta_parada
  ADD COLUMN punto_id uuid
    REFERENCES core.punto_ruta(id) DEFERRABLE INITIALLY IMMEDIATE;

-- P-1 (D2): bandera de ascenso/descenso POR RUTA. Estructural; la lógica es
-- Fase 1. Toda parada existente proviene de una terminal => ambas true.
ALTER TABLE core.ruta_parada
  ADD COLUMN permite_ascenso  boolean NOT NULL DEFAULT false,
  ADD COLUMN permite_descenso boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);

  UPDATE core.ruta_parada rp
     SET punto_id         = md5('core.punto_ruta:' || rp.sucursal_id::text)::uuid,
         permite_ascenso  = true,
         permite_descenso = true;

  PERFORM set_config('donaji.replicando', 'off', true);
END $$;

ALTER TABLE core.ruta_parada ADD CONSTRAINT ruta_parada_rol_chk
  CHECK (permite_ascenso OR permite_descenso);

-- sucursal_id queda deprecado: una parada 'parada' no tiene sucursal. El DROP
-- COLUMN es 0049.
ALTER TABLE core.ruta_parada ALTER COLUMN sucursal_id DROP NOT NULL;
-- La unicidad real pasa a ser (ruta, punto). La vieja (ruta, sucursal_id) se
-- retira: sucursal_id ya no es la llave.
ALTER TABLE core.ruta_parada DROP CONSTRAINT IF EXISTS ruta_parada_ruta_id_sucursal_id_key;
ALTER TABLE core.ruta_parada ADD CONSTRAINT ruta_parada_ruta_punto_key
  UNIQUE (ruta_id, punto_id);


-- ---------------------------------------------------------------------------
-- 4. salida_parada: punto_id (nullable en Fase 0) + horas nullables.
--    Las horas se vuelven nullables ahora (estructural): una parada de solo
--    descenso viaja sin hora de paso ni cierre de venta (Fase 4).
-- ---------------------------------------------------------------------------
ALTER TABLE core.salida_parada
  ADD COLUMN punto_id uuid
    REFERENCES core.punto_ruta(id) DEFERRABLE INITIALLY IMMEDIATE;

DO $$
BEGIN
  PERFORM set_config('donaji.replicando', 'on', true);

  UPDATE core.salida_parada sp
     SET punto_id = md5('core.punto_ruta:' || sp.sucursal_id::text)::uuid;

  PERFORM set_config('donaji.replicando', 'off', true);
END $$;

ALTER TABLE core.salida_parada ALTER COLUMN hora_paso_programada DROP NOT NULL;
ALTER TABLE core.salida_parada ALTER COLUMN cierre_venta_en      DROP NOT NULL;


-- ---------------------------------------------------------------------------
-- 5. Triggers de compatibilidad.
--    Durante Fase 0-4, `crearRuta` (src/admin/horarios.ts), los fixtures y —
--    sobre todo— el bootstrap/pull desde una nube todavía en 0047 insertan
--    ruta_parada / salida_parada por `sucursal_id`, sin `punto_id` ni banderas.
--    Estos triggers BEFORE INSERT encuentran-o-crean el punto terminal de esa
--    sucursal y completan la fila. Se retiran en 0049 junto con el
--    DROP COLUMN sucursal_id. NO tocan filas que ya traen `punto_id` (el
--    fixture nuevo de parada de solo descenso, o una réplica ya en 0048).
--
--    `sync.ingest_fila` NO usa `session_replication_role` sino la bandera
--    `donaji.replicando` (0014), así que estos triggers BEFORE SÍ corren
--    durante la ingesta y rellenan `punto_id` antes del INSERT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.trg_ruta_parada_compat_punto() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_punto uuid;
BEGIN
  IF NEW.punto_id IS NULL AND NEW.sucursal_id IS NOT NULL THEN
    v_punto := md5('core.punto_ruta:' || NEW.sucursal_id::text)::uuid;
    INSERT INTO core.punto_ruta (id, nombre, tipo, sucursal_id, zona_horaria)
    SELECT v_punto, s.nombre, 'terminal', s.id, s.zona_horaria
      FROM core.sucursal s WHERE s.id = NEW.sucursal_id
    ON CONFLICT (id) DO NOTHING;
    NEW.punto_id         := v_punto;
    NEW.permite_ascenso  := true;
    NEW.permite_descenso := true;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION core.trg_salida_parada_compat_punto() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_punto uuid;
BEGIN
  IF NEW.punto_id IS NULL AND NEW.sucursal_id IS NOT NULL THEN
    v_punto := md5('core.punto_ruta:' || NEW.sucursal_id::text)::uuid;
    INSERT INTO core.punto_ruta (id, nombre, tipo, sucursal_id, zona_horaria)
    SELECT v_punto, s.nombre, 'terminal', s.id, s.zona_horaria
      FROM core.sucursal s WHERE s.id = NEW.sucursal_id
    ON CONFLICT (id) DO NOTHING;
    NEW.punto_id := v_punto;
  END IF;
  RETURN NEW;
END $$;

-- Nombre 'trg_aa_*' para que corra antes que trg_estandar (orden alfabético de
-- los BEFORE). No es imprescindible —tocan columnas distintas— pero deja
-- punto_id listo desde el principio.
CREATE OR REPLACE TRIGGER trg_aa_compat_punto
  BEFORE INSERT ON core.ruta_parada
  FOR EACH ROW EXECUTE FUNCTION core.trg_ruta_parada_compat_punto();

CREATE OR REPLACE TRIGGER trg_aa_compat_punto
  BEFORE INSERT ON core.salida_parada
  FOR EACH ROW EXECUTE FUNCTION core.trg_salida_parada_compat_punto();


-- ---------------------------------------------------------------------------
-- 6. core.materializar_salidas — misma lógica que 0019; SOLO cambia el
--    `INSERT INTO core.salida_parada`: los joins pasan por
--    `ruta_parada.punto_id -> core.punto_ruta`; `sucursal_id` y la zona horaria
--    salen de `punto_ruta` (`pr.sucursal_id`, `pr.zona_horaria`). Se sigue
--    escribiendo `sucursal_id` (aún NOT NULL) en paralelo.
--
--    En Fase 0 solo se materializan paradas con fila en `horario_parada` = todas
--    terminales, así que `pr.sucursal_id` nunca es NULL aquí.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.materializar_salidas(
  p_horario_id uuid,
  p_dias       integer DEFAULT NULL,
  p_desde      date    DEFAULT NULL
)
RETURNS TABLE (creadas integer, ya_existentes integer, sin_paradas integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_h            record;
  v_mapa         jsonb;
  v_tipo_unidad  uuid;
  v_conductor_nombre text;
  v_horizonte    integer;
  v_desde        date;
  v_cierre_min   integer;
  v_dia          date;
  v_salida_id    uuid;
  v_n_paradas    integer;
BEGIN
  creadas := 0; ya_existentes := 0; sin_paradas := 0;

  SELECT h.id, h.ruta_id, h.hora_salida, h.dias_semana, h.conductor_id, h.unidad_id,
         h.vigente_desde, h.vigente_hasta, h.activo,
         (h.effective_from <= now() AND (h.effective_until IS NULL OR h.effective_until > now())) AS vigente
    INTO v_h
    FROM core.horario h
   WHERE h.id = p_horario_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'horario % no existe', p_horario_id;
  END IF;
  IF NOT v_h.activo OR NOT v_h.vigente THEN
    RAISE EXCEPTION 'el horario % no está vigente: no se materializa', p_horario_id;
  END IF;
  IF v_h.conductor_id IS NULL THEN
    RAISE EXCEPTION 'el horario % no tiene conductor: sin él no se resuelve el tipo de unidad ni el mapa (D-7)', p_horario_id;
  END IF;

  SELECT c.tipo_unidad_id, c.nombre, tu.mapa
    INTO v_tipo_unidad, v_conductor_nombre, v_mapa
    FROM core.conductor c
    JOIN core.tipo_unidad tu ON tu.id = c.tipo_unidad_id
   WHERE c.id = v_h.conductor_id;

  IF v_mapa IS NULL THEN
    RAISE EXCEPTION 'el conductor del horario % no tiene tipo de unidad con mapa', p_horario_id;
  END IF;

  v_horizonte := COALESCE(
    p_dias,
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'horizonte_materializacion_dias' AND effective_from <= now()
      ORDER BY effective_from DESC LIMIT 1),
    90);
  v_desde := COALESCE(p_desde, current_date);
  v_cierre_min := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_cierre_venta' AND effective_from <= now()
      ORDER BY effective_from DESC LIMIT 1),
    15);

  FOR v_dia IN
    SELECT d::date
      FROM generate_series(v_desde, v_desde + v_horizonte, interval '1 day') d
     WHERE extract(isodow FROM d)::smallint = ANY (v_h.dias_semana)
       AND d::date >= COALESCE(v_h.vigente_desde, v_desde)
       AND d::date <= COALESCE(v_h.vigente_hasta, 'infinity'::date)
  LOOP
    INSERT INTO core.salida (horario_id, fecha_operacion, tipo_unidad_id, mapa_snapshot,
                             unidad_id, conductor_id, conductor_nombre_snapshot, estado)
    VALUES (p_horario_id, v_dia, v_tipo_unidad, v_mapa,
            v_h.unidad_id, v_h.conductor_id, v_conductor_nombre, 'programada')
    ON CONFLICT (horario_id, fecha_operacion) DO NOTHING
    RETURNING id INTO v_salida_id;

    IF v_salida_id IS NULL THEN
      ya_existentes := ya_existentes + 1;
      CONTINUE;
    END IF;

    -- Paradas de la salida: hora de paso por parada, en la zona horaria del
    -- punto. El cierre de venta va `minutos_cierre_venta` antes.
    INSERT INTO core.salida_parada (salida_id, sucursal_id, punto_id, orden,
                                    hora_paso_programada, cierre_venta_en)
    SELECT v_salida_id, pr.sucursal_id, pr.id, hp.orden,
           (v_dia + hp.hora_paso) AT TIME ZONE pr.zona_horaria,
           ((v_dia + hp.hora_paso) AT TIME ZONE pr.zona_horaria)
             - make_interval(mins => v_cierre_min)
      FROM core.horario_parada hp
      JOIN core.ruta_parada rp ON rp.id = hp.ruta_parada_id
      JOIN core.punto_ruta  pr ON pr.id = rp.punto_id
     WHERE hp.horario_id = p_horario_id
     ORDER BY hp.orden;

    GET DIAGNOSTICS v_n_paradas = ROW_COUNT;
    IF v_n_paradas = 0 THEN
      sin_paradas := sin_paradas + 1;
    ELSE
      PERFORM core.repartir_cupo_offline(v_salida_id);
    END IF;
    creadas := creadas + 1;
  END LOOP;

  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.materializar_salidas(uuid, integer, date) IS
  'Crea las salidas del horizonte para un horario, con mapa congelado y cupo repartido. Paradas vía core.punto_ruta. Job nocturno en la nube. Blueprint §6.1 · 05 §4.';
