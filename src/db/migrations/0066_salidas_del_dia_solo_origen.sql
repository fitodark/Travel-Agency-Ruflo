-- =============================================================================
-- 0066 · El módulo de Viajes lista SOLO los viajes que salen de la sucursal
--        activa (parada de origen), no los que apenas pasan por ella.
--        docs/architecture/03-auth-impresion-config.md §2.5 · requerimiento §"Módulo
--        de viajes efectuados" ("la terminal ORIGEN" imprime el manifiesto y marca
--        el abordaje).
--
-- QUÉ CAMBIA. `core.salidas_del_dia` filtraba por "la sucursal es CUALQUIER
-- parada de la ruta" (`EXISTS ... salida_parada`), así que una terminal veía
-- también los viajes que solo la cruzan para ascenso/descenso — QA los reportó
-- como "viajes de otras sucursales". Ahora el filtro es: **la sucursal activa es
-- la terminal de origen del viaje** (`salida_parada.orden = 0`).
--
-- Un vendedor está asignado a una sola sucursal y esa manda: el listado no
-- mezcla viajes de otras terminales.
--
-- SIN CAMBIO DE FIRMA: `CREATE OR REPLACE`, misma `RETURNS TABLE`. Única
-- diferencia con 0053 es la condición del `WHERE` marcada « 0066 ». Sin datos
-- que migrar.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.salidas_del_dia(
  p_fecha       date,
  p_sucursal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  salida_id    uuid,
  horario_id   uuid,
  estado       text,
  hora_salida  timestamptz,
  origen       text,
  destino      text,
  conductor    text,
  boletos      integer
)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.horario_id, s.estado,
         spo.hora_paso_programada,
         puo.nombre,
         pud.nombre,
         s.conductor_nombre_snapshot,
         (SELECT count(*)::int FROM core.boleto b
           WHERE b.salida_id = s.id AND b.activo AND b.estado <> 'cancelado')
    FROM core.salida s
    JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = 0
    JOIN core.punto_ruta puo ON puo.id = spo.punto_id
    JOIN core.salida_parada spd ON spd.salida_id = s.id
     AND spd.orden = (SELECT max(orden) FROM core.salida_parada WHERE salida_id = s.id)
    JOIN core.punto_ruta pud ON pud.id = spd.punto_id
   WHERE s.activo
     AND s.fecha_operacion = p_fecha
     -- 0066: SOLO los viajes cuya terminal de origen es la sucursal activa.
     AND (p_sucursal_id IS NULL OR puo.sucursal_id = p_sucursal_id)
   ORDER BY spo.hora_paso_programada
$$;

COMMENT ON FUNCTION core.salidas_del_dia(date, uuid) IS
  'Listado de viajes del día para el módulo de viajes efectuados: solo los que SALEN de la sucursal activa (parada orden 0). Origen/destino desde core.punto_ruta. F7 · 05 §4 (0066).';
