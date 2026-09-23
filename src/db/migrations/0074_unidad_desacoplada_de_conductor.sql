-- =============================================================================
-- 0074 · La UNIDAD física, no el conductor, determina el tipo/mapa de una
--        salida. El conductor pasa a ser un dato operativo del día, no un
--        requisito de programación. Regla de QA (Ses. 75).
--
-- QUÉ RESUELVE. Desde 0003/0004 (D-7) la cadena era
--   conductor -> tipo_unidad -> mapa   (unidad_id era un adorno opcional)
-- y `core.materializar_salidas` exigía `horario.conductor_id` para poder
-- resolver el mapa. En operación real es al revés: la UNIDAD ("Unidad 3") es lo
-- que de verdad se programa y lo que casi nunca cambia; el conductor que la
-- maneja un día dado sí varía (enfermedad, turno) y HOY se decide apenas antes
-- de imprimir el manifiesto — no al armar el horario. Pedir conductor para
-- programar a futuro era la restricción equivocada.
--
-- CAMBIA:
--   1. `core.conductor.tipo_unidad_id` deja de ser NOT NULL: ya no presta ese
--      dato a nadie, queda como referencia informativa opcional ("qué tipo
--      maneja normalmente"), útil para filtrar candidatos en la UI.
--   2. `core.materializar_salidas` exige `horario.unidad_id` (antes exigía
--      `conductor_id`) y saca `tipo_unidad_id`/`mapa_snapshot` de
--      `core.unidad.tipo_unidad_id` — ese dato SIEMPRE existió ahí (0003), nunca
--      se había usado. El conductor viaja como snapshot opcional si el horario
--      ya tiene uno asignado; si no, la salida nace sin conductor.
--   3. `core.cambiar_conductor` se simplifica radicalmente: ya no puede volver
--      incompatible el mapa (el mapa ahora es de la unidad, no del conductor),
--      así que desaparecen los 4 casos, el recálculo de mapa/cupos, los
--      boletos huérfanos y la autorización de gerente. Queda: validar que la
--      salida no esté en_ruta/finalizada/cancelada, y asignar. Sigue dejando
--      auditoría en `core.cambio_conductor` (tabla intacta; los campos que ya
--      no aplican — caso, tipo_unidad, huérfanos — quedan en su valor neutro).
--   4. `core.mover_unidad` (NUEVA): recorre la unidad de una salida SIN
--      boletos activos al resto del día (Ses. 75, segunda vuelta con QA — NO
--      es un traspaso 1 a 1). La salida donante se cancela. Su unidad pasa al
--      SIGUIENTE horario de la misma ruta ese mismo día; si ese horario YA
--      tenía su propia unidad, esa unidad desplazada pasa al horario
--      siguiente, y así en cadena hasta que una salida sin unidad absorbe el
--      último eslabón (o se acaban las salidas del día — la última unidad
--      desplazada queda sin horario, a reacomodar a mano). La cadena NUNCA
--      cruza a otro día: el de mañana sigue con lo que ya tenía programado; si
--      hace falta, se corre el mismo mover_unidad otra vez ese día. El mapa de
--      asientos no se toca en ningún eslabón (es del conductor, no de la
--      unidad, desde este mismo 0074): los boletos ya vendidos en las salidas
--      intermedias de la cadena no se ven afectados, así que NO se exige cero
--      boletos salvo en la salida donante (la única que se cancela). El
--      conductor de ninguna salida se toca: es independiente (confirmado con
--      QA). Cualquier rol operativo puede hacerlo — es una decisión de piso,
--      no de gerencia — así que NO lleva guard de `rol_permiso` aquí; lo
--      filtra la API (`exige(operar)`, igual que generar manifiestos o marcar
--      en ruta).
--
-- NO CAMBIA: el snapshot del mapa sigue congelado en `salida.mapa_snapshot`
-- (D-7 original sigue vigente, solo cambia DE DÓNDE sale el snapshot).
--
-- DEPLOY: alteración de columna + 2 `CREATE OR REPLACE` + 1 tabla nueva + 1
-- función nueva. Sin datos que migrar: local y nube tienen 19/20 horarios
-- activos con AMBOS conductor y unidad ya capturados (verificado), 0 con
-- conductor sin unidad — nadie queda materializando en la ventana de este
-- deploy.
-- =============================================================================


-- 1. `core.conductor.tipo_unidad_id` deja de ser obligatorio.
-- ---------------------------------------------------------------------------
ALTER TABLE core.conductor ALTER COLUMN tipo_unidad_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION core.validar_conductor_unidad() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 0074: tipo_unidad_id del conductor es ahora informativo (puede ser NULL).
  -- Solo se valida la coherencia cuando AMBOS datos están presentes.
  IF NEW.unidad_habitual_id IS NOT NULL AND NEW.tipo_unidad_id IS NOT NULL
     AND NEW.tipo_unidad_id IS DISTINCT FROM
         (SELECT tipo_unidad_id FROM core.unidad WHERE id = NEW.unidad_habitual_id) THEN
    RAISE EXCEPTION
      'el tipo_unidad del conductor no coincide con el de su unidad habitual';
  END IF;
  RETURN NEW;
END $$;


-- 2. `core.materializar_salidas` — exige `unidad_id`, saca el mapa de ahí.
--    Idéntica a 0055 salvo el origen del tipo_unidad/mapa y el conductor
--    opcional.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.materializar_salidas(
  p_horario_id uuid,
  p_dias       integer DEFAULT NULL,
  p_desde      date    DEFAULT NULL
)
RETURNS TABLE(creadas integer, ya_existentes integer, sin_paradas integer)
LANGUAGE plpgsql AS $function$
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
  -- 0074: la unidad (no el conductor) es lo que resuelve el tipo/mapa.
  IF v_h.unidad_id IS NULL THEN
    RAISE EXCEPTION 'el horario % no tiene unidad: sin ella no se resuelve el tipo de unidad ni el mapa (0074)', p_horario_id;
  END IF;

  SELECT u.tipo_unidad_id, tu.mapa
    INTO v_tipo_unidad, v_mapa
    FROM core.unidad u
    JOIN core.tipo_unidad tu ON tu.id = u.tipo_unidad_id
   WHERE u.id = v_h.unidad_id;

  IF v_mapa IS NULL THEN
    RAISE EXCEPTION 'la unidad del horario % no existe o su tipo de unidad no tiene mapa', p_horario_id;
  END IF;

  -- El conductor es opcional (0074): si el horario ya trae uno, viaja como
  -- snapshot; si no, la salida nace sin conductor y se asigna después
  -- (`core.cambiar_conductor`), antes de imprimir el manifiesto.
  IF v_h.conductor_id IS NOT NULL THEN
    SELECT c.nombre INTO v_conductor_nombre FROM core.conductor c WHERE c.id = v_h.conductor_id;
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

    INSERT INTO core.salida_parada (salida_id, punto_id, orden,
                                    hora_paso_programada, cierre_venta_en)
    SELECT v_salida_id, pr.id, rp.orden,
           CASE WHEN hp.hora_paso IS NOT NULL
                THEN (v_dia + hp.hora_paso) AT TIME ZONE pr.zona_horaria END,
           CASE WHEN hp.hora_paso IS NOT NULL
                THEN ((v_dia + hp.hora_paso) AT TIME ZONE pr.zona_horaria)
                       - make_interval(mins => v_cierre_min) END
      FROM core.ruta_parada rp
      JOIN core.punto_ruta  pr ON pr.id = rp.punto_id
      LEFT JOIN core.horario_parada hp
        ON hp.ruta_parada_id = rp.id AND hp.horario_id = p_horario_id
     WHERE rp.ruta_id = v_h.ruta_id
       AND rp.activo
     ORDER BY rp.orden;

    GET DIAGNOSTICS v_n_paradas = ROW_COUNT;
    IF v_n_paradas = 0 THEN
      sin_paradas := sin_paradas + 1;
    ELSE
      PERFORM core.repartir_cupo_offline(v_salida_id);
    END IF;
    creadas := creadas + 1;
  END LOOP;

  RETURN NEXT;
END $function$;

COMMENT ON FUNCTION core.materializar_salidas(uuid, integer, date) IS
  'Materializa salidas del horizonte para un horario. Exige unidad_id (0074, no conductor_id): el tipo/mapa sale de core.unidad. Conductor opcional. Una salida_parada por ruta_parada activa. 05 §4.';


-- 3. `core.cambiar_conductor` — simplificado: ya no puede invalidar el mapa
--    (el mapa es de la unidad, no del conductor), así que desaparecen los
--    casos de compatibilidad. Mantiene el mismo nombre y sigue auditando en
--    `core.cambio_conductor` para no romper la traza existente.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.cambiar_conductor(uuid, uuid, uuid, boolean, text);

CREATE FUNCTION core.cambiar_conductor(
  p_salida_id          uuid,
  p_conductor_nuevo_id uuid,
  p_usuario_id         uuid,
  p_motivo             text DEFAULT NULL
)
RETURNS TABLE (cambio_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_sal          record;
  v_rol          text;
  v_cond_ant     uuid;
  v_cond_nombre  text;
BEGIN
  SELECT s.id, s.estado, s.conductor_id, s.tipo_unidad_id
    INTO v_sal
    FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salida % no existe', p_salida_id;
  END IF;

  IF v_sal.estado IN ('en_ruta', 'finalizada') THEN
    RAISE EXCEPTION 'la salida % está % : no se puede cambiar el conductor', p_salida_id, v_sal.estado;
  END IF;
  IF v_sal.estado = 'cancelada' THEN
    RAISE EXCEPTION 'la salida % está cancelada', p_salida_id;
  END IF;

  SELECT u.rol INTO v_rol FROM core.usuario u WHERE u.id = p_usuario_id AND u.activo;
  IF v_rol IS NULL THEN
    RAISE EXCEPTION 'usuario % no existe o está inactivo', p_usuario_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.rol_permiso WHERE rol = v_rol AND permiso = 'conductor.cambiar.compatible') THEN
    RAISE EXCEPTION 'el rol % no puede cambiar el conductor', v_rol;
  END IF;

  SELECT c.nombre INTO v_cond_nombre
    FROM core.conductor c WHERE c.id = p_conductor_nuevo_id AND c.activo;
  IF v_cond_nombre IS NULL THEN
    RAISE EXCEPTION 'conductor % no existe o está inactivo', p_conductor_nuevo_id;
  END IF;

  v_cond_ant := v_sal.conductor_id;

  -- 0074: asignar conductor NUNCA toca el mapa, los cupos ni los boletos — el
  -- mapa es de la unidad, no del conductor. Solo queda registrar quién maneja.
  UPDATE core.salida
     SET conductor_id = p_conductor_nuevo_id,
         conductor_nombre_snapshot = v_cond_nombre
   WHERE id = p_salida_id;

  INSERT INTO core.cambio_conductor (salida_id, conductor_anterior_id, conductor_nuevo_id,
    tipo_unidad_anterior_id, tipo_unidad_nuevo_id, caso, requirio_autorizacion,
    autorizado_por, boletos_afectados, motivo, estado, aplicado_en)
  VALUES (p_salida_id, v_cond_ant, p_conductor_nuevo_id, v_sal.tipo_unidad_id, v_sal.tipo_unidad_id,
          1, false, NULL, 0, p_motivo, 'aplicado', now())
  RETURNING id INTO cambio_id;

  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.cambiar_conductor(uuid, uuid, uuid, text) IS
  'Asigna el conductor real de una salida. Desde 0074 nunca toca el mapa (es de la unidad, no del conductor): sin casos de compatibilidad. Auditoría en core.cambio_conductor (caso/tipo_unidad/huérfanos quedan en su valor neutro, ya no aplican).';


-- 4. `core.movimiento_unidad` — auditoría del traspaso de unidad entre
--    salidas (Rule 2). Mismo patrón que `core.cambio_conductor`.
-- ---------------------------------------------------------------------------
-- Una fila por ESLABÓN de la cadena (una salida que recibió una unidad
-- distinta a la que tenía). `salida_origen_id` es SIEMPRE la salida donante
-- que arrancó la cadena (la que se canceló) — así una consulta por ese id trae
-- de un jalón todos los eslabones que movió ese evento, aunque
-- `salida_destino_id` sea distinta en cada fila. FK DEFERRABLE (0040: toda FK
-- nueva de `core` lo es, para que el bootstrap tolere orden parcial).
CREATE TABLE core.movimiento_unidad (
  id                uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  salida_origen_id  uuid NOT NULL REFERENCES core.salida(id) DEFERRABLE,
  salida_destino_id uuid NOT NULL REFERENCES core.salida(id) DEFERRABLE,
  unidad_id         uuid NOT NULL REFERENCES core.unidad(id) DEFERRABLE,
  usuario_id        uuid NOT NULL REFERENCES core.usuario(id) DEFERRABLE,
  motivo            text,
  movido_en         timestamptz NOT NULL DEFAULT now()
);
SELECT core.registrar_entidad('core.movimiento_unidad');


-- 5. `core.mover_unidad` — recorre la unidad de una salida sin boletos al
--    siguiente horario disponible de la misma ruta, el mismo día. Cancela la
--    salida donante.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.mover_unidad(
  p_salida_origen_id  uuid,
  p_usuario_id        uuid,
  p_motivo            text DEFAULT NULL,
  p_ahora             timestamptz DEFAULT now()
)
RETURNS TABLE (unidad_id uuid, salidas_afectadas integer, unidad_desplazada_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_origen         record;
  v_ruta_id        uuid;
  v_hora_origen    timestamptz;
  v_n_boletos      integer;
  v_cur            record;
  v_entrante       uuid;
  v_saliente       uuid;
  v_afectadas      integer := 0;
BEGIN
  SELECT s.id, s.estado, s.unidad_id, s.horario_id, s.fecha_operacion
    INTO v_origen
    FROM core.salida s WHERE s.id = p_salida_origen_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida origen % no existe', p_salida_origen_id;
  END IF;
  IF v_origen.estado <> 'programada' THEN
    RAISE EXCEPTION 'la salida origen % está % : no se puede mover su unidad', p_salida_origen_id, v_origen.estado;
  END IF;
  IF v_origen.unidad_id IS NULL THEN
    RAISE EXCEPTION 'la salida origen % no tiene unidad asignada', p_salida_origen_id;
  END IF;

  SELECT count(*)::int INTO v_n_boletos
    FROM core.boleto b WHERE b.salida_id = p_salida_origen_id AND b.estado <> 'cancelado';
  IF v_n_boletos > 0 THEN
    RAISE EXCEPTION 'la salida origen % todavía tiene % boleto(s) activo(s): reubícalos antes de mover la unidad', p_salida_origen_id, v_n_boletos;
  END IF;

  SELECT h.ruta_id INTO v_ruta_id FROM core.horario h WHERE h.id = v_origen.horario_id;
  SELECT sp.hora_paso_programada INTO v_hora_origen
    FROM core.salida_parada sp WHERE sp.salida_id = p_salida_origen_id AND sp.orden = 0;

  unidad_id := v_origen.unidad_id;
  -- "Sin hogar" en cada momento: arranca siendo la unidad de la salida
  -- donante; si la cadena no encuentra ningún eslabón (ni un solo horario más
  -- tarde ese día), esta ES la unidad desplazada — se queda sin horario tal
  -- cual, y el resultado debe reflejarlo.
  v_entrante := v_origen.unidad_id;

  -- La salida donante ya no va a salir: ni su origen ni sus paradas
  -- intermedias tendrán unidad para hacer ese recorrido.
  UPDATE core.salida SET estado = 'cancelada', unidad_id = NULL WHERE id = p_salida_origen_id;

  -- Cadena: cada salida más tarde de la MISMA ruta, el MISMO día, en orden
  -- cronológico, recibe la unidad sin hogar; la que tenía se vuelve la
  -- siguiente sin hogar. El mapa NUNCA se toca (es del conductor, no de la
  -- unidad, 0074): los boletos ya vendidos en estos eslabones intermedios no
  -- se ven afectados, así que no hace falta que estén vacíos. La cadena para
  -- en cuanto un hueco absorbe a la sin-hogar (queda NULL), o se acaban las
  -- salidas programadas de ese día — nunca cruza al día siguiente.
  FOR v_cur IN
    SELECT s.id, s.unidad_id
      FROM core.salida s
      JOIN core.horario h ON h.id = s.horario_id
      JOIN core.salida_parada sp ON sp.salida_id = s.id AND sp.orden = 0
     WHERE h.ruta_id = v_ruta_id
       AND s.fecha_operacion = v_origen.fecha_operacion
       AND s.estado = 'programada'
       AND sp.hora_paso_programada > v_hora_origen
     ORDER BY sp.hora_paso_programada
  LOOP
    v_saliente := v_cur.unidad_id;

    UPDATE core.salida SET unidad_id = v_entrante WHERE id = v_cur.id;

    INSERT INTO core.movimiento_unidad (salida_origen_id, salida_destino_id, unidad_id, usuario_id, motivo)
    VALUES (p_salida_origen_id, v_cur.id, v_entrante, p_usuario_id, p_motivo);

    v_afectadas := v_afectadas + 1;
    v_entrante := v_saliente;   -- NULL si este eslabón era un hueco: la cadena termina aquí
    EXIT WHEN v_entrante IS NULL;
  END LOOP;

  salidas_afectadas := v_afectadas;
  unidad_desplazada_id := v_entrante;   -- lo que sigue sin hogar al terminar (o desde el inicio, si no hubo cadena)
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.mover_unidad(uuid, uuid, text, timestamptz) IS
  'Recorre en cadena la unidad de una salida sin boletos activos al resto del día (misma ruta): cada salida más tarde recibe la unidad de la anterior, la que tenía pasa al siguiente eslabón, hasta un hueco o el fin del día. Cancela la salida donante. Nunca cruza de día. El mapa es del conductor, no de la unidad (0074): no exige boletos vacíos en los eslabones intermedios. Independiente del conductor. Cualquier rol operativo (filtrado por la API).';


-- 6. `core.marcar_en_ruta` — ya no recibe conductor. Asignarlo pasa por
--    `core.cambiar_conductor` (`POST /:id/conductor`, antes del manifiesto);
--    hacerlo aquí con un UPDATE directo se saltaba esa validación por completo.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.marcar_en_ruta(uuid, uuid, uuid, timestamptz);

CREATE FUNCTION core.marcar_en_ruta(
  p_salida_id     uuid,
  p_usuario_id    uuid,
  p_ahora         timestamptz DEFAULT now()
)
RETURNS TABLE (salida_id uuid, estado text, salida_real_en timestamptz)
LANGUAGE plpgsql AS $$
DECLARE v_estado text;
BEGIN
  SELECT s.estado INTO v_estado FROM core.salida s WHERE s.id = p_salida_id AND s.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado <> 'programada' THEN
    RAISE EXCEPTION 'la salida % está % : no se puede marcar en ruta', p_salida_id, v_estado;
  END IF;

  INSERT INTO core.evento_salida (salida_id, tipo, ocurrido_en, registrado_por)
  VALUES (p_salida_id, 'en_ruta', p_ahora, p_usuario_id);

  UPDATE core.salida
     SET estado         = 'en_ruta',
         salida_real_en  = p_ahora
   WHERE id = p_salida_id;

  RETURN QUERY SELECT p_salida_id, 'en_ruta'::text, p_ahora;
END $$;

COMMENT ON FUNCTION core.marcar_en_ruta(uuid, uuid, timestamptz) IS
  'Marca una salida en ruta (hora del sistema). Bloquea la venta. El conductor se asigna aparte, antes del manifiesto (core.cambiar_conductor, 0074). F7.';


-- 7. `core.salidas_del_dia` — gana `ruta_id` y `unidad`/`unidad_id`, para que la
--    pantalla Viajes pueda ofrecer a qué horario recorrer una unidad (mismo
--    día, misma ruta, sin unidad, más tarde) sin una consulta aparte.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.salidas_del_dia(date, uuid);

CREATE FUNCTION core.salidas_del_dia(
  p_fecha       date,
  p_sucursal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  salida_id    uuid,
  horario_id   uuid,
  ruta_id      uuid,
  estado       text,
  hora_salida  timestamptz,
  origen       text,
  destino      text,
  conductor    text,
  unidad_id    uuid,
  unidad       text,
  boletos      integer
)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.horario_id, h.ruta_id, s.estado,
         spo.hora_paso_programada,
         puo.nombre,
         pud.nombre,
         s.conductor_nombre_snapshot,
         s.unidad_id,
         u.numero_economico,
         (SELECT count(*)::int FROM core.boleto b
           WHERE b.salida_id = s.id AND b.activo AND b.estado <> 'cancelado')
    FROM core.salida s
    JOIN core.horario h ON h.id = s.horario_id
    JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = 0
    JOIN core.punto_ruta puo ON puo.id = spo.punto_id
    JOIN core.salida_parada spd ON spd.salida_id = s.id
     AND spd.orden = (SELECT max(orden) FROM core.salida_parada WHERE salida_id = s.id)
    JOIN core.punto_ruta pud ON pud.id = spd.punto_id
    LEFT JOIN core.unidad u ON u.id = s.unidad_id
   WHERE s.activo
     AND s.fecha_operacion = p_fecha
     AND (p_sucursal_id IS NULL OR puo.sucursal_id = p_sucursal_id)
   ORDER BY spo.hora_paso_programada
$$;

COMMENT ON FUNCTION core.salidas_del_dia(date, uuid) IS
  'Listado de viajes del día para el módulo de viajes efectuados: solo los que SALEN de la sucursal activa (parada orden 0). Gana ruta_id/unidad (0074, mover_unidad). Origen/destino desde core.punto_ruta. F7 · 05 §4.';
