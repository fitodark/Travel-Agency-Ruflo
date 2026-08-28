-- =============================================================================
-- 0022 · Leases de asiento — flexibilidad cuando SÍ hay conexión.
-- Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §5
--                  docs/architecture/04-riesgos-roadmap.md §3 (F4, paso 3)
--
-- Con conexión, una sucursal puede vender CUALQUIER asiento libre, incluidos los
-- del cupo de otra. Para hacerlo pide un lease: una reserva de capacidad de 15
-- min (parámetro `minutos_lease`) que la misma restricción de exclusión de
-- `core.asiento_lease` protege contra ocupaciones firmes y otros leases vivos.
--
-- Propiedad clave (01b §5): si el internet se cae DESPUÉS de conceder el lease,
-- la venta se completa igual — el nodo lo tiene guardado y es válido hasta
-- expirar. Un lease NO genera folio ni movimiento de caja.
--
-- La constraint de exclusión de la tabla NO mira `expira_en`; su predicado es
-- `consumido_por_boleto_id IS NULL AND liberado_en IS NULL`. Por eso un lease
-- vencido pero no liberado todavía bloquearía un lease nuevo: `adquirir_lease`
-- libera primero los vencidos de ese asiento, y `barrer_leases_expirados` hace
-- la limpieza periódica global.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Pide un lease. Devuelve el estado como DATO, no como excepción: "el asiento ya
-- se tomó" es un desenlace normal del flujo (la UI refresca el mapa), no un
-- error. Solo lanza ante entradas imposibles: salida inexistente o no
-- programada, asiento inexistente/no vendible, tramo inválido.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.adquirir_lease(
  p_salida_id    uuid,
  p_asiento_num  smallint,
  p_desde        integer,
  p_hasta        integer,
  p_sucursal_id  uuid,
  p_duracion_seg integer     DEFAULT NULL,
  p_ahora        timestamptz DEFAULT now()
)
RETURNS TABLE (estado text, lease_id uuid, expira_en timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_estado_salida text;
  v_n_tramos      integer;
  v_dur_seg       integer;
  v_id            uuid;
  v_exp           timestamptz;
BEGIN
  SELECT s.estado INTO v_estado_salida FROM core.salida s WHERE s.id = p_salida_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;
  IF v_estado_salida <> 'programada' THEN
    RAISE EXCEPTION 'la salida % está % : no se puede reservar asiento', p_salida_id, v_estado_salida;
  END IF;

  SELECT count(*)::int INTO v_n_tramos
    FROM core.salida_parada WHERE salida_id = p_salida_id;
  IF p_desde < 0 OR p_hasta <= p_desde OR p_hasta > v_n_tramos - 1 THEN
    RAISE EXCEPTION 'tramo [%,%) fuera de la ruta de la salida % (% paradas)',
      p_desde, p_hasta, p_salida_id, v_n_tramos;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM core.salida s
      CROSS JOIN LATERAL jsonb_array_elements(s.mapa_snapshot->'asientos') e
     WHERE s.id = p_salida_id
       AND (e->>'num')::smallint = p_asiento_num
       AND COALESCE((e->>'vendible')::boolean, true)
  ) THEN
    RAISE EXCEPTION 'el asiento % no existe o no es vendible en la salida %', p_asiento_num, p_salida_id;
  END IF;

  -- Limpia leases vencidos de ESTE asiento para que no bloqueen por la constraint.
  -- Alias `al`: el OUT param `expira_en` haría ambigua la columna sin calificar.
  UPDATE core.asiento_lease AS al
     SET liberado_en = al.expira_en
   WHERE al.salida_id = p_salida_id
     AND al.asiento_num = p_asiento_num
     AND al.consumido_por_boleto_id IS NULL
     AND al.liberado_en IS NULL
     AND al.expira_en <= p_ahora;

  -- Ocupación firme que solapa: el asiento está vendido, no se puede reservar.
  IF EXISTS (
    SELECT 1 FROM core.asiento_ocupacion o
     WHERE o.salida_id = p_salida_id
       AND o.asiento_num = p_asiento_num
       AND o.estado = 'firme'
       AND o.tramos && int4range(p_desde, p_hasta)
  ) THEN
    estado := 'ocupado'; RETURN NEXT; RETURN;
  END IF;

  v_dur_seg := COALESCE(
    p_duracion_seg,
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_lease' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1) * 60,
    900);
  v_exp := p_ahora + make_interval(secs => v_dur_seg);

  BEGIN
    INSERT INTO core.asiento_lease
      (salida_id, asiento_num, tramos, sucursal_id, otorgado_en, expira_en)
    VALUES
      (p_salida_id, p_asiento_num, int4range(p_desde, p_hasta), p_sucursal_id,
       p_ahora, v_exp)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    -- Otro lease vivo ya cubre este asiento en un tramo que solapa.
    estado := 'lease_ajeno'; RETURN NEXT; RETURN;
  END;

  estado := 'otorgado'; lease_id := v_id; expira_en := v_exp;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION core.adquirir_lease(uuid, smallint, integer, integer, uuid, integer, timestamptz) IS
  'Pide un lease de asiento (paso 3 con conexión). Devuelve otorgado/ocupado/lease_ajeno. Blueprint 01b §5.';


-- -----------------------------------------------------------------------------
-- Libera un lease no consumido. Idempotente: devuelve si cambió algo.
-- El nodo la llama al cancelar el flujo, como optimización — un lease no
-- liberado expira solo de todas formas.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.liberar_lease(
  p_lease_id uuid,
  p_ahora    timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  UPDATE core.asiento_lease
     SET liberado_en = p_ahora
   WHERE id = p_lease_id
     AND consumido_por_boleto_id IS NULL
     AND liberado_en IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

COMMENT ON FUNCTION core.liberar_lease(uuid, timestamptz) IS
  'Libera un lease no consumido. Idempotente. Blueprint 01b §5.';


-- -----------------------------------------------------------------------------
-- Marca como liberados todos los leases vencidos no consumidos. Barrido
-- periódico (lo dispara el motor de sync). `liberado_en = expira_en`: el lease
-- dejó de valer en el instante en que venció, no cuando se barrió.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.barrer_leases_expirados(
  p_ahora timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  UPDATE core.asiento_lease
     SET liberado_en = expira_en
   WHERE consumido_por_boleto_id IS NULL
     AND liberado_en IS NULL
     AND expira_en <= p_ahora;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

COMMENT ON FUNCTION core.barrer_leases_expirados(timestamptz) IS
  'Libera los leases vencidos no consumidos. Barrido periódico del motor de sync.';


-- -----------------------------------------------------------------------------
-- Ata un lease vivo a un boleto recién emitido. La usa `registrar_venta` (F4
-- slice 3). Devuelve false si el lease ya venció o se liberó: ahí el llamador
-- decide (re-pedir, o vender directo si el asiento es de su cupo).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.consumir_lease(
  p_lease_id  uuid,
  p_boleto_id uuid,
  p_ahora     timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  UPDATE core.asiento_lease
     SET consumido_por_boleto_id = p_boleto_id
   WHERE id = p_lease_id
     AND consumido_por_boleto_id IS NULL
     AND liberado_en IS NULL
     AND expira_en > p_ahora;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

COMMENT ON FUNCTION core.consumir_lease(uuid, uuid, timestamptz) IS
  'Ata un lease vivo a un boleto emitido. Usada por registrar_venta (F4 slice 3).';
