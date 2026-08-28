/**
 * Fixture de caja: agencia + sucursales + usuarios, ligero.
 * Todo dentro de una transacción revertida por el test.
 */

import type { Client } from 'pg';

let n = 0;
const COD = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

async function codigosLibres(client: Client, cuantos: number): Promise<string[]> {
  const { rows } = await client.query<{ c: string }>(
    `SELECT c FROM unnest(string_to_array($1, NULL)) c
      WHERE c NOT IN (SELECT codigo FROM core.sucursal) ORDER BY c LIMIT $2`,
    [COD, cuantos],
  );
  return rows.map((r) => r.c);
}

export interface CajaFixture {
  agenciaId: string;
  /** Dos sucursales, para probar el "un corte por sucursal". */
  sucursales: string[];
}

export async function seedCaja(client: Client, cuantasSucursales = 2): Promise<CajaFixture> {
  const suf = `${Date.now().toString(36)}${n++}`;
  const { rows: ag } = await client.query<{ id: string }>(
    `INSERT INTO core.agencia (nombre) VALUES ('Donaji Caja Test ' || $1) RETURNING id`,
    [suf],
  );
  const agenciaId = ag[0]!.id;

  const cods = await codigosLibres(client, cuantasSucursales);
  const sucursales: string[] = [];
  for (let i = 0; i < cuantasSucursales; i++) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.sucursal (agencia_id, nombre, direccion_completa, telefono_principal, codigo, zona_horaria)
       VALUES ($1, $2, 'Calle 1', '953 000 0000', $3, 'America/Mexico_City') RETURNING id`,
      [agenciaId, `Sucursal ${i} ${suf}`, cods[i]],
    );
    sucursales.push(rows[0]!.id);
  }

  // El nodo "es" la primera sucursal recién creada: `sync.salud` vacío para ella,
  // así que el stale-guard del login no la ve degradada aunque un motor de sync
  // vivo esté escribiendo salud para la sucursal de dev (ver nota en
  // tests/auth/fixture.ts). Va después de los INSERT: la transacción ya tiene el
  // lock de `sync.hlc_estado` y tomar `sync.nodo` no abre un ciclo.
  await client.query(
    `UPDATE sync.nodo SET sucursal_id = $1::uuid, es_nube = false WHERE singleton`,
    [sucursales[0]],
  );

  return { agenciaId, sucursales };
}

/**
 * Ejecuta `fn` esperando que lance; deja la transacción utilizable después
 * (un error de Postgres la aborta hasta el `ROLLBACK`, así que se aísla con un
 * SAVEPOINT). Devuelve el error para inspeccionarlo.
 */
export async function esperaError(
  client: Client, fn: () => Promise<unknown>,
): Promise<Error> {
  await client.query('SAVEPOINT sp_err');
  try {
    await fn();
    await client.query('RELEASE SAVEPOINT sp_err');
    throw new Error('se esperaba un error y la operación tuvo éxito');
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_err');
    return e as Error;
  }
}

export async function crearUsuario(client: Client, rol = 'vendedor'): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO core.usuario (nombre, email, rol)
     VALUES ('U ' || $1, ('u' || floor(random()*1e9)::bigint || '@donaji.test')::citext, $1::text)
     RETURNING id`,
    [rol],
  );
  return rows[0]!.id;
}
