-- =============================================================================
-- 0015 · Registro de respaldos locales.
-- Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §2 (R2)
--
-- R2 es el riesgo crítico del proyecto: una sola PC por sucursal, y en su disco
-- las ventas que todavía no sincronizaron. El respaldo local es la única defensa
-- real, así que su antigüedad tiene que ser observable desde el tablero: una
-- terminal que dejó de respaldar hace tres días es tan urgente como una que dejó
-- de sincronizar.
--
-- `src/backup/run.ts` escribe una fila aquí tras cada respaldo exitoso; el
-- reporte de salud (`src/sync/salud.ts`) lee el más reciente. Es una tabla de
-- solo-anexar: NO tiene columnas de sync ni `registrar_entidad`, no se replica y
-- no baja de la nube — cada nodo tiene su propia historia de respaldos.
-- =============================================================================

CREATE TABLE sync.respaldo (
  id              uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  sucursal_id     uuid,
  archivo         text NOT NULL,
  bytes           bigint NOT NULL,
  version_esquema text,
  creado_en       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX respaldo_reciente_idx ON sync.respaldo (creado_en DESC);
