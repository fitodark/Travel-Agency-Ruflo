/**
 * Spooler de impresión: consume `core.print_job` y lo manda al papel (F5).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.1–§2.4
 *
 * F4/F7 encolan `print_job` DENTRO de la transacción de negocio; imprimirlos es
 * este módulo. El flujo por job es:
 *
 *   1. Reclamar  — `UPDATE ... estado='imprimiendo', intentos+1` con
 *      `FOR UPDATE SKIP LOCKED`. Es atómico: si el proceso muere aquí, el job
 *      queda en `imprimiendo` y se recupera en el arranque siguiente.
 *   2. Renderizar — por `template_key`, con el ancho y la code page de la
 *      impresora de esa sucursal.
 *   3. Enviar     — por el transporte que declara `core.config_impresora`.
 *   4. Finalizar  — `impreso` con éxito; si falla, vuelve a `pendiente` hasta
 *      agotar `maxIntentos` y entonces `revision_manual`.
 *
 * Supuesto D-1 (una PC por sucursal): hay UN spooler por terminal. La
 * recuperación de `imprimiendo` al arrancar asume que un `imprimiendo` es un
 * proceso que murió, no otro spooler trabajando. `FOR UPDATE SKIP LOCKED` deja
 * la puerta abierta a varios, pero la recuperación no coordina leases.
 */

import type { Client } from 'pg';
import type { CodePageName } from './escpos/codepage.js';
import {
  cargarConfigImpresora,
  crearTransporte as crearTransporteReal,
  type ConfigImpresoraRow,
} from './config.js';
import { renderManifiesto, type DatosManifiesto } from './templates/manifiesto.js';
import type { EscPosTransport } from './transport/types.js';

/** Templates que el spooler ya sabe renderizar. */
export const TEMPLATES_SOPORTADOS = ['manifiesto_conductor', 'manifiesto_terminal'] as const;

const CODE_PAGES: readonly string[] = ['CP437', 'CP850', 'CP858'];

const aCodePage = (raw: string): CodePageName =>
  CODE_PAGES.includes(raw) ? (raw as CodePageName) : 'CP858';

export interface ContextoImpresion {
  cols: number;
  codePage: CodePageName;
}

/**
 * Renderiza el documento de un `print_job` a bytes ESC/POS.
 *
 * El `boleto` NO está cableado a propósito: su plantilla sigue pendiente de que
 * el cliente apruebe el prototipo. El spooler nunca reclama esos jobs (ver
 * `TEMPLATES_SOPORTADOS`), así que quedan en `pendiente` sin marcarse como error.
 */
export function renderPrintJob(
  templateKey: string,
  datos: unknown,
  ctx: ContextoImpresion,
): Buffer {
  switch (templateKey) {
    case 'manifiesto_conductor':
    case 'manifiesto_terminal':
      return renderManifiesto(datos as DatosManifiesto, {
        cols: ctx.cols,
        codePage: ctx.codePage,
      });
    default:
      throw new Error(`El spooler no sabe renderizar la plantilla "${templateKey}"`);
  }
}

export interface OpcionesSpooler {
  /** Reloj para `impreso_en`. Inyectable en pruebas. */
  ahora?: () => Date;
  /** Intentos antes de mandar a `revision_manual`. Cuenta reclamos, no solo fallos. */
  maxIntentos?: number;
  /** Tope de jobs por pasada y por sucursal. */
  lote?: number;
  /** Fábrica de transporte. Por defecto la de `config.ts` (tcp/usb reales). */
  crearTransporte?: (cfg: ConfigImpresoraRow) => EscPosTransport;
}

export interface ResumenSpooler {
  impresos: number;
  /** Fallaron pero vuelven a la cola. */
  fallidos: number;
  /** Agotaron los intentos y quedaron en `revision_manual`. */
  revisionManual: number;
  /** Sucursales con jobs pendientes y sin impresora vigente. */
  sinImpresora: number;
  /** Impresora configurada pero que no respondió a la sonda. */
  impresoraFuera: number;
  /** Jobs que estaban en `imprimiendo` de una corrida interrumpida. */
  reanudados: number;
}

interface JobReclamado {
  id: string;
  template_key: string;
  datos: unknown;
  intentos: number;
}

/**
 * Procesa una pasada de la cola: todas las sucursales con jobs pendientes, hasta
 * `lote` jobs cada una. No lanza por un job que falla — lo registra y sigue.
 */
export async function procesarCola(
  db: Client,
  opts: OpcionesSpooler = {},
): Promise<ResumenSpooler> {
  const ahora = opts.ahora ?? ((): Date => new Date());
  const maxIntentos = opts.maxIntentos ?? 3;
  const lote = opts.lote ?? 25;
  const crearTransporte = opts.crearTransporte ?? crearTransporteReal;

  const r: ResumenSpooler = {
    impresos: 0, fallidos: 0, revisionManual: 0,
    sinImpresora: 0, impresoraFuera: 0, reanudados: 0,
  };

  r.reanudados = await recuperarImprimiendo(db, maxIntentos);

  const { rows: sucursales } = await db.query<{ sucursal_id: string }>(
    `SELECT DISTINCT sucursal_id
       FROM core.print_job
      WHERE estado = 'pendiente' AND activo AND template_key = ANY($1)`,
    [[...TEMPLATES_SOPORTADOS]],
  );

  for (const { sucursal_id } of sucursales) {
    const impresora = await cargarConfigImpresora(db, sucursal_id);
    if (!impresora) {
      r.sinImpresora += 1;
      continue;
    }

    const transporte = crearTransporte(impresora);
    const sonda = await transporte.probe();
    if (!sonda.ok) {
      // La impresora apagada no es culpa del job: no se reclama nada, se
      // reintenta en la siguiente pasada sin gastar intentos.
      r.impresoraFuera += 1;
      continue;
    }

    const ctx: ContextoImpresion = {
      cols: impresora.ancho_cols,
      codePage: aCodePage(impresora.code_page),
    };

    // Se reclama el lote entero de una vez: un job que falla vuelve a
    // `pendiente`, pero no se vuelve a tomar en esta misma pasada — así un fallo
    // consume un intento por pasada, no todos de golpe.
    for (const job of await reclamarLote(db, sucursal_id, lote)) {
      await imprimirJob(db, job, transporte, ctx, ahora(), maxIntentos, r);
    }
  }

  return r;
}

async function imprimirJob(
  db: Client,
  job: JobReclamado,
  transporte: EscPosTransport,
  ctx: ContextoImpresion,
  impresoEn: Date,
  maxIntentos: number,
  r: ResumenSpooler,
): Promise<void> {
  try {
    const bytes = renderPrintJob(job.template_key, job.datos, ctx);
    await transporte.open();
    try {
      await transporte.write(bytes);
    } finally {
      await transporte.close();
    }
    await db.query(
      `UPDATE core.print_job
          SET estado = 'impreso', impreso_en = $2, ultimo_error = NULL
        WHERE id = $1`,
      [job.id, impresoEn],
    );
    r.impresos += 1;
  } catch (err) {
    const agotado = job.intentos >= maxIntentos;
    await db.query(
      `UPDATE core.print_job
          SET estado = CASE WHEN $3 THEN 'revision_manual' ELSE 'pendiente' END,
              ultimo_error = $2
        WHERE id = $1`,
      [job.id, mensajeError(err), agotado],
    );
    if (agotado) r.revisionManual += 1;
    else r.fallidos += 1;
  }
}

async function reclamarLote(
  db: Client,
  sucursalId: string,
  lote: number,
): Promise<JobReclamado[]> {
  const { rows } = await db.query<JobReclamado>(
    `UPDATE core.print_job
        SET estado = 'imprimiendo', intentos = intentos + 1
      WHERE id IN (
        SELECT id FROM core.print_job
         WHERE estado = 'pendiente' AND activo
           AND sucursal_id = $1 AND template_key = ANY($2)
         ORDER BY creado_en
         FOR UPDATE SKIP LOCKED
         LIMIT $3
      )
      RETURNING id, template_key, datos, intentos`,
    [sucursalId, [...TEMPLATES_SOPORTADOS], lote],
  );
  return rows;
}

async function recuperarImprimiendo(db: Client, maxIntentos: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE core.print_job
        SET estado = CASE WHEN intentos >= $2 THEN 'revision_manual' ELSE 'pendiente' END,
            ultimo_error = 'reanudado tras una corrida interrumpida (intento ' || intentos || ')'
      WHERE estado = 'imprimiendo' AND activo AND template_key = ANY($1)`,
    [[...TEMPLATES_SOPORTADOS], maxIntentos],
  );
  return rowCount ?? 0;
}

function mensajeError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? `${m.slice(0, 497)}...` : m;
}
