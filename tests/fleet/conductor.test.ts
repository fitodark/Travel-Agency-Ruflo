/**
 * Cambio de conductor — los cuatro casos (contra PostgreSQL real).
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5.3
 *                  docs/architecture/04-riesgos-roadmap.md §3 (F3, criterios 3 y 4)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { cambiarConductor } from '../../src/fleet/conductor.js';
import { cupoDeSalida } from '../../src/fleet/cupo.js';
import { materializarHorario } from '../../src/fleet/materializar.js';
import { crearConductorTipo, crearUsuario, seedRuta, venderEn, type RutaFixture } from './fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('cambio de conductor (PostgreSQL real)', () => {
  let db: Client;
  let fx: RutaFixture;
  let salidaId: string;
  let gerente: string;
  let vendedor: string;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('BEGIN');
    fx = await seedRuta(db, { paradas: 2 });
    await materializarHorario(db, fx.horarioId, { dias: 0 });
    const sal = await db.query<{ id: string }>(
      `SELECT id FROM core.salida WHERE horario_id = $1 LIMIT 1`, [fx.horarioId],
    );
    salidaId = sal.rows[0]!.id;
    gerente = await crearUsuario(db, 'gerente');
    vendedor = await crearUsuario(db, 'vendedor');
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  const otroConductorSprinter = async (): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO core.conductor (nombre, tipo_unidad_id) VALUES ('Relevo', $1) RETURNING id`,
      [fx.tipoUnidadId],
    );
    return rows[0]!.id;
  };
  const mapaSnapshot = async (): Promise<{ asientos: number; conductor: string }> => {
    const { rows } = await db.query<{ n: number; c: string }>(
      `SELECT jsonb_array_length(mapa_snapshot->'asientos') AS n, conductor_nombre_snapshot AS c
         FROM core.salida WHERE id = $1`, [salidaId],
    );
    return { asientos: rows[0]!.n, conductor: rows[0]!.c };
  };

  // -------------------------------------------------------------------------
  // Caso 3 — sin boletos vendidos: libre, re-materializa mapa y cupos
  // -------------------------------------------------------------------------
  it('caso 3 · sin boletos: el cambio re-materializa el mapa y el cupo', async () => {
    const mini = await crearConductorTipo(db);
    const r = await cambiarConductor(db, {
      salidaId, conductorNuevoId: mini.conductorId, usuarioId: vendedor,
    });
    expect(r).toMatchObject({ caso: 3, estado: 'aplicado', boletosAfectados: 0 });

    expect((await mapaSnapshot()).asientos, 'ahora el mapa es el de la unidad chica').toBe(6);
    const cupo = await cupoDeSalida(db, salidaId);
    expect(cupo[0]!.bloques.sort()).toEqual(['X0', 'X1']);
  });

  // -------------------------------------------------------------------------
  // Caso 1 — compatible: NO toca mapa ni cupos
  // -------------------------------------------------------------------------
  it('caso 1 · relevo del mismo tipo: cambia el conductor y nada más', async () => {
    await venderEn(db, { salidaId, sucursalId: fx.sucursales[0]!, usuarioId: vendedor, asiento: 5 });
    const cupoAntes = await cupoDeSalida(db, salidaId);

    const r = await cambiarConductor(db, {
      salidaId, conductorNuevoId: await otroConductorSprinter(), usuarioId: vendedor,
    });
    expect(r).toMatchObject({ caso: 1, estado: 'aplicado', boletosAfectados: 0 });

    expect((await mapaSnapshot()).asientos, 'el mapa NO cambia').toBe(18);
    expect(await cupoDeSalida(db, salidaId), 'el cupo NO cambia').toEqual(cupoAntes);
    expect((await mapaSnapshot()).conductor).toBe('Relevo');
  });

  it('caso 1 · otro tipo de unidad pero con los mismos bloques también es compatible', async () => {
    await venderEn(db, { salidaId, sucursalId: fx.sucursales[0]!, usuarioId: vendedor, asiento: 5 });
    const mapaRes = await db.query<{ mapa: object }>(
      `SELECT mapa FROM core.tipo_unidad WHERE clave = 'SPRINTER-18'`,
    );
    const clon = await crearConductorTipo(db, {
      mapa: mapaRes.rows[0]!.mapa, numAsientos: 18, clave: `SPR-CLON-${Date.now()}`,
    });

    const r = await cambiarConductor(db, { salidaId, conductorNuevoId: clon.conductorId, usuarioId: vendedor });
    expect(r.caso).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Caso 2 — incompatible (criterio 4 de F3)
  // -------------------------------------------------------------------------
  it('caso 2 · un vendedor NO puede forzar un cambio incompatible', async () => {
    await venderEn(db, { salidaId, sucursalId: fx.sucursales[0]!, usuarioId: vendedor, asiento: 15 });
    const mini = await crearConductorTipo(db);

    await expect(cambiarConductor(db, {
      salidaId, conductorNuevoId: mini.conductorId, usuarioId: vendedor,
    })).rejects.toThrow(/bloqueado para el rol vendedor/i);
  });

  it('caso 2 · sin conexión queda pendiente para la siguiente sync, sin tocar la salida', async () => {
    await venderEn(db, { salidaId, sucursalId: fx.sucursales[0]!, usuarioId: vendedor, asiento: 15 });
    const mini = await crearConductorTipo(db);

    const r = await cambiarConductor(db, {
      salidaId, conductorNuevoId: mini.conductorId, usuarioId: gerente, conConexion: false,
    });
    expect(r).toMatchObject({ caso: 2, estado: 'pendiente', boletosAfectados: 0 });

    expect((await mapaSnapshot()).asientos, 'la salida no se tocó').toBe(18);
    const { rows } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.cambio_conductor WHERE id = $1`, [r.cambioId],
    );
    expect(rows[0]!.estado).toBe('pendiente');
  });

  it('caso 2 · con conexión, el gerente fuerza: encola los huérfanos y abre excepción crítica', async () => {
    const bValido = await venderEn(db, { salidaId, sucursalId: fx.sucursales[0]!, usuarioId: vendedor, asiento: 3 });
    const bHuerfano = await venderEn(db, { salidaId, sucursalId: fx.sucursales[0]!, usuarioId: vendedor, asiento: 15 });
    const mini = await crearConductorTipo(db);   // 6 plazas: el 15 no existe

    const r = await cambiarConductor(db, {
      salidaId, conductorNuevoId: mini.conductorId, usuarioId: gerente, motivo: 'baja del conductor',
    });
    expect(r).toMatchObject({ caso: 2, estado: 'aplicado', boletosAfectados: 1 });

    expect((await mapaSnapshot()).asientos, 'el mapa se recalculó').toBe(6);

    const { rows: estados } = await db.query<{ id: string; estado: string }>(
      `SELECT id, estado FROM core.boleto WHERE id = ANY($1::uuid[])`, [[bValido, bHuerfano]],
    );
    const porId = new Map(estados.map((e) => [e.id, e.estado]));
    expect(porId.get(bValido), 'el que sí cabe sigue emitido').toBe('emitido');
    expect(porId.get(bHuerfano), 'el huérfano entra a la cola de reasignación').toBe('conflicto_sobreventa');

    const { rows: oc } = await db.query<{ estado: string }>(
      `SELECT estado FROM core.asiento_ocupacion WHERE boleto_id = $1`, [bHuerfano],
    );
    expect(oc[0]!.estado).toBe('conflicto');

    const { rows: exc } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.excepcion
        WHERE tipo = 'mapa_incompatible' AND severidad = 'critica' AND entidad_id = $1`,
      [bHuerfano],
    );
    expect(Number(exc[0]!.n)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Caso 4 — salida en ruta o finalizada
  // -------------------------------------------------------------------------
  it('caso 4 · una salida en ruta no admite cambio de conductor', async () => {
    await db.query(`UPDATE core.salida SET estado = 'en_ruta' WHERE id = $1`, [salidaId]);
    await expect(cambiarConductor(db, {
      salidaId, conductorNuevoId: await otroConductorSprinter(), usuarioId: gerente,
    })).rejects.toThrow(/en_ruta|caso 4/i);
  });

  it('registra siempre una fila en core.cambio_conductor con el caso correcto', async () => {
    await cambiarConductor(db, {
      salidaId, conductorNuevoId: await otroConductorSprinter(), usuarioId: vendedor,
    });
    const { rows } = await db.query<{ caso: number; conductor_anterior_id: string }>(
      `SELECT caso, conductor_anterior_id FROM core.cambio_conductor WHERE salida_id = $1`, [salidaId],
    );
    expect(rows[0]!.caso).toBe(3);   // la salida del beforeEach no tiene boletos
    expect(rows[0]!.conductor_anterior_id).toBe(fx.conductorId);
  });
});
