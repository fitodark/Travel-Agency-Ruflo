/**
 * Siembra un escenario de QA para probar el inicio de sesión y la administración:
 * varias sucursales, usuarios de cada rol y asignaciones cruzadas.
 *
 *   npm run seed:qa                       # contra la NUBE (Supabase) — por defecto
 *   npm run seed:qa -- --sucursal 2       # el nodo local representará a Tuxtepec
 *   npm run seed:qa -- --target local     # solo local (modo "desconectado", ver abajo)
 *
 * POR QUÉ CONTRA LA NUBE:
 * La configuración clase A (sucursales, usuarios, credenciales, asignaciones)
 * VIVE en la nube y baja replicada a las terminales. La consola de administración
 * de la SPA la LEE de la nube. Un seed solo-local queda "desconectado": no se ve
 * en Administración y `reconcile` marca `divergencia_checksum`. Por eso el destino
 * por defecto es la nube: ahí los triggers `trg_cambio_log` publican los cambios,
 * y el nodo local los recibe con `npm run api` corriendo (pull cada ~30 s) o con
 * un bootstrap.
 *
 * Este script escribe DIRECTO en la base —igual que `sembrar-admin.ts`— en vez de
 * pasar por la consola, para que QA tenga el escenario en un comando.
 *
 * Limpieza: `npm run limpiar:qa` borra este escenario de la nube Y de local.
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
import { bootstrap } from '../src/sync/bootstrap.js';

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

/** Siembra el escenario en una base. Devuelve el id de la sucursal por código. */
async function sembrar(c: Client): Promise<Map<string, string>> {
  const sucursalId = new Map<string, string>();
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

    // 2 · Sucursales.
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
      // Desactiva SOLO las asignaciones a las sucursales del escenario que este
      // usuario ya no debe tener. NO toca `admin@donaji.local` (lo comparte
      // `sembrar-admin`): a él solo se le SUMAN las 3 sucursales de prueba.
      if (u.email !== 'admin@donaji.local') {
        await c.query(
          `UPDATE core.usuario_sucursal
              SET activo = false, effective_until = now()
            WHERE usuario_id = $1 AND activo
              AND ($2::uuid[] = '{}' OR sucursal_id <> ALL($2::uuid[]))`,
          [usuarioId, objetivo],
        );
      }
    }

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => { /* ya revertida */ });
    throw err;
  }
  return sucursalId;
}

/**
 * Deja el nodo local listo: fija su sucursal y hace un bootstrap desde la nube.
 *
 * El bootstrap copia el estado ACTUAL de la nube (identidades deterministas de
 * 0039) y pone el cursor de pull en el `max(seq)` de ese momento, así el nodo se
 * salta todo el `sync.cambio_log` histórico de la PoC/dev —lleno de entradas
 * obsoletas que referencian ids viejos y que nunca van a aplicar— y solo procesa
 * lo nuevo (el escenario de QA recién sembrado).
 */
async function prepararNodoLocal(sucursalId: string): Promise<void> {
  if (!process.env['LOCAL_DATABASE_URL'] || !process.env['DATABASE_URL']) return;
  const local = new Client(resolveConnection('local').config);
  const nube = new Client(resolveConnection('nube').config);
  await local.connect();
  await nube.connect();
  try {
    await local.query(
      `UPDATE sync.nodo SET sucursal_id = $1, es_nube = false WHERE singleton`,
      [sucursalId],
    );
    const r = await bootstrap(local, nube);
    console.log(`  bootstrap del nodo local: ${r.total} filas copiadas, cursor en ${r.cursorInicial}`);
  } finally {
    await local.end().catch(() => { /* nada */ });
    await nube.end().catch(() => { /* nada */ });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = targetFromArgs(args, 'nube');
  const sucIdx = args.indexOf('--sucursal');
  const nodoCodigo = (sucIdx >= 0 ? args[sucIdx + 1] : '1') ?? '1';

  const conn = resolveConnection(target);
  console.log(`Sembrando escenario de QA en ${target} (${conn.describe})`);
  if (target === 'local') {
    console.log(
      '  AVISO: modo local "desconectado". Estos datos NO están en la nube, así que\n' +
      '  no aparecerán en la sección Administración de la SPA y `reconcile` marcará\n' +
      '  divergencia. Para el flujo real usa el destino por defecto (nube).',
    );
  }

  const c = new Client(conn.config);
  await c.connect();
  let sucursales: Map<string, string>;
  try {
    sucursales = await sembrar(c);
  } finally {
    await c.end();
  }

  const nodoSucursal = sucursales.get(nodoCodigo);
  if (!nodoSucursal) {
    throw new Error(`--sucursal ${nodoCodigo} no existe en el escenario (usa 1, 2 o 3)`);
  }
  if (target === 'nube') await prepararNodoLocal(nodoSucursal);

  console.log('\nListo. Contraseña de todos: ' + (process.env['QA_PASSWORD'] ? '(QA_PASSWORD)' : `"${PASSWORD}"`));
  if (target === 'nube') {
    console.log(
      `\n  El nodo local ya representa a la sucursal ${nodoCodigo} y tiene el catálogo\n` +
      `  de la nube (bootstrap). Corré  npm run api  para mantenerlo sincronizado.\n`,
    );
  }
  console.log(`  Escenarios de login (con "npm run api" + la SPA):
    admin@donaji.local         -> 3 sucursales: aparece el selector
    gerente@donaji.local       -> 1 sucursal (Oaxaca): sesión directa
    vendedor.oax@donaji.local  -> 1 sucursal (Oaxaca): sesión directa
    vendedor.tux@donaji.local  -> 1 sucursal (Tuxtepec)
    multi@donaji.local         -> 2 sucursales (Oaxaca, Puebla): selector, sin ser admin
    sin.sucursal@donaji.local  -> login rechazado: "sin_sucursal_activa"

  RBAC: administrador ve Administración y el Tablero; gerente/vendedor no.
  Limpieza: npm run limpiar:qa (borra el escenario de nube y de local).`);
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
