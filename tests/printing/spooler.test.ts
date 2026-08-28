/**
 * Spooler de impresión: vacía `core.print_job` al papel (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.1–§2.4
 *
 * Los `print_job` los crea `core.generar_manifiestos` (F7); aquí se prueba que el
 * spooler los reclama, renderiza, envía y finaliza — con un transporte falso
 * inyectado, sin impresora física.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { generarManifiestos } from '../../src/fleet/manifiesto.js';
import { procesarCola } from '../../src/printing/spooler.js';
import { decodeText } from '../../src/printing/escpos/codepage.js';
import { stripCommandsRaw } from '../../src/printing/transport/capture.js';
import type { EscPosTransport, ProbeResult } from '../../src/printing/transport/types.js';
import { crearUsuario, seedSalida, sembrarOcupacion } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

class TransporteFalso implements EscPosTransport {
  readonly kind = 'capture' as const;
  readonly label = 'transporte falso';
  readonly writes: Buffer[] = [];
  aperturas = 0;

  constructor(private readonly opts: { probeOk?: boolean; fallaEscritura?: boolean } = {}) {}

  async probe(): Promise<ProbeResult> {
    return { ok: this.opts.probeOk ?? true, latencyMs: 1 };
  }
  async open(): Promise<void> { this.aperturas += 1; }
  async write(bytes: Buffer): Promise<void> {
    if (this.opts.fallaEscritura) throw new Error('impresora atascada');
    this.writes.push(Buffer.from(bytes));
  }
  async close(): Promise<void> {}

  get papel(): string {
    return decodeText(stripCommandsRaw(Buffer.concat(this.writes)));
  }
}

run('spooler de impresión (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const seedImpresora = async (sucursalId: string, cols = 48): Promise<void> => {
    await db.query(
      `INSERT INTO core.config_impresora
         (sucursal_id, nombre, transporte, ip, ancho_cols, es_predeterminada)
       VALUES ($1, 'Enduro de prueba', 'tcp', '127.0.0.1', $2, true)`,
      [sucursalId, cols],
    );
  };

  /** Una salida con dos boletos y sus dos manifiestos encolados en el origen. */
  const prep = async (): Promise<{ sucursalId: string; salidaId: string }> => {
    const fx = await seedSalida(db, { paradas: 3, diasAdelante: 12 });
    const usuarioId = await crearUsuario(db);
    for (const asiento of [2, 3]) {
      await sembrarOcupacion(db, {
        salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId,
        asiento, desde: 0, hasta: 2, estado: 'firme',
      });
    }
    await generarManifiestos(db, { salidaId: fx.salidaId, usuarioId });
    return { sucursalId: fx.sucursales[0]!, salidaId: fx.salidaId };
  };

  const estados = async (salidaId: string): Promise<Record<string, number>> => {
    const { rows } = await db.query<{ estado: string; n: string }>(
      `SELECT estado, count(*) AS n FROM core.print_job
        WHERE datos->>'salida_id' = $1 GROUP BY estado`,
      [salidaId],
    );
    return Object.fromEntries(rows.map((r) => [r.estado, Number(r.n)]));
  };

  // -------------------------------------------------------------------------
  it('imprime los dos manifiestos y los marca impreso', async () => {
    const { sucursalId, salidaId } = await prep();
    await seedImpresora(sucursalId);
    const t = new TransporteFalso();

    const r = await procesarCola(db, { crearTransporte: () => t });

    expect(r.impresos).toBe(2);
    expect(t.writes).toHaveLength(2);
    expect(await estados(salidaId)).toEqual({ impreso: 2 });

    const { rows } = await db.query<{ impreso_en: Date | null }>(
      `SELECT impreso_en FROM core.print_job WHERE datos->>'salida_id' = $1`, [salidaId],
    );
    for (const row of rows) expect(row.impreso_en).not.toBeNull();

    expect(t.papel).toContain('COPIA CONDUCTOR');
    expect(t.papel).toContain('COPIA TERMINAL');
  });

  it('renderiza al ancho de columnas que declara la impresora', async () => {
    const { sucursalId } = await prep();
    await seedImpresora(sucursalId, 32);
    const t = new TransporteFalso();

    await procesarCola(db, { crearTransporte: () => t });

    for (const line of t.papel.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
  });

  it('deja los jobs en cola si la sucursal no tiene impresora', async () => {
    const { salidaId } = await prep();
    const r = await procesarCola(db);

    expect(r.sinImpresora).toBe(1);
    expect(r.impresos).toBe(0);
    expect(await estados(salidaId)).toEqual({ pendiente: 2 });
  });

  it('no gasta intentos si la impresora no responde a la sonda', async () => {
    const { sucursalId, salidaId } = await prep();
    await seedImpresora(sucursalId);
    const t = new TransporteFalso({ probeOk: false });

    const r = await procesarCola(db, { crearTransporte: () => t });

    expect(r.impresoraFuera).toBe(1);
    expect(t.writes).toHaveLength(0);
    expect(await estados(salidaId)).toEqual({ pendiente: 2 });

    const { rows } = await db.query<{ intentos: number }>(
      `SELECT intentos FROM core.print_job WHERE datos->>'salida_id' = $1`, [salidaId],
    );
    for (const row of rows) expect(row.intentos).toBe(0);
  });

  it('reintenta un fallo de escritura y agota a revisión manual', async () => {
    const { sucursalId, salidaId } = await prep();
    await seedImpresora(sucursalId);
    const t = new TransporteFalso({ fallaEscritura: true });
    const opts = { crearTransporte: () => t, maxIntentos: 3 };

    let r = await procesarCola(db, opts);
    expect(r.fallidos).toBe(2);
    expect(await estados(salidaId)).toEqual({ pendiente: 2 });

    r = await procesarCola(db, opts);
    expect(r.fallidos).toBe(2);

    r = await procesarCola(db, opts);
    expect(r.revisionManual).toBe(2);
    expect(await estados(salidaId)).toEqual({ revision_manual: 2 });

    const { rows } = await db.query<{ ultimo_error: string | null }>(
      `SELECT ultimo_error FROM core.print_job WHERE datos->>'salida_id' = $1`, [salidaId],
    );
    for (const row of rows) expect(row.ultimo_error).toMatch(/atascada/);
  });

  it('no toca los jobs de boleto (plantilla aún sin cablear)', async () => {
    const { sucursalId } = await prep();
    await seedImpresora(sucursalId);
    await db.query(
      `INSERT INTO core.print_job (sucursal_id, template_key, datos, estado)
       VALUES ($1, 'boleto', '{"folio":"AAA111"}'::jsonb, 'pendiente')`,
      [sucursalId],
    );
    const t = new TransporteFalso();

    const r = await procesarCola(db, { crearTransporte: () => t });

    expect(r.impresos).toBe(2);
    const { rows } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.print_job WHERE template_key = 'boleto'`,
    );
    expect(rows[0]!.estado).toBe('pendiente');
  });

  it('recupera un job que quedó en imprimiendo de una corrida interrumpida', async () => {
    const { sucursalId, salidaId } = await prep();
    await seedImpresora(sucursalId);
    await db.query(
      `UPDATE core.print_job SET estado = 'imprimiendo', intentos = 1
        WHERE datos->>'salida_id' = $1 AND template_key = 'manifiesto_conductor'`,
      [salidaId],
    );
    const t = new TransporteFalso();

    const r = await procesarCola(db, { crearTransporte: () => t });

    expect(r.reanudados).toBe(1);
    expect(r.impresos).toBe(2);
    expect(await estados(salidaId)).toEqual({ impreso: 2 });
  });

  it('una segunda pasada no reimprime lo ya impreso', async () => {
    const { sucursalId } = await prep();
    await seedImpresora(sucursalId);
    const t = new TransporteFalso();
    const opts = { crearTransporte: () => t };

    await procesarCola(db, opts);
    const r = await procesarCola(db, opts);

    expect(r.impresos).toBe(0);
    expect(t.writes).toHaveLength(2);
  });
});
