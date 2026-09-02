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
 *   2. Renderizar — por `template_key` (boleto o manifiesto), con el ancho y la
 *      code page de la impresora y, para el boleto, la config de ticket de la
 *      agencia (leyendas + clave del QR).
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
  aConfigTicket,
  cargarConfigImpresora,
  cargarConfigTicket,
  crearTransporte as crearTransporteReal,
  type ConfigImpresoraRow,
} from './config.js';
import { renderBoleto, type ConfigTicket, type DatosBoleto } from './templates/boleto.js';
import { renderManifiesto, type DatosManifiesto } from './templates/manifiesto.js';
import type { EscPosTransport } from './transport/types.js';

/** Templates que el spooler ya sabe renderizar. */
export const TEMPLATES_SOPORTADOS = [
  'boleto',
  'manifiesto_conductor',
  'manifiesto_terminal',
] as const;

const CODE_PAGES: readonly string[] = ['CP437', 'CP850', 'CP858'];

const aCodePage = (raw: string): CodePageName =>
  CODE_PAGES.includes(raw) ? (raw as CodePageName) : 'CP858';

export interface ContextoImpresion {
  cols: number;
  codePage: CodePageName;
  /** Config de ticket (leyendas, clave del QR) vigente para la agencia. */
  ticket: ConfigTicket;
}

/**
 * El snapshot congelado (`core.snapshot_boleto`, snake_case) a la forma que
 * consume `renderBoleto`. El ticket ya impreso no debe cambiar aunque los datos
 * de origen cambien: por eso se lee del snapshot, nunca de las tablas vivas.
 */
export function snapshotABoleto(datos: unknown): DatosBoleto {
  const d = (datos ?? {}) as Record<string, unknown>;
  const texto = (v: unknown): string => (v == null ? '' : String(v));
  const b: DatosBoleto = {
    folio: texto(d['folio']),
    pasajero: texto(d['pasajero']),
    asiento: Number(d['asiento']),
    origen: {
      nombre: texto(d['origen']),
      direccion: texto(d['origen_direccion']),
      telefono: texto(d['origen_telefono']),
    },
    destino: texto(d['destino']),
    fechaHoraViaje: texto(d['fecha_hora_viaje']),
    unidad: texto(d['unidad']),
    importe: Number(d['importe']),
    vendedor: texto(d['vendedor']),
    emitidoEn: texto(d['emitido_en']),
    porReservacion: Boolean(d['es_reservacion']),
  };
  const saldo = Number(d['saldo_pendiente']);
  if (Number.isFinite(saldo) && saldo > 0) b.saldoPendiente = saldo;
  return b;
}

/**
 * Renderiza el documento de un `print_job` a bytes ESC/POS.
 */
export function renderPrintJob(
  templateKey: string,
  datos: unknown,
  ctx: ContextoImpresion,
): Buffer {
  switch (templateKey) {
    case 'boleto':
      return renderBoleto(snapshotABoleto(datos), {
        ...ctx.ticket,
        cols: ctx.cols,
        codePage: ctx.codePage,
      });
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

    // Config de ticket de la agencia de esta sucursal (leyendas, clave del QR).
    // Ausente = boleto sin pie ni firma HMAC, pero se imprime igual.
    const { rows: [ag] } = await db.query<{ agencia_id: string }>(
      `SELECT agencia_id FROM core.sucursal WHERE id = $1`,
      [sucursal_id],
    );
    const configTicket = ag ? await cargarConfigTicket(db, ag.agencia_id) : null;

    const ctx: ContextoImpresion = {
      cols: impresora.ancho_cols,
      codePage: aCodePage(impresora.code_page),
      ticket: aConfigTicket(impresora, configTicket),
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
