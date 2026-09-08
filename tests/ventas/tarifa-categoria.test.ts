/**
 * Fase 3 de "paradas autorizadas" — categoría de pasajero y validación estricta
 * de tarifa (migración 0051, contra PostgreSQL real).
 *
 * docs/architecture/05-paradas-autorizadas-tarifas.md §4 (Fase 3) · D4 / P-2
 *
 * ALCANCE. Solo lo que 0051 introduce:
 *   - `core.registrar_venta` valida `pasajero.importe` contra `core.tarifa` de su
 *     (ruta, tramo, categoría); sin tarifa vigente ⇒ RAISE; importe ≠ tarifa ⇒ RAISE.
 *   - el descuento (`categoria <> 'general'`) solo aplica terminal-extremo →
 *     terminal-extremo (orden 0 → n-1); en parada intermedia ⇒ RAISE.
 *   - `core.boleto.categoria_pasajero` guardado; `ResultadoVenta.boletos[].categoria`.
 *   - interruptor `core.parametro` `validar_tarifa_estricta` (default `true`).
 *   - `core.buscar_salidas` devuelve `tarifas` = { categoria: importe }.
 *
 * NADA de `tope_asientos` (estructural, no se valida hoy) ni de Fase 4+.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { buscarSalidas } from '../../src/ventas/busqueda.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { antesDelCierre, crearUsuario, seedCorte, seedSalida, seedTarifa } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('Fase 3 · tarifa por categoría (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  interface Ctx {
    salidaId: string; horarioId: string; sucursales: string[];
    puntos: string[]; usuarioId: string; corteId: string; ahora: Date;
  }

  /** Salida de 4 paradas, tarifa general 450 por tramo (auto), corte y reloj listos. */
  const preparar = async (): Promise<Ctx> => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);
    return {
      salidaId: fx.salidaId, horarioId: fx.horarioId, sucursales: fx.sucursales,
      puntos: fx.puntos, usuarioId, corteId, ahora,
    };
  };

  const venta = (c: Ctx, over: Partial<Parameters<typeof registrarVenta>[1]>) =>
    registrarVenta(db, {
      salidaId: c.salidaId, sucursalVentaId: c.sucursales[0]!, usuarioId: c.usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Ana', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: c.corteId },
      ahora: c.ahora,
      ...over,
    });

  // -------------------------------------------------------------------------
  // general
  // -------------------------------------------------------------------------
  it('venta general con importe = tarifa: OK, boleto categoria general', async () => {
    const c = await preparar();
    const r = await venta(c, {});
    expect(r.estado).toBe('liquidada');
    expect(r.boletos[0]!.categoria).toBe('general');

    const { rows } = await db.query<{ categoria_pasajero: string }>(
      `SELECT categoria_pasajero FROM core.boleto WHERE id = $1`,
      [r.boletos[0]!.boletoId],
    );
    expect(rows[0]!.categoria_pasajero).toBe('general');
  });

  it('venta general con importe ≠ tarifa ⇒ RAISE', async () => {
    const c = await preparar();
    await expect(venta(c, {
      pasajeros: [{ asientoNum: 5, nombre: 'Ana', importe: 999 }],
      pago: { metodo: 'efectivo', monto: 999, corteCajaId: c.corteId },
    })).rejects.toThrow(/no coincide con la tarifa/i);
  });

  it('venta de un tramo sin tarifa capturada ⇒ RAISE', async () => {
    // Ruta sin tarifas: seedSalida con sinTarifas.
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 20, sinTarifas: true });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const ahora = await antesDelCierre(db, fx.salidaId, 0);

    await expect(registrarVenta(db, {
      salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
      contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 3,
      pasajeros: [{ asientoNum: 5, nombre: 'Ana', importe: 450 }],
      pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
      ahora,
    })).rejects.toThrow(/no hay tarifa vigente/i);
  });

  // -------------------------------------------------------------------------
  // inapam / menor (descuento terminal-extremo → terminal-extremo)
  // -------------------------------------------------------------------------
  it('inapam terminal→terminal con su tarifa de descuento: OK, boleto categoria inapam', async () => {
    const c = await preparar();
    await seedTarifa(db, c.horarioId, 0, 3, 300, 'inapam');

    const r = await venta(c, {
      pasajeros: [{ asientoNum: 5, nombre: 'Don Ino', importe: 300, categoria: 'inapam' }],
      pago: { metodo: 'efectivo', monto: 300, corteCajaId: c.corteId },
    });
    expect(r.estado).toBe('liquidada');
    expect(r.boletos[0]!.categoria).toBe('inapam');
    expect(r.importeTotal).toBe(300);

    const { rows } = await db.query<{ categoria_pasajero: string }>(
      `SELECT categoria_pasajero FROM core.boleto WHERE id = $1`,
      [r.boletos[0]!.boletoId],
    );
    expect(rows[0]!.categoria_pasajero).toBe('inapam');
  });

  it('inapam en una parada intermedia (0→1) ⇒ RAISE aunque exista la tarifa', async () => {
    const c = await preparar();
    await seedTarifa(db, c.horarioId, 0, 1, 200, 'inapam');

    await expect(venta(c, {
      origenOrden: 0, destinoOrden: 1,
      pasajeros: [{ asientoNum: 5, nombre: 'Don Ino', importe: 200, categoria: 'inapam' }],
      pago: { metodo: 'efectivo', monto: 200, corteCajaId: c.corteId },
    })).rejects.toThrow(/solo aplica.*terminal/i);
  });

  it('menor terminal→terminal sin tarifa menor capturada ⇒ RAISE', async () => {
    const c = await preparar();   // solo hay tarifas general
    await expect(venta(c, {
      pasajeros: [{ asientoNum: 5, nombre: 'Niña', importe: 300, categoria: 'menor' }],
      pago: { metodo: 'efectivo', monto: 300, corteCajaId: c.corteId },
    })).rejects.toThrow(/no hay tarifa vigente/i);
  });

  it('categoría de pasajero inválida ⇒ RAISE', async () => {
    const c = await preparar();
    await expect(venta(c, {
      // @ts-expect-error probamos un valor fuera del union a propósito
      pasajeros: [{ asientoNum: 5, nombre: 'X', importe: 450, categoria: 'jubilado' }],
    })).rejects.toThrow(/categoría de pasajero inválida/i);
  });

  // -------------------------------------------------------------------------
  // interruptor validar_tarifa_estricta
  // -------------------------------------------------------------------------
  it('con validar_tarifa_estricta=false no se valida el importe', async () => {
    const c = await preparar();
    await db.query(
      `UPDATE core.parametro SET valor = 'false'::jsonb WHERE clave = 'validar_tarifa_estricta'`,
    );
    const r = await venta(c, {
      pasajeros: [{ asientoNum: 5, nombre: 'Ana', importe: 12345 }],
      pago: { metodo: 'efectivo', monto: 12345, corteCajaId: c.corteId },
    });
    expect(r.estado).toBe('liquidada');
    expect(r.importeTotal).toBe(12345);
  });

  // -------------------------------------------------------------------------
  // core.tarifa.tope_asientos — estructural
  // -------------------------------------------------------------------------
  it('core.tarifa.tope_asientos acepta NULL (estructural, no se valida hoy)', async () => {
    const { rows } = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'tarifa' AND column_name = 'tope_asientos'`,
    );
    expect(rows[0]!.is_nullable).toBe('YES');
  });

  // -------------------------------------------------------------------------
  // buscar_salidas: mapa `tarifas` por categoría
  // -------------------------------------------------------------------------
  it('buscar_salidas devuelve `tarifas` = { categoria: importe }; inapam/menor solo 0→n-1', async () => {
    const c = await preparar();   // general 450 en todos los tramos
    await seedTarifa(db, c.horarioId, 0, 3, 300, 'inapam');
    await seedTarifa(db, c.horarioId, 0, 3, 280, 'menor');
    await seedTarifa(db, c.horarioId, 0, 1, 150, 'inapam');   // tramo intermedio

    const completo = await buscarSalidas(db, {
      fecha: (await db.query<{ f: string }>(
        `SELECT fecha_operacion::text AS f FROM core.salida WHERE id = $1`, [c.salidaId],
      )).rows[0]!.f,
      sucursalOrigenId: c.puntos[0]!,
      sucursalDestinoId: c.puntos[3]!,
      nPersonas: 1,
      sucursalVendedoraId: c.sucursales[0]!,
    });
    expect(completo[0]!.tarifas).toEqual({ general: 450, inapam: 300, menor: 280 });
    expect(completo[0]!.tarifas.general).toBe(completo[0]!.importe);

    const intermedio = await buscarSalidas(db, {
      fecha: completo[0]!.fechaOperacion,
      sucursalOrigenId: c.puntos[0]!,
      sucursalDestinoId: c.puntos[1]!,
      nPersonas: 1,
      sucursalVendedoraId: c.sucursales[0]!,
    });
    // El tramo intermedio SÍ puede tener una fila inapam en core.tarifa, pero la
    // venta la rechaza (D4). `buscar_salidas` solo refleja lo capturado.
    expect(intermedio[0]!.tarifas).toEqual({ general: 450, inapam: 150 });
  });
});
