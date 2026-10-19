-- =============================================================================
-- 0078 · Override LOCAL de emergencia para IP/transporte de impresora.
--        docs/architecture/03-auth-impresion-config.md §2.1 (D-4)
--
-- QA: el administrador inició sesión local pero no pudo corregir la IP de la
-- impresora porque, sin internet, `/admin/*` entero responde 503 (admin.ts:
-- "la terminal NUNCA escribe configuración clase A en su base LOCAL").
--
-- `core.config_impresora` es clase A a propósito (01-sincronizacion.md §1):
-- así un administrador remoto corrige la impresora de una sucursal a horas de
-- distancia sin desplegar nada (D-4, CHANGELOG). D-4 asumió que la impresora
-- "tiene IP fija por su propia configuración" — en teoría no debería cambiar
-- sola. En la práctica puede (reset de fábrica, reemplazo de equipo), y si
-- pasa justo sin internet, el administrador SÍ está físicamente ahí pero no
-- tiene ningún camino para arreglarlo: ni la consola (exige nube) ni una
-- escritura local a `core.config_impresora` (sync/pull.ts: "clase A: el nodo
-- nunca la gana" — el siguiente pull la revertiría en cuanto vuelva la
-- conexión).
--
-- Precedente: el proyecto ya resolvió el mismo tipo de problema para la baja
-- de un usuario con el código HOTP dictado por teléfono (03 §1.5) — un canal
-- de emergencia puramente local para una operación que normalmente exige
-- nube. Esta es la misma idea aplicada a la impresora.
--
-- QUÉ CAMBIA:
--  `core.config_impresora_override_local`: tabla deliberadamente AJENA al
--  sync — no pasa por `core.registrar_entidad` (sin outbox, sin columnas
--  estándar) y no entra en `CLASE_POR_TABLA` (src/sync/clases.ts). Nunca se
--  sube a la nube ni se espera que baje de ella. `cargarConfigImpresora`
--  (src/printing/config.ts) la consulta primero y, si existe, gana sobre la
--  fila replicada. No se autolimpia: cuando vuelve el internet, la fuente de
--  verdad sigue siendo la consola — el administrador debe corregir la IP real
--  ahí (y puede borrar el override desde la pantalla local si quiere).
-- =============================================================================

CREATE TABLE core.config_impresora_override_local (
  impresora_id    uuid PRIMARY KEY
                  REFERENCES core.config_impresora(id) ON DELETE CASCADE
                  DEFERRABLE INITIALLY IMMEDIATE,
  transporte      text NOT NULL CHECK (transporte IN ('tcp', 'usb')),
  ip              inet,
  puerto          integer,
  usb_nombre_cola text,
  nota            text,
  actualizado_en  timestamptz NOT NULL,
  actualizado_por uuid NOT NULL
                  REFERENCES core.usuario(id)
                  DEFERRABLE INITIALLY IMMEDIATE,
  CHECK ((transporte = 'tcp' AND ip IS NOT NULL)
      OR (transporte = 'usb' AND usb_nombre_cola IS NOT NULL))
);

COMMENT ON TABLE core.config_impresora_override_local IS
  'Override local de emergencia (sin internet) para la IP/transporte de una '
  'impresora. Fuera del sync a propósito: nunca se sube ni se baja.';
