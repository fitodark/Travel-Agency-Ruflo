/**
 * Leases de asiento — reserva con conexión (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md §5
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F4, paso 3)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import {
  adquirirLease, barrerLeasesExpirados, consumirLease, leasesVivos, liberarLease,
} from '../../src/ventas/lease.js';
import { crearBoleto, crearUsuario, ocuparAsiento, seedSalida } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('leases de asiento (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const T = new Date('2026-09-10T12:00:00Z');
  const mas = (segs: number): Date => new Date(T.getTime() + segs * 1000);

  // -------------------------------------------------------------------------
  it('concede un lease sobre un asiento libre y fija la expiración por parámetro', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const r = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, ahora: T,
    });

    expect(r.estado).toBe('otorgado');
    expect(r.leaseId).not.toBeNull();
    // `minutos_lease` = 15 → 900 s.
    expect(r.expiraEn!.getTime()).toBe(mas(900).getTime());
  });

  it('respeta una duración explícita', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const r = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, duracionSeg: 120, ahora: T,
    });
    expect(r.expiraEn!.getTime()).toBe(mas(120).getTime());
  });

  it('un asiento con ocupación firme que solapa devuelve `ocupado`, no lanza', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const u = await crearUsuario(db);
    await ocuparAsiento(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId: u,
      asiento: 5, desde: 0, hasta: 3,
    });

    const r = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 5, desde: 1, hasta: 2,
      sucursalId: fx.sucursales[1]!, ahora: T,
    });
    expect(r.estado).toBe('ocupado');
    expect(r.leaseId).toBeNull();
  });

  it('un segundo lease que solapa a uno vivo devuelve `lease_ajeno`', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const a = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, ahora: T,
    });
    expect(a.estado).toBe('otorgado');

    const b = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 1, hasta: 2,
      sucursalId: fx.sucursales[1]!, ahora: T,
    });
    expect(b.estado).toBe('lease_ajeno');
  });

  it('dos leases del mismo asiento en tramos DISJUNTOS conviven', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const a = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 1,
      sucursalId: fx.sucursales[0]!, ahora: T,
    });
    const b = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 1, hasta: 3,
      sucursalId: fx.sucursales[1]!, ahora: T,
    });
    expect([a.estado, b.estado]).toEqual(['otorgado', 'otorgado']);
  });

  it('liberar un lease lo deja disponible de nuevo; liberar dos veces es idempotente', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const a = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, ahora: T,
    });

    expect(await liberarLease(db, a.leaseId!, T)).toBe(true);
    expect(await liberarLease(db, a.leaseId!, T), 'segunda vez ya no cambia nada').toBe(false);

    const b = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[1]!, ahora: T,
    });
    expect(b.estado).toBe('otorgado');
  });

  it('un lease vencido no bloquea al siguiente: se libera solo al pedir de nuevo', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const a = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, duracionSeg: 1, ahora: T,
    });
    expect(a.estado).toBe('otorgado');

    const b = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[1]!, ahora: mas(60),
    });
    expect(b.estado).toBe('otorgado');
  });

  it('`barrerLeasesExpirados` libera los vencidos y deja los vivos', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, duracionSeg: 60, ahora: T,
    });
    await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 6, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, duracionSeg: 3600, ahora: T,
    });

    expect(await barrerLeasesExpirados(db, mas(120))).toBe(1);
    expect(await barrerLeasesExpirados(db, mas(120)), 'segunda pasada no encuentra nada').toBe(0);

    const vivos = await leasesVivos(db, fx.salidaId, mas(120));
    expect(vivos.map((v) => v.asientoNum)).toEqual([6]);
  });

  it('`consumirLease` ata el lease a un boleto y luego ya no se puede consumir', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const u = await crearUsuario(db);
    const a = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, ahora: T,
    });
    const boletoId = await crearBoleto(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId: u,
      asiento: 3, desde: 0, hasta: 3,
    });

    expect(await consumirLease(db, a.leaseId!, boletoId, T)).toBe(true);
    expect(await consumirLease(db, a.leaseId!, boletoId, T), 'ya consumido').toBe(false);
    expect(await leasesVivos(db, fx.salidaId, T), 'un lease consumido no está vivo').toEqual([]);
  });

  it('no se puede consumir un lease ya vencido', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    const u = await crearUsuario(db);
    const a = await adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, duracionSeg: 1, ahora: T,
    });
    const boletoId = await crearBoleto(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId: u,
      asiento: 3, desde: 0, hasta: 3,
    });
    expect(await consumirLease(db, a.leaseId!, boletoId, mas(60))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Entradas imposibles: aquí sí lanza
  // -------------------------------------------------------------------------
  it('lanza si la salida está en ruta', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    await db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [fx.salidaId]);
    await expect(adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, ahora: T,
    })).rejects.toThrow(/no se puede reservar/i);
  });

  it('lanza si el asiento no existe en el mapa', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    await expect(adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 99, desde: 0, hasta: 3,
      sucursalId: fx.sucursales[0]!, ahora: T,
    })).rejects.toThrow(/no existe o no es vendible/i);
  });

  it('lanza si el tramo está fuera de la ruta', async () => {
    const fx = await seedSalida(db, { paradas: 4, diasAdelante: 14 });
    await expect(adquirirLease(db, {
      salidaId: fx.salidaId, asientoNum: 3, desde: 2, hasta: 2,
      sucursalId: fx.sucursales[0]!, ahora: T,
    })).rejects.toThrow(/tramo/i);
  });
});
