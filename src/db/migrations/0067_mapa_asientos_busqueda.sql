-- =============================================================================
-- 0067 · `core.buscar_salidas` expone el mapa de asientos de la unidad.
--        Cierra el pendiente de F4 "mapa visual de asientos en el paso 3": el
--        prototipo del cliente ya llegó (Claude Design) y usa el layout real
--        (fila/col/pasillo) que ya vive en `core.salida.mapa_snapshot` (D-7)
--        desde 0018 — antes NUNCA salía de la base, la SPA solo veía
--        `asientos_ofrecibles` (la lista plana de números disponibles).
--
-- QUÉ CAMBIA. `core.buscar_salidas` gana una columna `mapa jsonb` = el
-- `mapa_snapshot` congelado de la salida (versión, filas, columnas, pasillo,
-- accesos, `asientos[].{num,fila,col,tipo,vendible}`). La SPA ya tiene
-- `asientos_ofrecibles` para saber qué puede vender; con `mapa` puede colocar
-- cada asiento en su celda real y dibujar disponible/ocupado/seleccionado en
-- vez de la lista plana actual. DROP + CREATE por el `RETURNS TABLE` (patrón
-- 0043/0051).
-- =============================================================================

DROP FUNCTION IF EXISTS core.buscar_salidas(date, uuid, uuid, integer, uuid, boolean, timestamptz);

CREATE FUNCTION core.buscar_salidas(
  p_fecha               date,
  p_origen              uuid,
  p_destino             uuid,
  p_n_personas          integer,
  p_sucursal_vendedora  uuid,
  p_con_conexion        boolean DEFAULT true,
  p_ahora               timestamptz DEFAULT now()
)
RETURNS TABLE (
  salida_id          uuid,
  horario_id         uuid,
  fecha_operacion    date,
  hora_salida_origen timestamptz,
  origen_orden       smallint,
  destino_orden      smallint,
  estado             text,
  cierre_venta_en    timestamptz,
  importe            numeric,
  asientos_ofrecibles smallint[],
  disponibles        integer,
  seleccionable      boolean,
  ruta_nombre        text,
  origen_nombre      text,
  destino_nombre     text,
  escalas            text[],
  tarifas            jsonb,
  mapa               jsonb
)
LANGUAGE sql STABLE AS $$
  SELECT s.id,
         s.horario_id,
         s.fecha_operacion,
         spo.hora_paso_programada,
         spo.orden,
         spd.orden,
         s.estado,
         spo.cierre_venta_en,
         t.importe,
         ofr.asientos,
         cardinality(ofr.asientos),
         s.estado = 'programada'
           AND spo.cierre_venta_en > p_ahora
           AND cardinality(ofr.asientos) >= p_n_personas,
         r.nombre,
         puo.nombre,
         pud.nombre,
         COALESCE((
           SELECT array_agg(pux.nombre ORDER BY spx.orden)
             FROM core.salida_parada spx
             JOIN core.punto_ruta pux ON pux.id = spx.punto_id
            WHERE spx.salida_id = s.id
              AND spx.orden > spo.orden
              AND spx.orden < spd.orden
         ), ARRAY[]::text[]),
         COALESCE((
           SELECT jsonb_object_agg(x.categoria_pasajero, x.importe)
             FROM (
               SELECT DISTINCT ON (t2.categoria_pasajero)
                      t2.categoria_pasajero, t2.importe
                 FROM core.v_tarifa_vigente t2
                WHERE t2.ruta_id = h.ruta_id
                  AND t2.parada_origen_orden = spo.orden
                  AND t2.parada_destino_orden = spd.orden
                ORDER BY t2.categoria_pasajero, t2.effective_from DESC
             ) x
         ), '{}'::jsonb),
         s.mapa_snapshot
    FROM core.salida s
    JOIN core.salida_parada spo
      ON spo.salida_id = s.id AND spo.punto_id = p_origen
    JOIN core.salida_parada spd
      ON spd.salida_id = s.id AND spd.punto_id = p_destino
    JOIN core.horario h ON h.id = s.horario_id
    JOIN core.ruta    r ON r.id = h.ruta_id
    JOIN core.ruta_parada rpo
      ON rpo.ruta_id = h.ruta_id AND rpo.punto_id = p_origen
     AND rpo.permite_ascenso AND rpo.activo
    JOIN core.punto_ruta puo ON puo.id = p_origen
    JOIN core.punto_ruta pud ON pud.id = p_destino
    LEFT JOIN core.v_tarifa_vigente t
      ON t.ruta_id = h.ruta_id
     AND t.parada_origen_orden = spo.orden
     AND t.parada_destino_orden = spd.orden
     AND t.categoria_pasajero = 'general'
    CROSS JOIN LATERAL (
      SELECT core.asientos_ofrecibles(
        s.id, spo.orden, spd.orden, p_sucursal_vendedora, p_con_conexion, p_ahora
      ) AS asientos
    ) ofr
   WHERE s.activo
     AND h.activo
     AND r.activo
     AND s.fecha_operacion = p_fecha
     AND s.estado = 'programada'
     AND spo.orden < spd.orden
   ORDER BY spo.hora_paso_programada, r.nombre
$$;

COMMENT ON FUNCTION core.buscar_salidas(date, uuid, uuid, integer, uuid, boolean, timestamptz) IS
  'Paso 2 del flujo de venta: salidas del día origen→destino (origen/destino = core.punto_ruta.id) con ruta, escalas, disponibilidad, tarifa general (columna `importe`), el mapa `tarifas` {categoria: importe} y el `mapa` de asientos congelado (fila/col/pasillo) para el mapa visual del paso 3. El origen debe permitir ascenso. Blueprint F4 · 05 §4.';
