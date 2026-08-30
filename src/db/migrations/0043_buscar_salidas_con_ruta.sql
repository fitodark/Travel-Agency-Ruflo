-- =============================================================================
-- 0043 · `core.buscar_salidas` devuelve nombre de ruta, origen, destino y escalas.
-- Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F4, paso 2)
--
-- La búsqueda ya filtraba bien (`spd.sucursal_id = p_destino`: el destino SIEMPRE
-- es el que se pidió). Pero devolvía `origen_orden` / `destino_orden` —el índice
-- de la parada DENTRO de cada ruta—, así que el vendedor veía "0,3" y "0,1" para
-- dos salidas al MISMO destino por rutas distintas (una directa, otra con
-- escalas) y parecían destinos diferentes o filas repetidas.
--
-- Ahora devuelve además:
--   ruta_nombre     nombre de la ruta ("HJP - PU FULL")
--   origen_nombre   nombre de la sucursal de origen
--   destino_nombre  nombre de la sucursal de destino
--   escalas         nombres de las paradas INTERMEDIAS entre origen y destino
--
-- con eso la UI muestra "Oaxaca Centro → Terminal Dev → Puebla" y las dos salidas
-- de las 07:00 dejan de parecer la misma.
--
-- Y filtra `h.activo`: si un horario se dio de baja, sus salidas ya
-- materializadas NO deben poder venderse. (`darDeBajaHorario` además las cancela;
-- este filtro cubre el caso de datos anteriores a esa corrección.)
-- =============================================================================

-- El `RETURNS TABLE` cambia de forma: hay que soltar y recrear.
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
  escalas            text[]
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
         suo.nombre,
         sud.nombre,
         COALESCE((
           SELECT array_agg(su2.nombre ORDER BY spx.orden)
             FROM core.salida_parada spx
             JOIN core.sucursal su2 ON su2.id = spx.sucursal_id
            WHERE spx.salida_id = s.id
              AND spx.orden > spo.orden
              AND spx.orden < spd.orden
         ), ARRAY[]::text[])
    FROM core.salida s
    JOIN core.salida_parada spo
      ON spo.salida_id = s.id AND spo.sucursal_id = p_origen
    JOIN core.salida_parada spd
      ON spd.salida_id = s.id AND spd.sucursal_id = p_destino
    JOIN core.sucursal suo ON suo.id = spo.sucursal_id
    JOIN core.sucursal sud ON sud.id = spd.sucursal_id
    JOIN core.horario h ON h.id = s.horario_id
    JOIN core.ruta    r ON r.id = h.ruta_id
    LEFT JOIN core.v_tarifa_vigente t
      ON t.ruta_id = h.ruta_id
     AND t.parada_origen_orden = spo.orden
     AND t.parada_destino_orden = spd.orden
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
  'Paso 2 del flujo de venta: salidas del día origen→destino con ruta, escalas, disponibilidad por tramo y tarifa. Blueprint F4.';


-- Limpieza puntual: cancela las salidas futuras SIN boletos de horarios que ya
-- estaban dados de baja antes de que `darDeBajaHorario` las cancelara. Es lo que
-- deja duplicados en la búsqueda hoy.
UPDATE core.salida s
   SET estado = 'cancelada'
  FROM core.horario h
 WHERE h.id = s.horario_id
   AND NOT h.activo
   AND s.estado = 'programada'
   AND s.fecha_operacion >= current_date
   AND NOT EXISTS (
     SELECT 1 FROM core.boleto b
      WHERE b.salida_id = s.id AND b.activo AND b.estado <> 'cancelado');
