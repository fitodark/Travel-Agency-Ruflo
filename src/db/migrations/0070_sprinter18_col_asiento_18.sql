-- =============================================================================
-- 0070 · Corrige la columna del asiento 18 en el mapa de la Sprinter 18 plazas.
--        knowledge/seat-map/ (export real de diseño, Ses. 69) — el asiento 18
--        va del lado del PASILLO (junto al chofer, no junto a la ventana).
--
-- QUÉ CAMBIA. El seed `0001_tipo_unidad_sprinter18.sql` (fuente:
-- `knowledge/esquema.JPG`) puso el 18 en `col: 0` (lado ventana, junto al
-- chofer). El nuevo export de diseño (`knowledge/seat-map/`, mapa más fiel a
-- la unidad real, confirmado con el cliente) lo ubica en `col: 2` — es decir,
-- en la fila del frente el orden real es: chofer, hueco de acceso, 18, 1.
-- Es el ÚNICO cambio: el resto de `asientos`/`bloques`/`accesos` ya coincide
-- con el layout de diseño (verificado asiento por asiento).
--
-- El número de asiento no cambia — solo dónde se dibuja — así que no afecta
-- folios, importes ni boletos ya emitidos, solo el mapa visual del paso 3.
--
-- Se corrige `core.tipo_unidad.mapa` (rige toda materialización futura) y se
-- reescribe `mapa_snapshot` SOLO en las salidas `programada` (aún no salen a
-- ruta): las `en_ruta`/`finalizada`/`canceladas` quedan congeladas tal como
-- las vio el manifiesto impreso, por diseño (D7, "el mapa se congela al
-- materializar").
-- =============================================================================

UPDATE core.tipo_unidad
   SET mapa = jsonb_set(
     mapa,
     '{asientos}',
     (
       SELECT jsonb_agg(
         CASE WHEN a->>'num' = '18' THEN jsonb_set(a, '{col}', '2')
              ELSE a END
       )
       FROM jsonb_array_elements(mapa->'asientos') AS a
     )
   )
 WHERE clave = 'SPRINTER-18';

UPDATE core.salida s
   SET mapa_snapshot = jsonb_set(
     s.mapa_snapshot,
     '{asientos}',
     (
       SELECT jsonb_agg(
         CASE WHEN a->>'num' = '18' THEN jsonb_set(a, '{col}', '2')
              ELSE a END
       )
       FROM jsonb_array_elements(s.mapa_snapshot->'asientos') AS a
     )
   )
  FROM core.tipo_unidad tu
 WHERE tu.id = s.tipo_unidad_id
   AND tu.clave = 'SPRINTER-18'
   AND s.estado = 'programada';
