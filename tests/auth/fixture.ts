/**
 * Fixture de autenticación para pruebas contra PostgreSQL real.
 *
 * Todo corre dentro de una transacción que se revierte al final: la base de
 * desarrollo queda intacta.
 */

import type { Client } from 'pg';
import { hashPassword } from '../../src/auth/passwords.js';
import type { Rol } from '../../src/auth/rbac.js';

export const PASSWORD_OK = 'contrasena-de-prueba-9F2c';

// Argon2id es deliberadamente caro. Se hashea una sola vez para toda la suite.
let hashCache: string | null = null;
export async function hashPrueba(): Promise<string> {
  hashCache ??= await hashPassword(PASSWORD_OK);
  return hashCache;
}

export interface AuthFixture {
  agenciaId: string;
  sucursalAId: string;
  sucursalBId: string;
  usuarioId: string;
  email: string;
}

// `core.sucursal.codigo` es char(1) del alfabeto sin ambiguos (sin I, L, O, U) y
// es UNIQUE en toda la tabla. Como sólo hay ~29 valores y las pruebas siembran
// muchas sucursales, no se puede rotar a ciegas: se piden códigos que estén
// LIBRES en la base ahora mismo (incluye lo ya sembrado en dev y lo de la propia
// transacción).
const COD_ALFABETO = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
let n = 0;

async function codigosLibres(client: Client, cuantos: number): Promise<string[]> {
  const { rows } = await client.query<{ c: string }>(
    `SELECT c FROM unnest(string_to_array($1, NULL)) AS c
      WHERE c NOT IN (SELECT codigo FROM core.sucursal)
      ORDER BY c
      LIMIT $2`,
    [COD_ALFABETO, cuantos],
  );
  if (rows.length < cuantos) {
    throw new Error(`No quedan códigos de sucursal libres (se pidieron ${cuantos})`);
  }
  return rows.map((r) => r.c);
}

export interface SeedAuthOpts {
  rol?: Rol;
  /** 1 (solo sucursal A) o 2 (A y B). Por defecto 1. */
  sucursales?: 1 | 2;
  /** Omite crear la credencial: el usuario existe pero no puede entrar. */
  sinCredencial?: boolean;
  /** `effective_until` del usuario (baja diferida). */
  usuarioHasta?: Date | null;
  /** `effective_from` del usuario. */
  usuarioDesde?: Date | null;
}

/** Crea agencia + 2 sucursales + un usuario con credencial. Dentro de una tx abierta. */
export async function seedAuth(client: Client, opts: SeedAuthOpts = {}): Promise<AuthFixture> {
  const rol = opts.rol ?? 'vendedor';
  const suf = `${Date.now().toString(36)}${n++}`;
  const email = `u-${suf}@donaji.test`;
  const libres = await codigosLibres(client, 2);
  const codA = libres[0]!;
  const codB = libres[1]!;

  const { rows: ag } = await client.query<{ id: string }>(
    `INSERT INTO core.agencia (id, nombre) VALUES (core.uuid_v7(), 'Donaji Auth Test') RETURNING id`,
  );
  const agenciaId = ag[0]!.id;

  const sucursal = async (codigo: string, nombre: string): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.sucursal (id, agencia_id, nombre, direccion_completa, telefono_principal, codigo)
       VALUES (core.uuid_v7(), $1, $2, 'Calle 1', '953 000 0000', $3) RETURNING id`,
      [agenciaId, nombre, codigo],
    );
    return rows[0]!.id;
  };
  const sucursalAId = await sucursal(codA, `Terminal ${codA} ${suf}`);
  const sucursalBId = await sucursal(codB, `Terminal ${codB} ${suf}`);

  const { rows: u } = await client.query<{ id: string }>(
    `INSERT INTO core.usuario (id, nombre, email, rol, effective_from, effective_until)
     VALUES (core.uuid_v7(), 'Usuario Prueba', $1::citext, $2::text,
             coalesce($3::timestamptz, now()), $4::timestamptz)
     RETURNING id`,
    [email, rol, opts.usuarioDesde ?? null, opts.usuarioHasta ?? null],
  );
  const usuarioId = u[0]!.id;

  await client.query(
    `INSERT INTO core.usuario_sucursal (usuario_id, sucursal_id) VALUES ($1, $2)`,
    [usuarioId, sucursalAId],
  );
  if ((opts.sucursales ?? 1) === 2) {
    await client.query(
      `INSERT INTO core.usuario_sucursal (usuario_id, sucursal_id) VALUES ($1, $2)`,
      [usuarioId, sucursalBId],
    );
  }

  if (!opts.sinCredencial) {
    await client.query(
      `INSERT INTO auth_local.credencial (usuario_id, hash_password) VALUES ($1, $2)`,
      [usuarioId, await hashPrueba()],
    );
  }

  // El nodo "es" esta sucursal recién creada: su `sync.salud` está vacío, así que
  // el stale-guard no la ve degradada aunque `npm run sync` haya dejado una fila
  // para OTRA sucursal en la base de dev. Las pruebas de modo degradado llaman a
  // `fijarNodo` después y ganan.
  await client.query(
    `UPDATE sync.nodo SET sucursal_id = $1::uuid, es_nube = false WHERE singleton`,
    [sucursalAId],
  );

  return { agenciaId, sucursalAId, sucursalBId, usuarioId, email };
}

/**
 * Fija la identidad del nodo y, si `horas` no es null, marca la última sync
 * exitosa a esa antigüedad **relativa a `ahora`** (no al reloj de la base, que
 * en pruebas está a días de distancia del instante inyectado). `null` = el nodo
 * nunca sincronizó.
 */
export async function fijarNodo(
  client: Client, sucursalId: string, horas: number | null, ahora: Date,
): Promise<void> {
  await client.query(
    `UPDATE sync.nodo SET sucursal_id = $1::uuid, es_nube = false WHERE singleton`,
    [sucursalId],
  );
  await client.query(`DELETE FROM sync.salud WHERE sucursal_id = $1::uuid`, [sucursalId]);
  if (horas === null) return;
  await client.query(
    `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa)
     VALUES ($1::uuid, $2::timestamptz - make_interval(hours => $3::int))`,
    [sucursalId, ahora, horas],
  );
}
