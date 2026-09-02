/**
 * Servicio del spooler: coalescedor de pasadas y el trigger de `pg_notify`.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.2
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { crearEjecutor, iniciarSpooler } from '../../src/printing/servicio.js';
import type { ResumenSpooler } from '../../src/printing/spooler.js';

const RESUMEN_VACIO: ResumenSpooler = {
  impresos: 0, fallidos: 0, revisionManual: 0,
  sinImpresora: 0, impresoraFuera: 0, reanudados: 0,
};

describe('crearEjecutor (coalescedor del spooler)', () => {
  it('junta varias solicitudes casi simultáneas en una sola corrida', async () => {
    let corridas = 0;
    const ej = crearEjecutor(async () => { corridas += 1; }, { debounceMs: 10 });

    ej.solicitar();
    ej.solicitar();
    ej.solicitar();
    await new Promise((r) => setTimeout(r, 50));

    expect(corridas).toBe(1);
    await ej.detener();
  });

  it('si llega una solicitud mientras corre, encadena exactamente una más', async () => {
    let corridas = 0;
    let liberar: (() => void) | null = null;
    const ej = crearEjecutor(async () => {
      corridas += 1;
      if (corridas === 1) await new Promise<void>((r) => { liberar = r; });
    }, { debounceMs: 5 });

    ej.solicitar();
    await new Promise((r) => setTimeout(r, 25)); // corrida 1 arrancó y está esperando
    ej.solicitar();
    ej.solicitar(); // dos avisos DURANTE la corrida 1 → una sola repetición
    liberar!();
    await new Promise((r) => setTimeout(r, 25));

    expect(corridas).toBe(2);
    await ej.detener();
  });

  it('detener() espera a que termine la corrida en vuelo y no arranca otra', async () => {
    let corridas = 0;
    let liberar: (() => void) | null = null;
    const ej = crearEjecutor(async () => {
      corridas += 1;
      await new Promise<void>((r) => { liberar = r; });
    }, { debounceMs: 5 });

    ej.solicitar();
    await new Promise((r) => setTimeout(r, 20));
    ej.solicitar(); // llega durante la corrida; detener() debe descartarlo
    const detencion = ej.detener();
    liberar!();
    await detencion;

    expect(corridas).toBe(1);
  });
});

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('trigger de NOTIFY del print_job (PostgreSQL real)', () => {
  let escucha: Client;
  let escritor: Client;

  beforeAll(async () => {
    escucha = new Client(resolveConnection('local').config);
    escritor = new Client(resolveConnection('local').config);
    await escucha.connect();
    await escritor.connect();
  });
  afterAll(async () => {
    await escucha.end();
    await escritor.end();
  });

  it('un `print_job` pendiente nuevo dispara `pg_notify` con la sucursal', async () => {
    await escucha.query('LISTEN print_job_nuevo');
    const avisado = new Promise<string>((resolve) => {
      escucha.once('notification', (n) => resolve(n.payload ?? ''));
    });

    const { rows } = await escritor.query<{ id: string; sucursal_id: string }>(
      `INSERT INTO core.print_job (sucursal_id, template_key, datos, estado)
       SELECT id, 'boleto', jsonb_build_object('folio', 'NOTIFY1'), 'pendiente'
         FROM core.sucursal WHERE activo ORDER BY creado_en LIMIT 1
       RETURNING id, sucursal_id`,
    );
    const job = rows[0]!;

    try {
      const payload = await Promise.race([
        avisado,
        new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error('sin aviso en 2 s')), 2000)),
      ]);
      expect(payload).toBe(job.sucursal_id);
    } finally {
      await escucha.query('UNLISTEN print_job_nuevo');
      await escritor.query('DELETE FROM sync.outbox WHERE fila_id = $1', [job.id]);
      await escritor.query('DELETE FROM core.print_job WHERE id = $1', [job.id]);
    }
  });

  it('`iniciarSpooler` corre una pasada al llegar un job nuevo (sin poll)', async () => {
    const pasadas: number[] = [];
    const svc = iniciarSpooler(resolveConnection('local').config, {
      intervaloRespaldoMs: 3_600_000, // efectivamente sin poll de respaldo
      debounceMs: 20,
      log: () => { /* silencio */ },
      procesar: async () => { pasadas.push(Date.now()); return RESUMEN_VACIO; },
    });

    // El catch-up al conectar dispara una pasada; se espera y se descarta.
    await new Promise((r) => setTimeout(r, 400));
    const base = pasadas.length;

    const { rows } = await escritor.query<{ id: string }>(
      `INSERT INTO core.print_job (sucursal_id, template_key, datos, estado)
       SELECT id, 'boleto', jsonb_build_object('folio', 'NOTIFY2'), 'pendiente'
         FROM core.sucursal WHERE activo ORDER BY creado_en LIMIT 1
       RETURNING id`,
    );
    const jobId = rows[0]!.id;

    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(pasadas.length, 'el aviso disparó una pasada').toBeGreaterThan(base);
    } finally {
      await svc.detener();
      await escritor.query('DELETE FROM sync.outbox WHERE fila_id = $1', [jobId]);
      await escritor.query('DELETE FROM core.print_job WHERE id = $1', [jobId]);
    }
  });
});
