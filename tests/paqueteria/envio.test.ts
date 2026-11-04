/**
 * Fase C (0084) — paquetería: registro, cobro y estado.
 * docs/architecture/06-lugar-paso-paqueteria.md §1.2 (P1..P6, P8).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  buscarEnvioPorFolio, registrarEnvio, verificarTransferenciaEnvio, type RegistrarEnvioArgs,
} from '../../src/paqueteria/envio.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { saldoCorte } from '../../src/caja/corte.js';
import { reimprimirEnvio } from '../../src/paqueteria/envio.js';
import { renderPrintJob } from '../../src/printing/spooler.js';
import { stripCommands } from '../../src/printing/transport/capture.js';
import { crearUsuario, seedCorte, seedSalida } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('paquetería · núcleo (PostgreSQL real)', () => {
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

  const base = (
    fx: { salidaId: string; sucursales: string[] }, usuarioId: string,
  ): Omit<RegistrarEnvioArgs, 'modalidad'> => ({
    salidaId: fx.salidaId, sucursalOrigenId: fx.sucursales[0]!, usuarioId,
    sucursalDestinoId: fx.sucursales[3]!,
    remitenteNombre: 'Rosa Pérez', remitenteTelefono: '953 111 2222',
    destinatarioNombre: 'Carlos Pérez López', destinatarioTelefono: '55 3333 4444',
    descripcion: '5 cajas de ropa', bultos: 5, importe: 800,
  });

  /** Un rechazo aborta la transacción: cada intento va en su propio savepoint. */
  const rechaza = async (f: () => Promise<unknown>, re: RegExp) => {
    await db.query('SAVEPOINT intento');
    await expect(f()).rejects.toThrow(re);
    await db.query('ROLLBACK TO SAVEPOINT intento');
  };

  it('pagado en efectivo: folio, estado registrado/pagado y entra al corte como efectivo', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarEnvio(db, {
      ...base(fx, usuarioId), modalidad: 'pagado',
      pago: { metodo: 'efectivo', efectivoRecibido: 1000, corteCajaId: corteId },
    });
    expect(r.folio).toHaveLength(6);
    expect(r.estadoPago).toBe('pagado');

    const e = await buscarEnvioPorFolio(db, r.folio.toLowerCase());
    expect(e).toMatchObject({
      estado: 'registrado', estadoPago: 'pagado', bultos: 5, importe: 800,
      destinatarioNombre: 'Carlos Pérez López', porCobrar: 0,
    });

    const saldo = await saldoCorte(db, corteId);
    expect(saldo!.ingresosEfectivo).toBe(800);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.movimiento_caja
        WHERE origen_tipo = 'pago_paqueteria' AND origen_id = $1`, [r.pagoEnvioId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('pagado por transferencia: no detiene, queda por confirmar y suma al corte al confirmarse', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const r = await registrarEnvio(db, {
      ...base(fx, usuarioId), modalidad: 'pagado',
      pago: { metodo: 'transferencia', referencia: 'SPEI 123', corteCajaId: corteId },
    });
    expect(r.estadoPago).toBe('por_confirmar');
    expect((await saldoCorte(db, corteId))!.ingresos).toBe(0);

    const v = await verificarTransferenciaEnvio(db, r.pagoEnvioId!, usuarioId);
    expect(v.estadoPago).toBe('pagado');
    const saldo = await saldoCorte(db, corteId);
    expect(saldo!.ingresosTransferencia).toBe(800);
    expect(saldo!.ingresosEfectivo).toBe(0);           // no es efectivo de la caja
    expect(saldo!.efectivoCalculado).toBe(saldo!.saldoInicial);
  });

  it('por cobrar: sin pago al registrar, todo el importe queda por cobrar en destino', async () => {
    const { fx, usuarioId } = await prep();
    const r = await registrarEnvio(db, { ...base(fx, usuarioId), modalidad: 'por_cobrar' });
    expect(r.estadoPago).toBe('pendiente');
    expect(r.pagoEnvioId).toBeNull();
    const e = await buscarEnvioPorFolio(db, r.folio);
    expect(e!.porCobrar).toBe(800);
  });

  it('reglas: sin anticipos, importe > 0, destino posterior con sistema, pago según modalidad', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const b = base(fx, usuarioId);
    await rechaza(() => registrarEnvio(db, { ...b, modalidad: 'pagado' }), /se cobra completo/i);
    await rechaza(() => registrarEnvio(db, {
      ...b, modalidad: 'por_cobrar', pago: { metodo: 'efectivo', corteCajaId: corteId },
    }), /por cobrar se paga completo en el destino/i);
    await rechaza(() => registrarEnvio(db, { ...b, importe: 0, modalidad: 'por_cobrar' }), /mayor a \$0/i);
    await rechaza(() => registrarEnvio(db, {
      ...b, sucursalOrigenId: fx.sucursales[2]!, sucursalDestinoId: fx.sucursales[1]!, modalidad: 'por_cobrar',
    }), /terminal con sistema posterior/i);
    await rechaza(() => registrarEnvio(db, { ...b, bultos: 0, modalidad: 'por_cobrar' }), /bultos/i);
  });

  it('cierra 5 minutos antes del paso por la terminal de origen', async () => {
    const { fx, usuarioId } = await prep();
    const { rows } = await db.query<{ hora: Date }>(
      `SELECT hora_paso_programada AS hora FROM core.salida_parada WHERE salida_id = $1 AND orden = 0`,
      [fx.salidaId],
    );
    const hora = rows[0]!.hora.getTime();
    const ok = await registrarEnvio(db, {
      ...base(fx, usuarioId), modalidad: 'por_cobrar', ahora: new Date(hora - 6 * 60_000),
    });
    expect(ok.folio).toBeTruthy();
    await rechaza(() => registrarEnvio(db, {
      ...base(fx, usuarioId), modalidad: 'por_cobrar', ahora: new Date(hora - 4 * 60_000),
    }), /cerró 5 minutos/i);
  });

  it('el folio sale del mismo contador que los boletos: nunca coinciden', async () => {
    const { fx, usuarioId, corteId } = await prep();
    const v = await registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 2, nombre: 'Ana Ruiz', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
    });
    const e = await registrarEnvio(db, { ...base(fx, usuarioId), modalidad: 'por_cobrar' });
    expect(e.folio[0]).toBe(v.boletos[0]!.folio[0]);   // mismo prefijo de sucursal
    expect(e.folio).not.toBe(v.boletos[0]!.folio);
  });

  it('la nube baja el envío y su historia a origen y destino (0083)', async () => {
    const { fx, usuarioId, corteId } = await prep();
    await db.query(`SET LOCAL donaji.forzar_nube = 'on'`);
    const r = await registrarEnvio(db, {
      ...base(fx, usuarioId), modalidad: 'pagado',
      pago: { metodo: 'efectivo', corteCajaId: corteId },
    });
    const { rows } = await db.query<{ tabla: string; destinatarios: string[] }>(
      `SELECT tabla, destinatarios FROM sync.cambio_log
        WHERE fila_id = $1 OR payload->>'envio_id' = $1::text`, [r.envioId],
    );
    const tablas = new Set(rows.map((x) => x.tabla));
    expect(tablas).toEqual(new Set(['core.envio', 'core.evento_envio', 'core.pago_envio']));
    for (const x of rows) expect(x.destinatarios).toContain(fx.sucursales[3]);
  });

  it('imprime el recibo y un ticket por bulto (0085), y se pueden reimprimir', async () => {
    const { fx, usuarioId } = await prep();
    const r = await registrarEnvio(db, { ...base(fx, usuarioId), bultos: 3, modalidad: 'por_cobrar' });
    expect(r.printJobs).toBe(4);

    const { rows } = await db.query<{ template_key: string; bulto_num: number | null; datos: unknown }>(
      `SELECT template_key, bulto_num, datos FROM core.print_job
        WHERE envio_id = $1 ORDER BY template_key DESC, bulto_num`, [r.envioId],
    );
    expect(rows.map((x) => [x.template_key, x.bulto_num])).toEqual([
      ['recibo_envio', null], ['etiqueta_paquete', 1], ['etiqueta_paquete', 2], ['etiqueta_paquete', 3],
    ]);

    // El snapshot congelado se renderiza tal cual por el spooler.
    const ctx = { cols: 48, codePage: 'CP858' as const,
                  ticket: { leyendaPie: '', telefonosAtencion: '', proveedor: '', incluirHmac: false } };
    const etiqueta = stripCommands(renderPrintJob('etiqueta_paquete', rows[2]!.datos, ctx));
    expect(etiqueta).toContain('2/3');
    expect(etiqueta).toContain(`FOLIO ${r.folio}`);
    expect(stripCommands(renderPrintJob('recibo_envio', rows[0]!.datos, ctx))).toContain('POR COBRAR EN DESTINO');

    const re = await reimprimirEnvio(db, {
      envioId: r.envioId, sucursalId: fx.sucursales[0]!, que: 'etiquetas', motivo: 'se mojó', bulto: 2,
    });
    expect(re.printJobs).toBe(1);
    const { rows: rr } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.print_job WHERE envio_id = $1 AND es_reimpresion AND bulto_num = 2`,
      [r.envioId],
    );
    expect(Number(rr[0]!.n)).toBe(1);
    await rechaza(() => reimprimirEnvio(db, {
      envioId: r.envioId, sucursalId: fx.sucursales[0]!, que: 'etiquetas', motivo: 'x', bulto: 7,
    }), /bulto 7 no existe/i);
  });
});
