/**
 * La invariante central del sistema: un asiento, un pasajero, por tramo.
 *
 * Blueprint v0.2 · docs/architecture/01b-consistencia-asientos.md
 *
 * Estas pruebas corren contra PostgreSQL REAL, no contra un mock. La garantía vive en
 * una restricción `EXCLUDE USING gist` del motor, así que un mock probaría el mock.
 * Si no hay DATABASE_URL, se omiten en vez de fallar.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { ocupar, seedFixture, type Fixture } from './fixture.js';

/** Cuenta ocupaciones de un asiento en una salida, opcionalmente filtrando por estado. */
async function ocupadas(client: Client, salidaId: string, asiento: number, estado?: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM core.asiento_ocupacion
      WHERE salida_id = $1 AND asiento_num = $2 AND ($3::text IS NULL OR estado = $3)`,
    [salidaId, asiento, estado ?? null],
  );
  return Number(rows[0]!.n);
}

// Corre contra la base LOCAL, nunca contra la nube: estas pruebas crean y revierten
// datos, y la nube es compartida. `DATABASE_URL` apunta a Supabase desde que existe el
// proyecto, así que leerla aquí a ciegas sería escribir en producción.
const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;

run('invariante de asiento (PostgreSQL real)', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = new Client(resolveConnection('local').config);
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  // Cada prueba vive dentro de su propia transacción revertida: la base de desarrollo
  // queda exactamente como estaba.
  beforeEach(async () => {
    await client.query('BEGIN');
    fx = await seedFixture(client);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('rechaza que dos sucursales vendan el mismo asiento en tramos que se traslapan', async () => {
    // S1 (origen) vende el asiento 9 de punta a punta.
    await ocupar(client, { fx, asiento: 9, tramos: '[0,3)', sucursalId: fx.sucursal1Id });

    // S2 (intermedia) intenta el mismo asiento desde la parada 1. Se traslapa.
    await expect(
      ocupar(client, { fx, asiento: 9, tramos: '[1,3)', sucursalId: fx.sucursal2Id }),
    ).rejects.toThrow(/exclusi|exclusion|conflict/i);
  });

  it('permite el mismo asiento en tramos disjuntos — es reventa legítima del lugar', async () => {
    // Alguien baja en la parada 1 y otro pasajero ocupa ese asiento hasta el final.
    await ocupar(client, { fx, asiento: 5, tramos: '[0,1)', sucursalId: fx.sucursal1Id });
    // Si esto lanzara, la prueba falla: es la aserción.
    await ocupar(client, { fx, asiento: 5, tramos: '[1,3)', sucursalId: fx.sucursal2Id });
    expect(await ocupadas(client, fx.salidaId, 5)).toBe(2);
  });

  it('libera el asiento cuando la ocupación previa no está firme', async () => {
    // El boleto se cancela; la OCUPACIÓN se libera. Son cosas distintas: el boleto
    // sobrevive con activo=false para la auditoría, el asiento vuelve al pool.
    await ocupar(client, {
      fx, asiento: 7, tramos: '[0,3)', sucursalId: fx.sucursal1Id, estado: 'liberado',
    });
    await ocupar(client, { fx, asiento: 7, tramos: '[0,3)', sucursalId: fx.sucursal2Id });
    expect(await ocupadas(client, fx.salidaId, 7, 'firme')).toBe(1);
  });

  it('aisla salidas distintas: el asiento 9 de mañana no choca con el de hoy', async () => {
    const otra = await client.query<{ id: string }>(
      `INSERT INTO core.salida (id, horario_id, fecha_operacion, tipo_unidad_id, mapa_snapshot)
       SELECT core.uuid_v7(), $1, current_date + 8, id, mapa FROM core.tipo_unidad WHERE id = $2
       RETURNING id`,
      [fx.horarioId, fx.tipoUnidadId],
    );
    const otraId = otra.rows[0]!.id;
    await ocupar(client, { fx, asiento: 9, tramos: '[0,3)', sucursalId: fx.sucursal1Id });
    await ocupar(client, { fx, salidaId: otraId, asiento: 9, tramos: '[0,3)', sucursalId: fx.sucursal1Id });
    expect(await ocupadas(client, otraId, 9)).toBe(1);
  });

  it('la Sprinter sembrada tiene 18 asientos, no 19', async () => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT jsonb_array_length(mapa->'asientos')::int AS n FROM core.tipo_unidad WHERE id = $1`,
      [fx.tipoUnidadId],
    );
    expect(rows[0]!.n).toBe(18);
  });
});
