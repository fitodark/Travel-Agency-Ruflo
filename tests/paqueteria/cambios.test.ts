/**
 * Fase F (0087/0088) — paquetería: mover, cancelar, manifiesto y corte.
 * docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P10..P13).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  buscarEnvioPorFolio, cancelarEnvio, moverEnvio, registrarEnvio, type RegistrarEnvioArgs,
} from '../../src/paqueteria/envio.js';
import { datosManifiesto } from '../../src/fleet/manifiesto.js';
import { materializarHorario } from '../../src/fleet/materializar.js';
import { movimientosCorteDetalle } from '../../src/caja/movimiento.js';
import { saldoCorte } from '../../src/caja/corte.js';
import { renderManifiesto, type DatosManifiesto } from '../../src/printing/templates/manifiesto.js';
import { stripCommands } from '../../src/printing/transport/capture.js';
import { crearUsuario, seedCorte, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('paquetería · mover, cancelar, manifiesto y corte (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    return { fx, usuarioId, corteId };
  };

  const envio = (
    fx: { salidaId: string; sucursales: string[] }, usuarioId: string,
    extra: Partial<RegistrarEnvioArgs> = {},
  ) => registrarEnvio(db, {
    salidaId: fx.salidaId, sucursalOrigenId: fx.sucursales[0]!, usuarioId,
    sucursalDestinoId: fx.sucursales[3]!,
    remitenteNombre: 'Rosa Pérez', remitenteTelefono: '953 111 2222',
    destinatarioNombre: 'Carlos Pérez López', destinatarioTelefono: '55 3333 4444',
    descripcion: '5 cajas de ropa', bultos: 2, importe: 800, modalidad: 'por_cobrar',
    ...extra,
  });

  const rechaza = async (f: () => Promise<unknown>, re: RegExp) => {
    await db.query('SAVEPOINT intento');
    await expect(f()).rejects.toThrow(re);
    await db.query('ROLLBACK TO SAVEPOINT intento');
  };

  /** Otra salida del mismo horario, un día después. */
  const otraSalida = async (fx: { horarioId: string; fechaOperacion: string }): Promise<string> => {
    const dia = new Date(`${fx.fechaOperacion}T12:00:00Z`);
    dia.setUTCDate(dia.getUTCDate() + 1);
    const desde = dia.toISOString().slice(0, 10);
    await materializarHorario(db, fx.horarioId, { dias: 0, desde });
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.salida WHERE horario_id = $1 AND fecha_operacion = $2::date`,
      [fx.horarioId, desde],
    );
    return rows[0]!.id;
  };

  it('mover: pasa a otra salida de la ruta, deja evento y reimprime recibo + tickets', async () => {
    const { fx, usuarioId } = await prep();
    const e = await envio(fx, usuarioId);
    const nueva = await otraSalida(fx);

    const r = await moverEnvio(db, {
      envioId: e.envioId, salidaNuevaId: nueva, sucursalId: fx.sucursales[0]!, usuarioId,
    });
    expect(r.printJobs).toBe(3);   // recibo + 2 tickets
    expect((await buscarEnvioPorFolio(db, e.folio))!.salidaId).toBe(nueva);

    const { rows } = await db.query<{ activos: string; reimp: string }>(
      `SELECT count(*) FILTER (WHERE activo AND NOT es_reimpresion) AS activos,
              count(*) FILTER (WHERE activo AND es_reimpresion)     AS reimp
         FROM core.print_job WHERE envio_id = $1`, [e.envioId],
    );
    expect(Number(rows[0]!.activos)).toBe(0);   // los pendientes de la salida vieja se dieron de baja
    expect(Number(rows[0]!.reimp)).toBe(3);

    await rechaza(() => moverEnvio(db, {
      envioId: e.envioId, salidaNuevaId: nueva, sucursalId: fx.sucursales[3]!, usuarioId,
    }), /solo la sucursal de origen/i);
  });

  it('cancelar: reembolsa el efectivo en el corte; transferencia se rechaza; por cobrar sin dinero', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const efectivo = await envio(fx, usuarioId, {
      modalidad: 'pagado', pago: { metodo: 'efectivo', corteCajaId: corteId },
    });
    const c = await cancelarEnvio(db, {
      envioId: efectivo.envioId, sucursalId: fx.sucursales[0]!, usuarioId, motivo: 'ya no lo envía',
    });
    expect(c.reembolso).toBe(800);
    const saldo = await saldoCorte(db, corteId);
    expect(saldo!.efectivoCalculado).toBe(saldo!.saldoInicial);   // +800 − 800
    expect((await buscarEnvioPorFolio(db, efectivo.folio))!.estado).toBe('cancelado');

    const transf = await envio(fx, usuarioId, {
      modalidad: 'pagado', pago: { metodo: 'transferencia', corteCajaId: corteId },
    });
    await rechaza(() => cancelarEnvio(db, {
      envioId: transf.envioId, sucursalId: fx.sucursales[0]!, usuarioId, motivo: 'x',
    }), /solo aplica a pagos en efectivo/i);

    const porCobrar = await envio(fx, usuarioId);
    const c2 = await cancelarEnvio(db, {
      envioId: porCobrar.envioId, sucursalId: fx.sucursales[0]!, usuarioId, motivo: 'error de captura',
    });
    expect(c2.reembolso).toBe(0);
  });

  it('el manifiesto de la terminal lleva la sección de paquetes (folio, descripción, monto, destino)', async () => {
    const { fx, usuarioId, corteId } = await prep();
    await envio(fx, usuarioId);
    await envio(fx, usuarioId, {
      descripcion: 'Sobre con papeles', importe: 150, bultos: 1,
      modalidad: 'pagado', pago: { metodo: 'efectivo', corteCajaId: corteId },
    });
    const cancelado = await envio(fx, usuarioId, { descripcion: 'No va' });
    await cancelarEnvio(db, { envioId: cancelado.envioId, sucursalId: fx.sucursales[0]!, usuarioId, motivo: 'x' });
    await envio(fx, usuarioId, { sucursalOrigenId: fx.sucursales[1]!, descripcion: 'Sube en la intermedia' });

    const m = await datosManifiesto(db, fx.salidaId, 'conductor', undefined, fx.sucursales[0]!);
    const paq = m['paquetes'] as Array<Record<string, unknown>>;
    expect(paq.map((p) => p['descripcion'])).toEqual(['5 cajas de ropa', 'Sobre con papeles']);
    expect(Number(paq[0]!['por_cobrar'])).toBe(800);
    expect(paq[1]!['por_cobrar']).toBeUndefined();

    const papel = stripCommands(renderManifiesto(m as unknown as DatosManifiesto));
    expect(papel).toContain('PAQUETES');
    expect(papel).toContain('POR COBRAR $800');
    expect(papel).toContain('TOTAL PAQUETES: 2');
    expect(papel).not.toContain('No va');
  });

  it('el corte y el historial distinguen el ingreso de paquetería', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const e = await envio(fx, usuarioId, {
      modalidad: 'pagado', pago: { metodo: 'efectivo', corteCajaId: corteId },
    });
    const movs = await movimientosCorteDetalle(db, corteId);
    const m = movs.find((x) => x.origenTipo === 'pago_paqueteria')!;
    expect(m.descripcion).toBe(`Envío ${e.folio} · 5 cajas de ropa → ${m.envio!.destino}`);
    expect(m.metodoPago).toBe('efectivo');
    expect(m.envio).toMatchObject({ folio: e.folio, bultos: 2, destinatario: 'Carlos Pérez López' });
  });
});
