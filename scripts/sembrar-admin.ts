/**
 * Siembra un usuario administrador con credencial para poder entrar en DEV.
 *
 *   npm run seed:admin
 *   npm run seed:admin -- --target nube
 *
 * Sobrescribe email y contraseña con las variables de entorno ADMIN_EMAIL y
 * ADMIN_PASSWORD (no las escribas en línea: expórtalas o usa un .env).
 *
 * En producción el hash Argon2id se calcula en la nube al crear la contraseña y
 * baja replicado como cualquier dato de clase A (03 §1.2). En local no hay quien
 * lo genere, así que este script existe solo para arrancar el entorno de
 * desarrollo: crea (si faltan) una agencia y una sucursal, el usuario admin, su
 * credencial y el vínculo a todas las sucursales, y fija la identidad del nodo.
 *
 * Es idempotente: correrlo de nuevo solo actualiza el hash.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { hashPassword } from '../src/auth/passwords.js';
import { resolveConnection, targetFromArgs } from '../src/db/connection.js';

const EMAIL = (process.env['ADMIN_EMAIL'] ?? 'admin@donaji.local').toLowerCase();
const PASSWORD = process.env['ADMIN_PASSWORD'] ?? 'donaji-admin';
const usoDefault = !process.env['ADMIN_PASSWORD'];

async function main(): Promise<void> {
  const target = targetFromArgs(process.argv.slice(2), 'local');
  const conn = resolveConnection(target);
  console.log(`Sembrando admin en ${target} (${conn.describe})`);

  const c = new Client(conn.config);
  await c.connect();

  try {
    await c.query('BEGIN');

    // 1 · Agencia.
    let { rows: ag } = await c.query<{ id: string; nombre: string }>(
      `SELECT id, nombre FROM core.agencia WHERE activo ORDER BY creado_en LIMIT 1`,
    );
    if (!ag[0]) {
      ag = (await c.query(
        `INSERT INTO core.agencia (nombre) VALUES ('Donaji (dev)') RETURNING id, nombre`,
      )).rows;
      console.log(`  agencia creada: ${ag[0]!.nombre}`);
    }
    const agenciaId = ag[0]!.id;

    // 2 · Al menos una sucursal.
    let { rows: sucs } = await c.query<{ id: string; nombre: string; codigo: string }>(
      `SELECT id, nombre, codigo FROM core.sucursal WHERE agencia_id = $1 ORDER BY creado_en`,
      [agenciaId],
    );
    if (sucs.length === 0) {
      sucs = (await c.query(
        `INSERT INTO core.sucursal (agencia_id, nombre, direccion_completa, telefono_principal, codigo)
         VALUES ($1, 'Terminal Dev', 'Sin dirección 1', '953 000 0000', 'D')
         RETURNING id, nombre, codigo`,
        [agenciaId],
      )).rows;
      console.log(`  sucursal creada: ${sucs[0]!.nombre} (${sucs[0]!.codigo})`);
    }

    // 3 · Usuario administrador (por email).
    const { rows: u } = await c.query<{ id: string; creado: boolean }>(
      `INSERT INTO core.usuario (nombre, email, rol)
       VALUES ('Administrador', $1::citext, 'administrador')
       ON CONFLICT (email) DO UPDATE SET rol = 'administrador', activo = true,
                                         effective_until = NULL
       RETURNING id, (xmax = 0) AS creado`,
      [EMAIL],
    );
    const usuarioId = u[0]!.id;
    console.log(`  usuario ${u[0]!.creado ? 'creado' : 'actualizado'}: ${EMAIL} (administrador)`);

    // 4 · Credencial Argon2id.
    await c.query(
      `INSERT INTO auth_local.credencial (usuario_id, hash_password, debe_cambiar)
       VALUES ($1, $2, false)
       ON CONFLICT (usuario_id) DO UPDATE
          SET hash_password = EXCLUDED.hash_password,
              hash_actualizado_en = now(), debe_cambiar = false,
              effective_until = NULL`,
      [usuarioId, await hashPassword(PASSWORD)],
    );

    // 5 · Vínculo a todas las sucursales.
    const { rowCount: vinculadas } = await c.query(
      `INSERT INTO core.usuario_sucursal (usuario_id, sucursal_id)
       SELECT $1, s.id FROM core.sucursal s WHERE s.activo
       ON CONFLICT (usuario_id, sucursal_id) DO NOTHING`,
      [usuarioId],
    );
    if (vinculadas) console.log(`  vinculado a ${vinculadas} sucursal(es)`);

    // 6 · Identidad del nodo (solo en local; la nube no es ninguna sucursal).
    if (target === 'local') {
      await c.query(
        `UPDATE sync.nodo
            SET sucursal_id = COALESCE(sucursal_id,
                  (SELECT id FROM core.sucursal WHERE activo ORDER BY creado_en LIMIT 1)),
                es_nube = false
          WHERE singleton`,
      );
    }

    await c.query('COMMIT');

    const { rows: nodo } = await c.query<{ sucursal_id: string | null }>(
      `SELECT sucursal_id FROM sync.nodo WHERE singleton`,
    );
    console.log('\nListo.');
    console.log(`  email    : ${EMAIL}`);
    console.log(`  password : ${usoDefault ? PASSWORD + '  (default — cámbiala con ADMIN_PASSWORD)' : '(la que pasaste en ADMIN_PASSWORD)'}`);
    console.log(`  nodo.sucursal_id: ${nodo[0]?.sucursal_id ?? '(sin fijar)'}`);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => { /* ya revertida */ });
    throw err;
  } finally {
    await c.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
