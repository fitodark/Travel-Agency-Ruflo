-- =============================================================================
-- 0047 · `NOTIFY` al encolar un `print_job`, para imprimir al instante (F5).
-- Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.2
--                  docs/architecture/blueprint.md §1.3 (venta → ticket < 3 s p95)
--
-- El spooler consumía la cola por poll (cada ~10 s), así que un ticket podía
-- tardar hasta 10 s tras la venta — fuera del objetivo de 3 s. Con este trigger,
-- `core.registrar_venta` (y el manifiesto, y la reimpresión) despiertan al
-- spooler en el mismo commit: `pg_notify` entrega el aviso a los `LISTEN` justo
-- cuando la transacción de la venta termina.
--
-- La venta y la impresión siguen desacopladas: el aviso es solo un "corre ya",
-- no una impresión síncrona. Si el spooler está caído, el job queda `pendiente`
-- y el poll de respaldo lo toma cuando vuelve.
--
-- Guardado con `es_nube` igual que el trigger del outbox (0001): en la nube no
-- hay spooler y `pg_notify` sería ruido.
-- =============================================================================

CREATE OR REPLACE FUNCTION core.trg_print_job_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT es_nube FROM sync.nodo WHERE singleton) THEN
    RETURN NEW;
  END IF;
  IF NEW.estado = 'pendiente' AND NEW.activo THEN
    -- El payload (sucursal) no lo necesita el spooler —procesa todas—, pero
    -- sirve para el log y para un filtro futuro.
    PERFORM pg_notify('print_job_nuevo', NEW.sucursal_id::text);
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION core.trg_print_job_notify() IS
  'Avisa al spooler (LISTEN print_job_nuevo) al encolar un job. Se salta en la nube.';

CREATE OR REPLACE TRIGGER trg_print_job_notify
  AFTER INSERT ON core.print_job
  FOR EACH ROW EXECUTE FUNCTION core.trg_print_job_notify();
