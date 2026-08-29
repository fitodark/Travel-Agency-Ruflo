/**
 * Siembra un escenario de QA para probar el inicio de sesión: varias sucursales,
 * usuarios de cada rol y asignaciones cruzadas.
 *
 *   npm run seed:qa                       # contra la base local
 *   npm run seed:qa -- --target nube      # contra Supabase (propaga a los nodos)
 *   npm run seed:qa -- --sucursal T       # el nodo local representa a Tuxtepec
 *
 * (para sembrar en las dos, córrelo dos veces: una sin `--target` y otra con
 * `--target nube`.)
 *
 * Contexto: el CRUD real de usuarios/sucursales es la consola de F2b
 * (`src/admin/`, `npm run admin`), pero escribe en la nube y necesita despliegue
 * + sync para llegar a un nodo. Este script escribe DIRECTO en la base —igual que
 * `sembrar-admin.ts`— para que QA tenga el escenario en minutos y sin infra.
 *
 * En producción el hash Argon2id se calcula en la nube y baja replicado (03 §1.2);
 * aquí se calcula localmente porque no hay quien lo genere en un nodo aislado.
 *
 * Es idempotente: correrlo de nuevo reactiva lo que un test haya dado de baja y
 * refresca los hashes.
 *
 * ESCENARIO
 *   Sucursales:  Oaxaca Centro (1) · Tuxtepec (2) · Puebla (3)
 *   (códigos numéricos a propósito: no chocan con los que hardcodean las pruebas
 *    de `tests/admin/` —W, X, Y, Z— ni con la sucursal `D` de `sembrar-admin`.)
 *   Usuarios (contraseña = QA_PASSWORD o 'donaji-qa'):
 *     admin@donaji.local        administrador   1, 2, 3   -> picker con 3 opciones
 *     gerente@donaji.local      gerente         1         -> sesión directa, sin picker
 *     vendedor.oax@donaji.local vendedor        1         -> sesión directa
 *     vendedor.tux@donaji.local vendedor        2         -> puede entrar en cualquier nodo
 *     multi@donaji.local        vendedor        1, 3      -> picker con 2 opciones (no admin)
 *     sin.sucursal@donaji.local vendedor        (ninguna) -> login rechazado: sin_sucursal_activa
 */

import 'dotenv/config';
import { Client } from 'pg';
import { hashPassword } from '../src/auth/passwords.js';
import { resolveConnection, targetFromArgs } from '../src/db/connection.js';

const PASSWORD = process.env['QA_PASSWORD'] ?? 'donaji-qa';

interface DefSucursal {
  codigo: string;
  nombre: string;
  direccion: string;
  telefono: string;
}

interface DefUsuario {
  email: string;
  nombre: string;
  rol: 'administrador' | 'gerente' | 'vendedor';
  /** Códigos de sucursal a los que se asigna. Vacío = sin sucursal activa. */
  sucursales: string[];
}

const SUCURSALES: DefSucursal[] = [
  { codigo: '1', nombre: 'Oaxaca Centro', direccion: 'Av. Independencia 100, Centro', telefono: '951 100 0001' },
  { codigo: '2', nombre: 'Tuxtepec', direccion: 'Blvd. Benito Juárez 200', telefono: '287 200 0002' },
  { codigo: '3', nombre: 'Puebla', direccion: 'Calz. Zaragoza 300', telefono: '222 300 0003' },
];

const USUARIOS: DefUsuario[] = [
  { email: 'admin@donaji.local', nombre: 'Administrador QA', rol: 'administrador', sucursales: ['1', '2', '3'] },
  { email: 'gerente@donaji.local', nombre: 'Gerente Oaxaca', rol: 'gerente', sucursales: ['1'] },
  { email: 'vendedor.oax@donaji.local', nombre: 'Vendedor Oaxaca', rol: 'vendedor', sucursales: ['1'] },
  { email: 'vendedor.tux@donaji.local', nombre: 'Vendedor Tuxtepec', rol: 'vendedor', sucursales: ['2'] },
  { email: 'multi@donaji.local', nombre: 'Vendedor Multisucursal', rol: 'vendedor', sucursales: ['1', '3'] },
  { email: 'sin.sucursal@donaji.local', nombre: 'Vendedor Sin Sucursal', rol: 'vendedor', sucursales: [] },
];

async function sembrar(c: Client, target: 'local' | 'nube', nodoCodigo: string): Promise<void> {
  await c.query('BEGIN');
  try {
    // 1 · Agencia (reutiliza la que haya, o crea la de dev).
    let { rows: ag } = await c.query<{ id: string }>(
      `SELECT id FROM core.agencia WHERE activo ORDER BY creado_en LIMIT 1`,
    );
    if (!ag[0]) {
      ag = (await c.query(`INSERT INTO core.agencia (nombre) VALUES ('Donaji (dev)') RETURNING id`)).rows;
    }
    const agenciaId = ag[0]!.id;

    // 2 · Sucursales, indexadas por código.
    const sucursalId = new Map<string, string>();
    for (const s of SUCURSALES) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO core.sucursal (agencia_id, nombre, direccion_completa, telefono_principal, codigo)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (codigo) DO UPDATE
            SET nombre = EXCLUDED.nombre, direccion_completa = EXCLUDED.direccion_completa,
                telefono_principal = EXCLUDED.telefono_principal, activo = true, effective_until = NULL
         RETURNING id`,
        [agenciaId, s.nombre, s.direccion, s.telefono, s.codigo],
      );
      sucursalId.set(s.codigo, rows[0]!.id);
    }

    // 3 · Usuarios, credenciales y asignaciones.
    const hash = await hashPassword(PASSWORD);
    for (const u of USUARIOS) {
      const { rows: ur } = await c.query<{ id: string }>(
        `INSERT INTO core.usuario (nombre, email, rol)
         VALUES ($1, $2::citext, $3)
         ON CONFLICT (email) DO UPDATE
            SET nombre = EXCLUDED.nombre, rol = EXCLUDED.rol, activo = true, effective_until = NULL
         RETURNING id`,
        [u.nombre, u.email, u.rol],
      );
      const usuarioId = ur[0]!.id;

      await c.query(
        `INSERT INTO auth_local.credencial (usuario_id, hash_password, debe_cambiar)
         VALUES ($1, $2, false)
         ON CONFLICT (usuario_id) DO UPDATE
            SET hash_password = EXCLUDED.hash_password, hash_actualizado_en = now(),
                debe_cambiar = false, activo = true, effective_until = NULL`,
        [usuarioId, hash],
      );

      // Asignaciones deseadas: alta/reactivación de las que toca, baja de las demás.
      const objetivo = u.sucursales.map((cod) => sucursalId.get(cod)!);
      for (const sid of objetivo) {
        await c.query(
          `INSERT INTO core.usuario_sucursal (usuario_id, sucursal_id)
           VALUES ($1, $2)
           ON CONFLICT (usuario_id, sucursal_id) DO UPDATE
              SET activo = true, effective_until = NULL`,
          [usuarioId, sid],
        );
      }
      await c.query(
        `UPDATE core.usuario_sucursal
            SET activo = false, effective_until = now()
          WHERE usuario_id = $1 AND activo
            AND ($2::uuid[] = '{}' OR sucursal_id <> ALL($2::uuid[]))`,
        [usuarioId, objetivo],
      );
    }

    // 4 · Identidad del nodo: en local, esta PC "es" una sucursal concreta.
    if (target === 'local') {
      const nodoSucursal = sucursalId.get(nodoCodigo);
      if (!nodoSucursal) {
        throw new Error(`--sucursal ${nodoCodigo} no existe en el escenario (usa 1, 2 o 3)`);
      }
      await c.query(
        `UPDATE sync.nodo SET sucursal_id = $1, es_nube = false WHERE singleton`,
        [nodoSucursal],
      );
    }

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => { /* ya revertida */ });
    throw err;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = targetFromArgs(args, 'local');
  const sucIdx = args.indexOf('--sucursal');
  const nodoCodigo = (sucIdx >= 0 ? args[sucIdx + 1] : '1')?.toUpperCase() ?? '1';

  const conn = resolveConnection(target);
  console.log(`Sembrando escenario de QA en ${target} (${conn.describe})`);
  const c = new Client(conn.config);
  await c.connect();
  try {
    await sembrar(c, target, nodoCodigo);
    const { rows: nodo } = await c.query<{ codigo: string | null }>(
      `SELECT s.codigo FROM sync.nodo n LEFT JOIN core.sucursal s ON s.id = n.sucursal_id WHERE n.singleton`,
    );
    console.log(`  nodo.sucursal: ${nodo[0]?.codigo ?? '(sin fijar — nube)'}`);
  } finally {
    await c.end();
  }

  console.log('\nListo. Contraseña de todos: ' + (process.env['QA_PASSWORD'] ? '(QA_PASSWORD)' : `"${PASSWORD}"`));
  console.log(`
  Escenarios de login (con "npm run api" + la SPA):
    admin@donaji.local         -> 3 sucursales: aparece el selector
    gerente@donaji.local       -> 1 sucursal (Oaxaca): sesión directa
    vendedor.oax@donaji.local  -> 1 sucursal (Oaxaca): sesión directa
    vendedor.tux@donaji.local  -> 1 sucursal (Tuxtepec)
    multi@donaji.local         -> 2 sucursales (Oaxaca, Puebla): selector, sin ser admin
    sin.sucursal@donaji.local  -> login rechazado: "sin_sucursal_activa"

  RBAC: administrador ve el Tablero; gerente/vendedor no. Un vendedor no ve
  "asiento.override" ni "movimiento.anular".`);
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
