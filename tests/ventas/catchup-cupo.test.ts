/**
 * Arrastre de F1 (0063) — catch-up antes de vender asientos fuera de cupo (§3.3).
 *
 * Una terminal que lleva demasiado tiempo sin sincronizar (degradada) NO puede
 * vender un asiento fuera de su cupo propio aunque diga tener conexión: su vista
 * de las ventas de otras sucursales está vieja. Sale del bloqueo cuando vuelve a
 * sincronizar.
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { registrarVenta } from '../../src/ventas/venta.js';
import { adquirirLease } from '../../src/ventas/lease.js';
import { buscarSalidas } from '../../src/ventas/busqueda.js';
import { crearUsuario, seedCorte, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('catch-up antes de vender fuera de cupo (§3.3, PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const cupoDe = async (salidaId: string, sucursalId: string): Promise<number[]> => {
    const { rows } = await db.query<{ asientos: number[] }>(
      `SELECT asientos FROM core.cupo_offline
        WHERE salida_id = $1 AND sucursal_id = $2 AND tramos @> int4range(0, 2)`,
      [salidaId, sucursalId],
    );
    return (rows[0]?.asientos ?? []).map(Number);
  };

  const prep = async () => {
    const fx = await seedSalida(db, { paradas: 3, diasAdelante: 15 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    const cupo = await cupoDe(fx.salidaId, fx.sucursales[0]!);
    expect(cupo.length, 'la sucursal origen tiene cupo').toBeGreaterThan(0);
    const enCupo = cupo[0]!;
    const fueraDeCupo = Array.from({ length: 18 }, (_, i) => i + 1).find((n) => !cupo.includes(n));
    expect(fueraDeCupo, 'hay al menos un asiento fuera del cupo del origen').toBeDefined();
    return { fx, usuarioId, corteId, cupo, enCupo, fueraDeCupo: fueraDeCupo! };
  };

  const desincronizar = async (sucursalId: string, horas: number): Promise<void> => {
    await db.query(
      `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa)
       VALUES ($1, now() - make_interval(hours => $2::int))
       ON CONFLICT (sucursal_id) DO UPDATE SET ultima_sync_exitosa = EXCLUDED.ultima_sync_exitosa`,
      [sucursalId, horas],
    );
  };

  const venderAsiento = (
    fx: Awaited<ReturnType<typeof prep>>['fx'], usuarioId: string, corteId: string, asiento: number,
  ) => registrarVenta(db, {
    salidaId: fx.salidaId, sucursalVentaId: fx.sucursales[0]!, usuarioId,
    contactoTelefono: '953 111 2222', origenOrden: 0, destinoOrden: 2, conConexion: true,
    pasajeros: [{ asientoNum: asiento, nombre: 'Pax', importe: 450 }],
    pago: { metodo: 'efectivo', monto: 450, corteCajaId: corteId },
  });

  it('degradado: rechaza vender un asiento fuera de cupo aunque diga tener conexión', async () => {
    const { fx, usuarioId, corteId, fueraDeCupo } = await prep();
    await desincronizar(fx.sucursales[0]!, 100);

    await expect(venderAsiento(fx, usuarioId, corteId, fueraDeCupo))
      .rejects.toThrow(/sin sincronizar/i);
  });

  it('degradado: sí vende un asiento de su propio cupo', async () => {
    const { fx, usuarioId, corteId, enCupo } = await prep();
    await desincronizar(fx.sucursales[0]!, 100);

    const r = await venderAsiento(fx, usuarioId, corteId, enCupo);
    expect(r.boletos[0]!.asientoNum).toBe(enCupo);
  });

  it('al día: vende fuera de cupo con conexión (comportamiento normal)', async () => {
    const { fx, usuarioId, corteId, fueraDeCupo } = await prep();
    await desincronizar(fx.sucursales[0]!, 1); // sincronizó hace 1 h → al día

    const r = await venderAsiento(fx, usuarioId, corteId, fueraDeCupo);
    expect(r.boletos[0]!.asientoNum).toBe(fueraDeCupo);
  });

  it('nunca sincronizó (sin fila en sync.salud): no se considera degradado', async () => {
    const { fx, usuarioId, corteId, fueraDeCupo } = await prep();
    // sin desincronizar: no hay fila para esta sucursal en sync.salud

    const r = await venderAsiento(fx, usuarioId, corteId, fueraDeCupo);
    expect(r.boletos[0]!.asientoNum).toBe(fueraDeCupo);
  });

  it('degradado: adquirir_lease rechaza un asiento fuera de cupo', async () => {
    const { fx, fueraDeCupo } = await prep();
    await desincronizar(fx.sucursales[0]!, 100);

    await expect(adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: fueraDeCupo, desde: 0, hasta: 2,
      sucursalId: fx.sucursales[0]!,
    })).rejects.toThrow(/sin sincronizar/i);
  });

  it('degradado: adquirir_lease sí concede un asiento del cupo', async () => {
    const { fx, enCupo } = await prep();
    await desincronizar(fx.sucursales[0]!, 100);

    const r = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: enCupo, desde: 0, hasta: 2,
      sucursalId: fx.sucursales[0]!,
    });
    expect(r.estado).toBe('otorgado');
  });

  it('degradado: asientos_ofrecibles solo ofrece el cupo aunque conConexion=true', async () => {
    const { fx, cupo } = await prep();
    await desincronizar(fx.sucursales[0]!, 100);

    const salidas = await buscarSalidas(db, {
      fecha: fx.fechaOperacion,
      sucursalOrigenId: fx.puntos[0]!, sucursalDestinoId: fx.puntos[2]!,
      nPersonas: 1, sucursalVendedoraId: fx.sucursales[0]!, conConexion: true,
    });
    expect(salidas).toHaveLength(1);
    expect([...salidas[0]!.asientosOfrecibles].sort((a, b) => a - b))
      .toEqual([...cupo].sort((a, b) => a - b));
  });
});
