-- =============================================================================
-- 0009 · Autenticación local offline y vistas derivadas del dominio.
--
-- Supabase Auth (GoTrue) valida contra un endpoint HTTP en la nube: sin internet
-- no hay login, y ninguna configuración lo cambia. El requerimiento exige
-- explícitamente que la autenticación siga funcionando contra la base local
-- durante una desconexión, así que el IdP de la operación es propio.
-- Supabase Auth se usa solo para el dashboard del administrador en la nube.
--
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1
-- =============================================================================

CREATE TABLE auth_local.credencial (
  usuario_id          uuid PRIMARY KEY,
  -- Se calcula en la NUBE al crear/cambiar la contraseña y se replica como
  -- cualquier dato de clase A. El nodo nunca ve la contraseña en claro salvo en
  -- el instante del login, que valida localmente.
  hash_password       text NOT NULL,
  algoritmo           text NOT NULL DEFAULT 'argon2id',
  debe_cambiar        boolean NOT NULL DEFAULT false,
  hash_actualizado_en timestamptz NOT NULL DEFAULT now(),
  effective_from      timestamptz NOT NULL DEFAULT now(),
  effective_until     timestamptz
);

-- Token opaco, no JWT: siendo todo local no hay ventaja en tokens
-- autocontenidos y sí desventaja (no se pueden revocar).
CREATE TABLE auth_local.sesion (
  id             uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  usuario_id     uuid NOT NULL,
  sucursal_id    uuid NOT NULL,   -- req: se elige sucursal al entrar
  caja_id        text,
  emitida_en     timestamptz NOT NULL DEFAULT now(),
  expira_en      timestamptz NOT NULL,
  cerrada_en     timestamptz,
  cerrada_motivo text
);
CREATE INDEX sesion_viva_idx ON auth_local.sesion (usuario_id)
  WHERE cerrada_en IS NULL;

CREATE TABLE auth_local.intento (
  id         bigserial PRIMARY KEY,
  email      citext,
  exito      boolean NOT NULL,
  ip         inet,
  ocurrido_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intento_reciente_idx ON auth_local.intento (email, ocurrido_en DESC);

-- Revocación fuera de banda (03 §1.5, capa 3): cubre el caso del despido con la
-- sucursal incomunicada. El administrador dicta un código por teléfono y el
-- nodo lo valida offline contra su semilla.
CREATE TABLE auth_local.revocacion_hotp (
  sucursal_id   uuid PRIMARY KEY,
  semilla       bytea NOT NULL,
  ultimo_usado  bigint NOT NULL DEFAULT -1
);


-- =============================================================================
-- VISTAS DERIVADAS
--
-- Regla del blueprint: ningún estado que cruce fronteras de sucursal se guarda
-- como campo mutable; se DERIVA de hechos append-only. Por eso no existe
-- venta.pagado ni boleto.abordo como columnas.
-- =============================================================================

-- Estado económico de la venta. Solo suma pagos activos y verificados: una
-- transferencia sin verificar no es dinero confirmado y no debe afectar al corte
-- ni permitir imprimir el boleto.
CREATE VIEW core.v_venta_saldo AS
SELECT v.id AS venta_id,
       v.importe_total,
       COALESCE(SUM(p.monto) FILTER (
         WHERE p.activo AND (p.metodo = 'efectivo' OR p.verificado)), 0) AS pagado,
       v.importe_total - COALESCE(SUM(p.monto) FILTER (
         WHERE p.activo AND (p.metodo = 'efectivo' OR p.verificado)), 0)
         AS saldo_pendiente
  FROM core.venta v
  LEFT JOIN core.pago p ON p.venta_id = v.id
 WHERE v.activo
 GROUP BY v.id, v.importe_total;

-- Abordaje: el último hecho no anulado manda.
CREATE VIEW core.v_boleto_abordaje AS
SELECT DISTINCT ON (e.boleto_id)
       e.boleto_id, e.abordo, e.registrado_en, e.registrado_por
  FROM core.evento_abordaje e
 WHERE e.activo
   AND NOT EXISTS (SELECT 1 FROM core.evento_abordaje a
                    WHERE a.anula_evento_id = e.id AND a.activo)
 ORDER BY e.boleto_id, e.registrado_en DESC;


-- Saldo del corte de caja. Solo movimientos ACTIVOS: al desactivar un egreso,
-- el monto regresa solo al corte, que es exactamente lo que pide el
-- requerimiento.
CREATE VIEW core.v_corte_saldo AS
SELECT c.id AS corte_caja_id,
       c.saldo_inicial,
       COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='ingreso'), 0) AS ingresos,
       COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='egreso'),  0) AS egresos,
       c.saldo_inicial
         + COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='ingreso'), 0)
         - COALESCE(SUM(m.monto) FILTER (WHERE m.activo AND m.tipo='egreso'),  0)
         AS saldo_calculado
  FROM core.corte_caja c
  LEFT JOIN core.movimiento_caja m ON m.corte_caja_id = c.id
 WHERE c.activo
 GROUP BY c.id, c.saldo_inicial;

-- Req: el gerente SOLO ve los registros activos; el administrador ve activos e
-- inactivos "como parte de su auditoría para visualizar posibles malos manejos".
CREATE VIEW core.v_movimiento_operativo AS
SELECT * FROM core.movimiento_caja WHERE activo;

CREATE VIEW core.v_movimiento_auditoria AS
SELECT * FROM core.movimiento_caja;


-- Disponibilidad de asientos por salida: la consulta más caliente del sistema
-- (pasos 2 y 3 del flujo de venta).
CREATE VIEW core.v_asiento_estado AS
SELECT s.id AS salida_id,
       a.num AS asiento_num,
       o.tramos     AS tramos_ocupados,
       o.boleto_id,
       o.sucursal_id AS ocupado_por_sucursal,
       l.id          AS lease_id,
       l.sucursal_id AS lease_sucursal_id,
       l.expira_en   AS lease_expira_en
  FROM core.salida s
  CROSS JOIN LATERAL (
        SELECT (e->>'num')::smallint AS num
          FROM jsonb_array_elements(s.mapa_snapshot->'asientos') e
         WHERE COALESCE((e->>'vendible')::boolean, true)
  ) a
  LEFT JOIN core.asiento_ocupacion o
         ON o.salida_id = s.id AND o.asiento_num = a.num AND o.estado = 'firme'
  LEFT JOIN core.asiento_lease l
         ON l.salida_id = s.id AND l.asiento_num = a.num
        AND l.consumido_por_boleto_id IS NULL AND l.liberado_en IS NULL
        AND l.expira_en > now()
 WHERE s.activo;


-- =============================================================================
-- ESQUEMA api · contrato con el sistema externo.
--
-- P7 quedó parcialmente respondida: es de SOLO LECTURA, para visualizar
-- reportes. Falta el mecanismo de acceso y los campos exactos, así que estas
-- vistas quedan ANDAMIADAS Y VERSIONADAS pero no congeladas.
--
-- Existen desde el día 1 por una razón concreta: si ese sistema se conectara
-- directo a las tablas de core, cualquier refactor nuestro lo rompería y
-- quedaríamos congelados. Definirlo ahora cuesta un día; después de que ese
-- sistema esté en producción, cuesta una negociación.
-- =============================================================================
CREATE VIEW api.v1_boleto AS
SELECT b.folio, b.pasajero_nombre, b.asiento_num, b.estado,
       so.nombre AS sucursal_origen, sd.nombre AS sucursal_destino,
       sp_o.hora_paso_programada AS fecha_hora_viaje,
       b.importe, v.es_reservacion, b.creado_en
  FROM core.boleto b
  JOIN core.venta  v  ON v.id = b.venta_id
  JOIN core.salida sa ON sa.id = b.salida_id
  JOIN core.salida_parada sp_o
       ON sp_o.salida_id = sa.id AND sp_o.orden = v.parada_origen_orden
  JOIN core.salida_parada sp_d
       ON sp_d.salida_id = sa.id AND sp_d.orden = v.parada_destino_orden
  JOIN core.sucursal so ON so.id = sp_o.sucursal_id
  JOIN core.sucursal sd ON sd.id = sp_d.sucursal_id
 WHERE b.activo;

CREATE VIEW api.v1_corte_caja AS
SELECT c.id, s.nombre AS sucursal, c.saldo_inicial, c.abierto_en, c.cerrado_en,
       c.estado, cs.ingresos, cs.egresos, cs.saldo_calculado,
       c.saldo_final_declarado
  FROM core.corte_caja c
  JOIN core.sucursal s ON s.id = c.sucursal_id
  JOIN core.v_corte_saldo cs ON cs.corte_caja_id = c.id
 WHERE c.activo;
