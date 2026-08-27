-- =============================================================================
-- 0011 · Vistas de configuración vigente para impresión.
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.4 y §3.2
--
-- El blueprint es explícito: "Nadie lee las tablas base directamente; todo el
-- sistema consume las vistas v_*_vigente". `config_ticket` ya traía
-- `effective_from` pero no tenía vista, así que la capa de impresión habría
-- terminado filtrando la vigencia a mano en TypeScript — y esa lógica,
-- duplicada en cada lugar que la consulte, es exactamente como se acaba
-- imprimiendo un ticket con la leyenda que todavía no entra en vigor.
-- =============================================================================


-- Configuración de ticket vigente por agencia.
--
-- `DISTINCT ON` toma la fila con `effective_from` más reciente ya vencido. Un cambio
-- programado para la madrugada convive en la tabla con el actual: viaja desde la nube
-- días antes y se queda esperando, y el nodo lo activa solo con su propio reloj sin
-- necesitar conexión en ese instante.
CREATE OR REPLACE VIEW core.v_config_ticket_vigente AS
SELECT DISTINCT ON (agencia_id) *
  FROM core.config_ticket
 WHERE activo
   AND effective_from <= now()
 ORDER BY agencia_id, effective_from DESC;

COMMENT ON VIEW core.v_config_ticket_vigente IS
  'Leyendas y datos de pie de ticket en vigor ahora. Blueprint §3.2.';


-- Impresora en uso por sucursal.
--
-- No lleva `effective_from` a propósito: la IP de una impresora es hardware presente,
-- no una política que el administrador programe para la madrugada. Si se cambia el
-- equipo, el cambio debe surtir efecto en la siguiente impresión, no al día siguiente.
--
-- El orden garantiza una sola fila por sucursal aunque haya varias configuradas: gana
-- la marcada como predeterminada y, a igualdad, la más recientemente modificada.
CREATE OR REPLACE VIEW core.v_config_impresora_vigente AS
SELECT DISTINCT ON (sucursal_id) *
  FROM core.config_impresora
 WHERE activo
 ORDER BY sucursal_id, es_predeterminada DESC, modificado_en DESC NULLS LAST;

COMMENT ON VIEW core.v_config_impresora_vigente IS
  'Impresora predeterminada activa de cada sucursal. Blueprint §2.1.';
