-- =============================================================================
-- 0085 · Paquetería: impresión del recibo (con QR firmado) y un ticket por bulto.
--        docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P7), Fase D.
--        docs/architecture/04-riesgos-roadmap.md §1 (costura E3).
--
-- REGLAS (PO). Al registrar un envío se imprime:
--   * el RECIBO para el cliente: datos del envío + cobro + QR firmado (HMAC,
--     como el boleto) que también lleva el monto si es por cobrar (REQ-6, R11);
--   * UN TICKET POR BULTO (REQ-8/9): 5 cajas ⇒ 5 tickets "1/5 … 5/5" con
--     destino, destinatario, POR COBRAR si aplica y su propio QR firmado (el
--     escaneo aún no existe; el QR queda preparado). Rollo normal de la Enduro,
--     el vendedor los pega con cinta.
--
-- CAMBIOS
--   1. `core.print_job` += `envio_id` (FK diferible) y `bulto_num`; plantilla
--      'recibo_envio' (la 'etiqueta_paquete' ya estaba prevista desde 0007).
--      Invariante: ambas plantillas ⇔ `envio_id`; la etiqueta ⇔ `bulto_num`.
--   2. `core.snapshot_envio(envio, sucursal)` — datos congelados (el papel no
--      cambia aunque el envío cambie después).
--   3. `core.encolar_impresion_envio` — recibo + N etiquetas, sin duplicar.
--   4. `core.reimprimir_envio` — recibo, todas las etiquetas o una sola,
--      marcadas como reimpresión con motivo.
--   5. `core.registrar_envio` encola la impresión (DROP + CREATE: gana la
--      columna `print_jobs`). Idéntica a 0084 salvo lo marcado « 0085 ».
--
-- El QR se arma en el spooler (`src/printing/qr-text.ts`, `buildQrEnvio*`) con
-- la misma clave HMAC de la agencia que el boleto (`config_ticket`).
-- =============================================================================


-- 1. `core.print_job`
-- ---------------------------------------------------------------------------
ALTER TABLE core.print_job
  ADD COLUMN envio_id  uuid REFERENCES core.envio(id) DEFERRABLE INITIALLY IMMEDIATE,
  ADD COLUMN bulto_num smallint CHECK (bulto_num IS NULL OR bulto_num BETWEEN 1 AND 99);

ALTER TABLE core.print_job DROP CONSTRAINT print_job_template_key_check;
ALTER TABLE core.print_job ADD CONSTRAINT print_job_template_key_check
  CHECK (template_key IN
    ('boleto','manifiesto_conductor','manifiesto_terminal',
     'corte','etiqueta_paquete','comprobante_reserva','recibo_envio'));

ALTER TABLE core.print_job ADD CONSTRAINT print_job_envio_check
  CHECK (
    (template_key IN ('recibo_envio', 'etiqueta_paquete')) = (envio_id IS NOT NULL)
    AND (template_key = 'etiqueta_paquete') = (bulto_num IS NOT NULL)
  );

CREATE INDEX print_job_envio_idx ON core.print_job (envio_id) WHERE envio_id IS NOT NULL;


-- 2. Snapshot del envío
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.snapshot_envio(p_envio_id uuid, p_sucursal_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'envio_id',              e.id,
    'folio',                 e.folio,
    'remitente_nombre',      e.remitente_nombre,
    'remitente_telefono',    e.remitente_telefono,
    'destinatario_nombre',   e.destinatario_nombre,
    'destinatario_telefono', e.destinatario_telefono,
    'descripcion',           e.descripcion,
    'bultos',                e.bultos,
    'importe',               e.importe,
    'modalidad',             e.modalidad,
    'estado_pago',           es.estado_pago,
    'por_cobrar',            es.por_cobrar,
    'metodo',                (SELECT p.metodo FROM core.pago_envio p
                               WHERE p.envio_id = e.id AND p.activo
                               ORDER BY p.pagado_en DESC LIMIT 1),
    'origen',                so.nombre,
    'origen_direccion',      so.direccion_completa,
    'origen_telefono',       so.telefono_principal,
    'destino',               sd.nombre,
    'destino_direccion',     sd.direccion_completa,
    'destino_telefono',      sd.telefono_principal,
    'fecha_hora_salida',     to_char(spo.hora_paso_programada AT TIME ZONE so.zona_horaria,
                                     'YYYY-MM-DD HH24:MI'),
    'unidad',                un.numero_economico,
    'vendedor',              u.nombre,
    'registrado_en',         to_char(e.registrado_en AT TIME ZONE so.zona_horaria,
                                     'YYYY-MM-DD HH24:MI'),
    'impreso_en_sucursal',   (SELECT nombre FROM core.sucursal WHERE id = p_sucursal_id)
  )
  FROM core.envio e
  JOIN core.v_envio_estado es  ON es.envio_id = e.id
  JOIN core.sucursal so        ON so.id = e.sucursal_origen_id
  JOIN core.sucursal sd        ON sd.id = e.sucursal_destino_id
  JOIN core.usuario u          ON u.id  = e.usuario_id
  JOIN core.salida s           ON s.id  = e.salida_id
  LEFT JOIN core.unidad un     ON un.id = s.unidad_id
  LEFT JOIN core.salida_parada spo
         ON spo.salida_id = s.id AND spo.orden = e.parada_origen_orden
  WHERE e.id = p_envio_id
$$;

COMMENT ON FUNCTION core.snapshot_envio(uuid, uuid) IS
  'P7. Datos congelados de un envío para su recibo y sus tickets por bulto. 0085.';


-- 3. Encolar recibo + un ticket por bulto
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.encolar_impresion_envio(p_envio_id uuid, p_sucursal_id uuid)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_datos  jsonb;
  v_bultos integer;
  v_n      integer := 0;
BEGIN
  -- Idempotente: si ya se encoló el original, no se duplica (reimprimir es aparte).
  IF EXISTS (SELECT 1 FROM core.print_job
              WHERE envio_id = p_envio_id AND NOT es_reimpresion AND activo) THEN
    RETURN 0;
  END IF;

  v_datos := core.snapshot_envio(p_envio_id, p_sucursal_id);
  v_bultos := (v_datos->>'bultos')::int;

  INSERT INTO core.print_job (sucursal_id, template_key, datos, estado, envio_id)
  VALUES (p_sucursal_id, 'recibo_envio', v_datos, 'pendiente', p_envio_id);
  v_n := 1;

  FOR i IN 1..v_bultos LOOP
    INSERT INTO core.print_job (sucursal_id, template_key, datos, estado, envio_id, bulto_num)
    VALUES (p_sucursal_id, 'etiqueta_paquete', v_datos || jsonb_build_object('bulto', i),
            'pendiente', p_envio_id, i);
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END $$;

COMMENT ON FUNCTION core.encolar_impresion_envio(uuid, uuid) IS
  'P7. Encola el recibo y un ticket por bulto (n/N) de un envío, una sola vez. 0085.';


-- 4. Reimprimir
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.reimprimir_envio(
  p_envio_id    uuid,
  p_sucursal_id uuid,
  p_que         text,                -- 'recibo' | 'etiquetas' | 'todo'
  p_motivo      text,
  p_bulto       integer DEFAULT NULL -- con 'etiquetas': solo ese bulto
)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_datos  jsonb;
  v_bultos integer;
  v_n      integer := 0;
BEGIN
  IF p_que NOT IN ('recibo', 'etiquetas', 'todo') THEN
    RAISE EXCEPTION 'qué reimprimir: recibo | etiquetas | todo (llegó %)', p_que;
  END IF;
  IF btrim(COALESCE(p_motivo, '')) = '' THEN
    RAISE EXCEPTION 'la reimpresión necesita un motivo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.envio WHERE id = p_envio_id AND activo) THEN
    RAISE EXCEPTION 'el envío % no existe', p_envio_id;
  END IF;

  v_datos := core.snapshot_envio(p_envio_id, p_sucursal_id);
  v_bultos := (v_datos->>'bultos')::int;
  IF p_bulto IS NOT NULL AND (p_que <> 'etiquetas' OR p_bulto < 1 OR p_bulto > v_bultos) THEN
    RAISE EXCEPTION 'el bulto % no existe en este envío (1 a %)', p_bulto, v_bultos;
  END IF;

  IF p_que IN ('recibo', 'todo') THEN
    INSERT INTO core.print_job (sucursal_id, template_key, datos, estado, envio_id,
                                es_reimpresion, motivo_reimpresion)
    VALUES (p_sucursal_id, 'recibo_envio', v_datos, 'pendiente', p_envio_id, true, btrim(p_motivo));
    v_n := v_n + 1;
  END IF;

  IF p_que IN ('etiquetas', 'todo') THEN
    FOR i IN 1..v_bultos LOOP
      CONTINUE WHEN p_bulto IS NOT NULL AND i <> p_bulto;
      INSERT INTO core.print_job (sucursal_id, template_key, datos, estado, envio_id, bulto_num,
                                  es_reimpresion, motivo_reimpresion)
      VALUES (p_sucursal_id, 'etiqueta_paquete', v_datos || jsonb_build_object('bulto', i),
              'pendiente', p_envio_id, i, true, btrim(p_motivo));
      v_n := v_n + 1;
    END LOOP;
  END IF;

  RETURN v_n;
END $$;

COMMENT ON FUNCTION core.reimprimir_envio(uuid, uuid, text, text, integer) IS
  'P7. Reimprime el recibo, todas las etiquetas o una (n/N) de un envío, como reimpresión con motivo. 0085.';


-- 5. `core.registrar_envio` — encola la impresión (0084 + « 0085 »)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.registrar_envio(uuid, uuid, uuid, uuid, text, text, text, text, text, integer, numeric, text, jsonb, timestamptz);

CREATE FUNCTION core.registrar_envio(
  p_salida_id             uuid,
  p_sucursal_origen_id    uuid,
  p_usuario_id            uuid,
  p_sucursal_destino_id   uuid,
  p_remitente_nombre      text,
  p_remitente_telefono    text,
  p_destinatario_nombre   text,
  p_destinatario_telefono text,
  p_descripcion           text,
  p_bultos                integer,
  p_importe               numeric,
  p_modalidad             text,
  p_pago                  jsonb       DEFAULT NULL,   -- {metodo, efectivo_recibido?, referencia?, corte_caja_id?}
  p_ahora                 timestamptz DEFAULT now()
)
RETURNS TABLE (envio_id uuid, folio text, estado_pago text, pago_envio_id uuid,
               print_jobs integer)   -- 0085
LANGUAGE plpgsql AS $function$
DECLARE
  v_estado      text;
  v_o_orden     integer;
  v_o_hora      timestamptz;
  v_d_orden     integer;
  v_cierre_min  integer;
  v_metodo      text;
  v_recibido    numeric;
  v_corte       uuid;
  v_folio       char(6);
  v_envio       uuid;
  v_pago        uuid;
  v_pj          integer;   -- 0085
BEGIN
  IF sync.replicando() THEN
    RAISE EXCEPTION 'core.registrar_envio no se ejecuta durante la replicación';
  END IF;

  IF p_modalidad NOT IN ('pagado', 'por_cobrar') THEN
    RAISE EXCEPTION 'modalidad de envío inválida: % (pagado | por_cobrar)', p_modalidad;
  END IF;
  IF p_importe IS NULL OR p_importe <= 0 THEN
    RAISE EXCEPTION 'el importe del envío debe ser mayor a $0';
  END IF;
  IF p_bultos IS NULL OR p_bultos < 1 OR p_bultos > 99 THEN
    RAISE EXCEPTION 'el número de bultos va de 1 a 99';
  END IF;
  IF btrim(COALESCE(p_remitente_nombre, '')) = '' OR btrim(COALESCE(p_remitente_telefono, '')) = ''
     OR btrim(COALESCE(p_destinatario_nombre, '')) = '' OR btrim(COALESCE(p_destinatario_telefono, '')) = ''
     OR btrim(COALESCE(p_descripcion, '')) = '' THEN
    RAISE EXCEPTION 'faltan datos del envío: remitente, destinatario (nombre y celular) y descripción son obligatorios';
  END IF;

  SELECT s.estado INTO v_estado FROM core.salida s WHERE s.id = p_salida_id AND s.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no existe', p_salida_id;
  END IF;

  -- Origen: la terminal de MI sucursal en esta salida.
  SELECT sp.orden, sp.hora_paso_programada INTO v_o_orden, v_o_hora
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
   WHERE sp.salida_id = p_salida_id AND pr.sucursal_id = p_sucursal_origen_id
     AND pr.tipo = 'terminal'
   ORDER BY sp.orden LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la salida % no pasa por la terminal de esta sucursal', p_salida_id;
  END IF;

  -- Destino: una terminal con sistema, después del origen (P1).
  SELECT sp.orden INTO v_d_orden
    FROM core.salida_parada sp
    JOIN core.punto_ruta pr ON pr.id = sp.punto_id
    JOIN core.sucursal su   ON su.id = pr.sucursal_id
   WHERE sp.salida_id = p_salida_id AND pr.sucursal_id = p_sucursal_destino_id
     AND pr.tipo = 'terminal' AND NOT su.sin_sistema AND su.activo
     AND sp.orden > v_o_orden
   ORDER BY sp.orden LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el destino debe ser una terminal con sistema posterior al origen en esta salida';
  END IF;

  IF NOT core.salida_vendible(v_estado, v_o_orden) THEN
    RAISE EXCEPTION 'la salida % está % : ya no recibe envíos aquí', p_salida_id, v_estado;
  END IF;

  v_cierre_min := COALESCE(
    (SELECT (valor)::text::integer FROM core.parametro
      WHERE clave = 'minutos_cierre_paqueteria' AND effective_from <= p_ahora
      ORDER BY effective_from DESC LIMIT 1), 5);
  IF v_o_hora IS NOT NULL AND v_o_hora - make_interval(mins => v_cierre_min) <= p_ahora THEN
    RAISE EXCEPTION 'el registro de envíos para esta salida cerró % minutos antes de su paso (%)',
      v_cierre_min, v_o_hora;
  END IF;

  -- Cobro (P3): pagado ⇒ completo aquí; por cobrar ⇒ nada aquí.
  IF p_modalidad = 'pagado' THEN
    IF p_pago IS NULL THEN
      RAISE EXCEPTION 'un envío pagado se cobra completo al registrarlo';
    END IF;
    v_metodo := p_pago->>'metodo';
    IF v_metodo NOT IN ('efectivo', 'transferencia') THEN
      RAISE EXCEPTION 'método de pago inválido para paquetería: % (efectivo | transferencia)', v_metodo;
    END IF;
    v_recibido := NULLIF(p_pago->>'efectivo_recibido', '')::numeric;
    IF v_recibido IS NOT NULL AND (v_metodo <> 'efectivo' OR v_recibido < p_importe) THEN
      RAISE EXCEPTION 'el efectivo recibido (%) no cubre el importe (%)', v_recibido, p_importe;
    END IF;
    v_corte := COALESCE((p_pago->>'corte_caja_id')::uuid, core.corte_abierto(p_sucursal_origen_id));
    IF v_corte IS NULL THEN
      RAISE EXCEPTION 'abre un corte de caja para cobrar el envío';
    END IF;
  ELSIF p_pago IS NOT NULL THEN
    RAISE EXCEPTION 'un envío por cobrar se paga completo en el destino, no al registrarlo';
  END IF;

  v_folio := core.siguiente_folio(p_sucursal_origen_id);

  INSERT INTO core.envio (folio, salida_id, sucursal_origen_id, sucursal_destino_id,
                          parada_origen_orden, parada_destino_orden, usuario_id,
                          remitente_nombre, remitente_telefono,
                          destinatario_nombre, destinatario_telefono,
                          descripcion, bultos, importe, modalidad, registrado_en)
  VALUES (v_folio, p_salida_id, p_sucursal_origen_id, p_sucursal_destino_id,
          v_o_orden, v_d_orden, p_usuario_id,
          btrim(p_remitente_nombre), btrim(p_remitente_telefono),
          btrim(p_destinatario_nombre), btrim(p_destinatario_telefono),
          btrim(p_descripcion), p_bultos, p_importe, p_modalidad, p_ahora)
  RETURNING id INTO v_envio;

  INSERT INTO core.evento_envio (envio_id, tipo, sucursal_id, usuario_id, ocurrido_en)
  VALUES (v_envio, 'registrado', p_sucursal_origen_id, p_usuario_id, p_ahora);

  IF p_modalidad = 'pagado' THEN
    INSERT INTO core.pago_envio (envio_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                                 metodo, monto, verificado, referencia_transferencia,
                                 efectivo_recibido, efectivo_cambio, pagado_en)
    VALUES (v_envio, p_sucursal_origen_id, v_corte, p_usuario_id,
            v_metodo, p_importe, v_metodo = 'efectivo',
            CASE WHEN v_metodo = 'transferencia' THEN NULLIF(p_pago->>'referencia', '') END,
            v_recibido, v_recibido - p_importe, p_ahora)
    RETURNING id INTO v_pago;
  END IF;

  -- 0085 (P7): recibo + un ticket por bulto, siempre al registrar — también
  -- por cobrar (los tickets van pegados en los bultos) y con transferencia por
  -- confirmar (el recibo lo dice).
  v_pj := core.encolar_impresion_envio(v_envio, p_sucursal_origen_id);

  RETURN QUERY
    SELECT v_envio, v_folio::text, es.estado_pago, v_pago, v_pj
      FROM core.v_envio_estado es WHERE es.envio_id = v_envio;
END $function$;

COMMENT ON FUNCTION core.registrar_envio(uuid, uuid, uuid, uuid, text, text, text, text, text, integer, numeric, text, jsonb, timestamptz) IS
  'P1..P7 (06 §1.2). Registra un envío (0084) y encola su recibo + un ticket por bulto (0085).';
