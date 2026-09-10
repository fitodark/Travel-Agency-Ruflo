/**
 * Fase 5c — autoría de rutas con banderas por parada, CRUD de puntos, reemplazo
 * de ruta por vigencia (D5) y reporte de huérfanos (D12).
 *
 * Contra PostgreSQL real, en transacción revertida.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { crearHorario, crearRuta, listarRutasDetalle } from '../../src/admin/horarios.js';
import { crearPunto, darDeBajaPunto, editarPunto, listarPuntos } from '../../src/admin/puntos.js';
import { boletosHuerfanos, reemplazarRuta } from '../../src/admin/rutas-reemplazo.js';
import { seedRuta } from '../fleet/fixture.js';
import { seedSalida } from '../ventas/fixture.js';
import { crearUsuario, seedCorte, sembrarOcupacion } from '../ventas/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('consola · rutas con paradas / puntos / reemplazo (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  /** Dos sucursales terminales con su punto terminal asegurado. */
  const dosTerminales = async (): Promise<{ puntos: string[]; sucursales: string[] }> => {
    const r = await seedRuta(db, { paradas: 2 });
    return { puntos: r.puntos, sucursales: r.sucursales };
  };

  // ---- puntos -----------------------------------------------------------
  it('crearPunto de una parada exige nombre y zona horaria; el terminal es idempotente', async () => {
    await expect(crearPunto(db, { tipo: 'parada', nombre: 'Cuautla' }))
      .rejects.toThrow(/zona horaria/i);

    const { id } = await crearPunto(db, {
      tipo: 'parada', nombre: 'Parada Cuautla', zonaHoraria: 'America/Mexico_City',
      referencia: 'sobre carretera', municipio: 'Cuautla',
    });
    const p = (await listarPuntos(db)).find((x) => x.id === id)!;
    expect(p.tipo).toBe('parada');
    expect(p.sucursalId).toBeNull();
    expect(p.enUso).toBe(false);

    // Terminal: el id determinista no duplica.
    const { sucursales } = await dosTerminales();
    const a = await crearPunto(db, { tipo: 'terminal', sucursalId: sucursales[0]! });
    const b = await crearPunto(db, { tipo: 'terminal', sucursalId: sucursales[0]! });
    expect(a.id).toBe(b.id);
  });

  it('editarPunto cambia campos; darDeBajaPunto rechaza un punto en una ruta activa', async () => {
    const { id } = await crearPunto(db, {
      tipo: 'parada', nombre: 'X', zonaHoraria: 'America/Mexico_City',
    });
    await editarPunto(db, id, { nombre: 'Parada nueva', municipio: 'Izúcar' });
    let p = (await listarPuntos(db)).find((x) => x.id === id)!;
    expect(p.nombre).toBe('Parada nueva');
    expect(p.municipio).toBe('Izúcar');

    // Metido en una ruta activa ⇒ no se puede dar de baja.
    const { puntos } = await dosTerminales();
    await crearRuta(db, {
      nombre: `Ruta ${Date.now()}`,
      paradas: [
        { puntoId: puntos[0]!, permiteAscenso: true, permiteDescenso: true },
        { puntoId: id, permiteAscenso: false, permiteDescenso: true },
        { puntoId: puntos[1]!, permiteAscenso: true, permiteDescenso: true },
      ],
    });
    await expect(darDeBajaPunto(db, id)).rejects.toThrow(/ruta activa/i);
  });

  // ---- crearRuta con banderas -----------------------------------------
  it('crearRuta con contrato `paradas`: guarda las banderas por parada', async () => {
    const parada = await crearPunto(db, {
      tipo: 'parada', nombre: `Descenso ${Date.now()}`, zonaHoraria: 'America/Mexico_City',
    });
    const { puntos } = await dosTerminales();
    const { id } = await crearRuta(db, {
      nombre: `Ruta banderas ${Date.now()}`,
      paradas: [
        { puntoId: puntos[0]!, permiteAscenso: true, permiteDescenso: true },
        { puntoId: parada.id, permiteAscenso: false, permiteDescenso: true },
        { puntoId: puntos[1]!, permiteAscenso: true, permiteDescenso: true },
      ],
    });
    const ruta = (await listarRutasDetalle(db)).find((r) => r.id === id)!;
    expect(ruta.paradas.map((p) => p.orden)).toEqual([0, 1, 2]);
    expect(ruta.paradas[1]).toMatchObject({ tipo: 'parada', permiteAscenso: false, permiteDescenso: true });
    expect(ruta.paradas[0]).toMatchObject({ tipo: 'terminal', permiteAscenso: true, permiteDescenso: true });
  });

  it('crearRuta rechaza una parada no-terminal en un extremo, y extremos sin ambas banderas', async () => {
    const parada = await crearPunto(db, {
      tipo: 'parada', nombre: `P ${Date.now()}`, zonaHoraria: 'America/Mexico_City',
    });
    const { puntos } = await dosTerminales();

    await expect(crearRuta(db, {
      nombre: 'mala', paradas: [
        { puntoId: parada.id, permiteAscenso: true, permiteDescenso: true },
        { puntoId: puntos[1]!, permiteAscenso: true, permiteDescenso: true },
      ],
    })).rejects.toThrow(/deben ser terminales/i);

    await expect(crearRuta(db, {
      nombre: 'mala2', paradas: [
        { puntoId: puntos[0]!, permiteAscenso: true, permiteDescenso: false },
        { puntoId: puntos[1]!, permiteAscenso: true, permiteDescenso: true },
      ],
    })).rejects.toThrow(/ascenso y descenso/i);
  });

  it('el contrato `sucursalIds` sigue funcionando (todo terminal, ambas banderas)', async () => {
    const { sucursales } = await dosTerminales();
    const { id } = await crearRuta(db, { nombre: `compat ${Date.now()}`, sucursalIds: sucursales });
    const ruta = (await listarRutasDetalle(db)).find((r) => r.id === id)!;
    expect(ruta.paradas).toHaveLength(2);
    expect(ruta.paradas.every((p) => p.permiteAscenso && p.permiteDescenso)).toBe(true);
  });

  // ---- crearHorario: pasos solo para puntos con ascenso ---------------
  it('crearHorario rechaza un paso sobre una parada de solo descenso', async () => {
    const parada = await crearPunto(db, {
      tipo: 'parada', nombre: `D ${Date.now()}`, zonaHoraria: 'America/Mexico_City',
    });
    const { puntos } = await dosTerminales();
    const { id: rutaId } = await crearRuta(db, {
      nombre: `Ruta h ${Date.now()}`,
      paradas: [
        { puntoId: puntos[0]!, permiteAscenso: true, permiteDescenso: true },
        { puntoId: parada.id, permiteAscenso: false, permiteDescenso: true },
        { puntoId: puntos[1]!, permiteAscenso: true, permiteDescenso: true },
      ],
    });
    const ruta = (await listarRutasDetalle(db)).find((r) => r.id === rutaId)!;
    const pasoDe = (orden: number) => {
      const p = ruta.paradas.find((x) => x.orden === orden)!;
      return { rutaParadaId: p.id, orden, horaPaso: '07:00' };
    };

    await expect(crearHorario(db, {
      rutaId, horaSalida: '07:00', diasSemana: [1, 2, 3],
      pasos: [pasoDe(0), pasoDe(1), pasoDe(2)],
    })).rejects.toThrow(/solo descenso/i);

    // Sin el paso de la parada de descenso: OK.
    const ok = await crearHorario(db, {
      rutaId, horaSalida: '07:00', diasSemana: [1, 2, 3],
      pasos: [pasoDe(0), pasoDe(2)],
    });
    expect(ok.id).toBeTruthy();
  });

  // ---- reemplazo por vigencia (D5) + huérfanos (D12) -----------------
  it('reemplazarRuta cierra la vieja por vigencia y lista los boletos huérfanos', async () => {
    // Ruta vieja con una salida a 40 días y un boleto vendido en ella.
    const fx = await seedSalida(db, { paradas: 2, diasAdelante: 40 });
    const usuarioId = await crearUsuario(db);
    const corteId = await seedCorte(db, fx.sucursales[0]!, usuarioId);
    await sembrarOcupacion(db, {
      salidaId: fx.salidaId, sucursalId: fx.sucursales[0]!, usuarioId, corteId,
      asiento: 4, desde: 0, hasta: 1, estado: 'firme', pagar: true,
    });

    const { rows: rutaRow } = await db.query<{ ruta_id: string }>(
      `SELECT ruta_id FROM core.horario WHERE id = $1`, [fx.horarioId],
    );
    const rutaViejaId = rutaRow[0]!.ruta_id;

    const desde = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const { puntos } = await dosTerminales();
    const r = await reemplazarRuta(db, {
      rutaViejaId, nombre: `Ruta v2 ${Date.now()}`, vigenteDesde: desde,
      paradas: [
        { puntoId: puntos[0]!, permiteAscenso: true, permiteDescenso: true },
        { puntoId: puntos[1]!, permiteAscenso: true, permiteDescenso: true },
      ],
    });

    // La vieja quedó con vigente_hasta = desde - 1; la nueva encadena por reemplaza_a.
    const { rows: v } = await db.query<{ vigente_hasta: string; reemplaza: string | null }>(
      `SELECT vigente_hasta::text, reemplaza_a AS reemplaza FROM core.ruta WHERE id = $1`, [rutaViejaId],
    );
    expect(v[0]!.vigente_hasta).toBe(r.rutaViejaVigenteHasta);
    const { rows: nueva } = await db.query<{ reemplaza: string }>(
      `SELECT reemplaza_a AS reemplaza FROM core.ruta WHERE id = $1`, [r.id],
    );
    expect(nueva[0]!.reemplaza).toBe(rutaViejaId);

    // El boleto de la salida a 40 días es huérfano (viaja después de `desde`).
    expect(r.huerfanos.map((h) => h.asiento)).toContain(4);
    const h = r.huerfanos.find((x) => x.asiento === 4)!;
    expect(h.estatusPago).toBe('pagado');
    expect(h.folio).toBeTruthy();

    // No se puede reemplazar dos veces.
    await expect(reemplazarRuta(db, {
      rutaViejaId, nombre: 'otra', vigenteDesde: desde,
      paradas: [
        { puntoId: puntos[0]!, permiteAscenso: true, permiteDescenso: true },
        { puntoId: puntos[1]!, permiteAscenso: true, permiteDescenso: true },
      ],
    })).rejects.toThrow(/ya fue reemplazada/i);
  });

  it('reemplazarRuta exige fecha futura', async () => {
    const fx = await seedSalida(db, { paradas: 2, diasAdelante: 30 });
    const { rows } = await db.query<{ ruta_id: string; hoy: string }>(
      `SELECT h.ruta_id, current_date::text AS hoy FROM core.horario h WHERE h.id = $1`,
      [fx.horarioId],
    );
    const { puntos } = await dosTerminales();
    // `hoy` según la base (no `new Date()` en UTC, que de noche ya es "mañana").
    await expect(reemplazarRuta(db, {
      rutaViejaId: rows[0]!.ruta_id, nombre: 'x',
      vigenteDesde: rows[0]!.hoy,
      paradas: [
        { puntoId: puntos[0]!, permiteAscenso: true, permiteDescenso: true },
        { puntoId: puntos[1]!, permiteAscenso: true, permiteDescenso: true },
      ],
    })).rejects.toThrow(/futura/i);
  });

  it('boletosHuerfanos vacío cuando no hay salidas después de la fecha', async () => {
    const fx = await seedSalida(db, { paradas: 2, diasAdelante: 5 });
    const { rows } = await db.query<{ ruta_id: string }>(
      `SELECT ruta_id FROM core.horario WHERE id = $1`, [fx.horarioId],
    );
    const lejos = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    expect(await boletosHuerfanos(db, rows[0]!.ruta_id, lejos)).toEqual([]);
  });
});
