-- =============================================================================
-- 0020 · Cambio de conductor sobre una salida.
-- Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5.3, §5.4
--                  docs/architecture/01b-consistencia-asientos.md §7
--                  docs/architecture/04-riesgos-roadmap.md §3 (F3, criterios 3 y 4)
--
-- El cambio de conductor es un evento COTIDIANO (enfermedad, cambio de turno).
-- El mapa de asientos NO se resuelve en vivo por el conductor: está congelado en
-- `salida.mapa_snapshot` (D-7). Cambiar el conductor solo cambia el mapa por una
-- operación explícita y validada.
--
-- El invariante NO es "mismo tipo de unidad" (dos unidades del mismo tipo podrían
-- tener mapas distintos). Es:
--   asientos_vendidos(salida)  ⊆ asientos_vendibles(mapa_nuevo)
--   bloques_repartidos(salida) ⊆ bloques(mapa_nuevo)
--
--   Caso 1 · compatible         -> libre; NO toca mapa ni cupos
--   Caso 2 · incompatible       -> bloqueado a vendedor; gerente/admin fuerzan
--                                  CON CONEXIÓN (recalcula mapa y cupos, encola
--                                  los boletos huérfanos); SIN conexión queda
--                                  `pendiente` para la siguiente sync
--   Caso 3 · sin boletos        -> libre; re-materializa mapa y cupos
--   Caso 4 · en_ruta/finalizada -> prohibido
-- =============================================================================

CREATE OR REPLACE FUNCTION core.cambiar_conductor(
  p_salida_id          uuid,
  p_conductor_nuevo_id uuid,
  p_usuario_id         uuid,
  p_con_conexion       boolean DEFAULT true,
  p_motivo             text    DEFAULT NULL
)
RETURNS TABLE (caso smallint, estado text, boletos_afectados integer, cambio_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_sal          record;
  v_rol          text;
  v_cond_ant     uuid;
  v_tipo_ant     uuid;
  v_tipo_nuevo   uuid;
  v_mapa_nuevo   jsonb;
  v_cond_nombre  text;
  v_n_boletos    integer;
  v_vendidos     smallint[];
  v_bloques_rep  text[];
  v_asientos_new smallint[];
  v_bloques_new  text[];
  v_compatible   boolean;
  v_huerfanos    smallint[];
  v_n_huerfanos  integer := 0;
BEGIN
  SELECT s.id, s.estado, s.conductor_id, s.tipo_unidad_id, s.mapa_snapshot, s.horario_id
    INTO v_sal
    FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salida % no existe', p_salida_id;
  END IF;

  -- Caso 4: sobre una salida que ya arrancó, el conductor es dato histórico.
  IF v_sal.estado IN ('en_ruta', 'finalizada') THEN
    RAISE EXCEPTION 'la salida % está % : no se puede cambiar el conductor (caso 4)', p_salida_id, v_sal.estado;
  END IF;
  IF v_sal.estado = 'cancelada' THEN
    RAISE EXCEPTION 'la salida % está cancelada', p_salida_id;
  END IF;

  SELECT u.rol INTO v_rol FROM core.usuario u WHERE u.id = p_usuario_id AND u.activo;
  IF v_rol IS NULL THEN
    RAISE EXCEPTION 'usuario % no existe o está inactivo', p_usuario_id;
  END IF;

  SELECT c.tipo_unidad_id, c.nombre, tu.mapa
    INTO v_tipo_nuevo, v_cond_nombre, v_mapa_nuevo
    FROM core.conductor c
    JOIN core.tipo_unidad tu ON tu.id = c.tipo_unidad_id
   WHERE c.id = p_conductor_nuevo_id AND c.activo;
  IF v_mapa_nuevo IS NULL THEN
    RAISE EXCEPTION 'conductor % no existe, está inactivo, o su tipo de unidad no tiene mapa', p_conductor_nuevo_id;
  END IF;

  v_cond_ant := v_sal.conductor_id;
  v_tipo_ant := v_sal.tipo_unidad_id;

  SELECT count(*)::int INTO v_n_boletos
    FROM core.boleto b WHERE b.salida_id = p_salida_id AND b.estado <> 'cancelado';

  -- ---------------------------------------------------------------------------
  -- Caso 3 — sin boletos vendidos: cambio libre, se re-materializa todo.
  -- ---------------------------------------------------------------------------
  IF v_n_boletos = 0 THEN
    UPDATE core.salida
       SET conductor_id = p_conductor_nuevo_id,
           conductor_nombre_snapshot = v_cond_nombre,
           tipo_unidad_id = v_tipo_nuevo,
           mapa_snapshot  = v_mapa_nuevo
     WHERE id = p_salida_id;

    IF EXISTS (SELECT 1 FROM core.salida_parada WHERE salida_id = p_salida_id) THEN
      PERFORM core.repartir_cupo_offline(p_salida_id);
    END IF;

    INSERT INTO core.cambio_conductor (salida_id, conductor_anterior_id, conductor_nuevo_id,
      tipo_unidad_anterior_id, tipo_unidad_nuevo_id, caso, requirio_autorizacion,
      autorizado_por, boletos_afectados, motivo, estado, aplicado_en)
    VALUES (p_salida_id, v_cond_ant, p_conductor_nuevo_id, v_tipo_ant, v_tipo_nuevo,
            3, false, NULL, 0, p_motivo, 'aplicado', now())
    RETURNING id INTO cambio_id;

    caso := 3; estado := 'aplicado'; boletos_afectados := 0;
    RETURN NEXT; RETURN;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Con boletos: se evalúa la compatibilidad.
  -- ---------------------------------------------------------------------------
  SELECT array_agg(DISTINCT b.asiento_num) INTO v_vendidos
    FROM core.boleto b WHERE b.salida_id = p_salida_id AND b.estado <> 'cancelado';

  SELECT array_agg(DISTINCT b) INTO v_bloques_rep
    FROM core.cupo_offline co, unnest(co.bloques) b WHERE co.salida_id = p_salida_id;
  v_bloques_rep := COALESCE(v_bloques_rep, ARRAY[]::text[]);

  SELECT array_agg((a->>'num')::smallint) INTO v_asientos_new
    FROM jsonb_array_elements(v_mapa_nuevo->'asientos') a
   WHERE COALESCE((a->>'vendible')::boolean, true);

  SELECT array_agg(b->>'clave') INTO v_bloques_new
    FROM jsonb_array_elements(v_mapa_nuevo->'bloques') b;
  v_bloques_new := COALESCE(v_bloques_new, ARRAY[]::text[]);

  v_compatible := (v_vendidos <@ v_asientos_new)
              AND (v_bloques_rep <@ v_bloques_new);

  -- ---------------------------------------------------------------------------
  -- Caso 1 — compatible: NO se toca el mapa ni los cupos.
  -- ---------------------------------------------------------------------------
  IF v_compatible THEN
    IF NOT EXISTS (SELECT 1 FROM core.rol_permiso WHERE rol = v_rol AND permiso = 'conductor.cambiar.compatible') THEN
      RAISE EXCEPTION 'el rol % no puede cambiar el conductor', v_rol;
    END IF;

    UPDATE core.salida
       SET conductor_id = p_conductor_nuevo_id,
           conductor_nombre_snapshot = v_cond_nombre
     WHERE id = p_salida_id;

    INSERT INTO core.cambio_conductor (salida_id, conductor_anterior_id, conductor_nuevo_id,
      tipo_unidad_anterior_id, tipo_unidad_nuevo_id, caso, requirio_autorizacion,
      autorizado_por, boletos_afectados, motivo, estado, aplicado_en)
    VALUES (p_salida_id, v_cond_ant, p_conductor_nuevo_id, v_tipo_ant, v_tipo_nuevo,
            1, false, NULL, 0, p_motivo, 'aplicado', now())
    RETURNING id INTO cambio_id;

    caso := 1; estado := 'aplicado'; boletos_afectados := 0;
    RETURN NEXT; RETURN;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Caso 2 — incompatible.
  -- ---------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM core.rol_permiso WHERE rol = v_rol AND permiso = 'conductor.cambiar.incompatible') THEN
    RAISE EXCEPTION 'cambio de conductor incompatible: bloqueado para el rol % (exige gerente o administrador)', v_rol;
  END IF;

  -- Sin conexión no se puede aplicar con seguridad: otras sucursales tienen
  -- cupos vigentes sobre asientos que podrían dejar de existir.
  IF NOT p_con_conexion THEN
    INSERT INTO core.cambio_conductor (salida_id, conductor_anterior_id, conductor_nuevo_id,
      tipo_unidad_anterior_id, tipo_unidad_nuevo_id, caso, requirio_autorizacion,
      autorizado_por, boletos_afectados, motivo, estado, aplicado_en)
    VALUES (p_salida_id, v_cond_ant, p_conductor_nuevo_id, v_tipo_ant, v_tipo_nuevo,
            2, true, p_usuario_id, 0, p_motivo, 'pendiente', NULL)
    RETURNING id INTO cambio_id;

    caso := 2; estado := 'pendiente'; boletos_afectados := 0;
    RETURN NEXT; RETURN;
  END IF;

  -- Con conexión: se fuerza. Recalcula mapa y cupos, encola los huérfanos.
  UPDATE core.salida
     SET conductor_id = p_conductor_nuevo_id,
         conductor_nombre_snapshot = v_cond_nombre,
         tipo_unidad_id = v_tipo_nuevo,
         mapa_snapshot  = v_mapa_nuevo
   WHERE id = p_salida_id;

  SELECT array_agg(x.asiento_num) INTO v_huerfanos
    FROM (SELECT DISTINCT b.asiento_num FROM core.boleto b
           WHERE b.salida_id = p_salida_id AND b.estado <> 'cancelado') x
   WHERE x.asiento_num <> ALL (v_asientos_new);
  v_n_huerfanos := COALESCE(array_length(v_huerfanos, 1), 0);

  IF v_n_huerfanos > 0 THEN
    -- Los boletos huérfanos entran en la cola de reasignación (01b §7): se
    -- marcan en conflicto y se abre excepción crítica por sucursal emisora. La
    -- propuesta de asiento nuevo la resuelve F4.
    UPDATE core.boleto SET estado = 'conflicto_sobreventa'
     WHERE core.boleto.salida_id = p_salida_id AND core.boleto.estado <> 'cancelado'
       AND core.boleto.asiento_num = ANY (v_huerfanos);

    UPDATE core.asiento_ocupacion SET estado = 'conflicto'
     WHERE core.asiento_ocupacion.salida_id = p_salida_id
       AND core.asiento_ocupacion.asiento_num = ANY (v_huerfanos)
       AND core.asiento_ocupacion.estado = 'firme';

    INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, entidad, entidad_id, detalle)
    SELECT 'mapa_incompatible', 'critica', v.sucursal_venta_id, 'core.boleto', b.id,
           jsonb_build_object('salida_id', p_salida_id, 'asiento_num', b.asiento_num,
                              'motivo', 'cambio de conductor a un mapa sin ese asiento')
      FROM core.boleto b JOIN core.venta v ON v.id = b.venta_id
     WHERE b.salida_id = p_salida_id AND b.estado = 'conflicto_sobreventa'
       AND b.asiento_num = ANY (v_huerfanos);
  END IF;

  IF EXISTS (SELECT 1 FROM core.salida_parada WHERE salida_id = p_salida_id) THEN
    PERFORM core.repartir_cupo_offline(p_salida_id);
  END IF;

  INSERT INTO core.cambio_conductor (salida_id, conductor_anterior_id, conductor_nuevo_id,
    tipo_unidad_anterior_id, tipo_unidad_nuevo_id, caso, requirio_autorizacion,
    autorizado_por, boletos_afectados, motivo, estado, aplicado_en)
  VALUES (p_salida_id, v_cond_ant, p_conductor_nuevo_id, v_tipo_ant, v_tipo_nuevo,
          2, true, p_usuario_id, v_n_huerfanos, p_motivo, 'aplicado', now())
  RETURNING id INTO cambio_id;

  caso := 2; estado := 'aplicado'; boletos_afectados := v_n_huerfanos;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.cambiar_conductor(uuid, uuid, uuid, boolean, text) IS
  'Cambia el conductor de una salida aplicando la regla de compatibilidad de mapa (02 §5.3).';
