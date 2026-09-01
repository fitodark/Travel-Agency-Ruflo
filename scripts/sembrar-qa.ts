/**
 * Carga inicial de QA: las sucursales REALES del cliente y los usuarios de prueba.
 *
 *   npm run seed:qa                       # contra la NUBE (Supabase) — por defecto
 *   npm run seed:qa -- --sucursal 2       # el nodo local representará a Acatlán
 *   npm run seed:qa -- --target local     # solo local (modo "desconectado", ver abajo)
 *
 * QUÉ HACE (contra la nube):
 *   1. BARRE todo el dominio operativo y de catálogo de prueba: rutas, horarios,
 *      tarifas, unidades, conductores, salidas, cupos, ventas, boletos, pagos,
 *      cortes de caja, clientes… TODO. Es una "primera carga limpia": no queda
 *      ni un dato de prueba de sesiones anteriores.
 *   2. Da de alta las 4 sucursales reales (códigos 1–4) — ver `knowledge/sucursales.md`.
 *   3. ELIMINA cualquier sucursal que no sea una de esas 4 (las `D/V/W/X/Y` de
 *      seeds y pruebas viejas): tras el barrido nada de operación las referencia.
 *   4. Siembra los 6 usuarios de prueba (un rol/asignación por escenario de login).
 *   NO siembra ningún viaje vendible: el catálogo de operación (rutas, horarios,
 *   tarifas, flota) se carga desde la sección Administración de la SPA, que es el
 *   flujo real.
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
 * pasar por la consola, para que QA tenga el entorno en un comando.
 *
 * OJO — modo nube (por defecto): tras sembrar la nube, este script VACÍA por
 * completo la base LOCAL (`core.*` y `auth_local.*`) y la reconstruye con un
 * bootstrap desde la nube, igual que una terminal al reinstalarse. Es un entorno
 * de PRUEBA: las ventas / cortes locales previos se pierden. Así el nodo queda
 * como copia exacta de la nube y no arrastra ids divergentes de seeds anteriores.
 *
 * Limpieza: `npm run limpiar:qa` borra este escenario de la nube Y de local.
 *
 * ESCENARIO
 *   Sucursales (reales, `knowledge/sucursales.md`):
 *     1  Huajuapan de León   2  Acatlán de Osorio   3  Acatitla   4  CDMX
 *   Usuarios (contraseña = QA_PASSWORD o 'donaji-qa'):
 *     admin@donaji.local        administrador   1,2,3,4  -> picker con 4 opciones
 *     gerente@donaji.local      gerente         1        -> sesión directa, sin picker
 *     vendedor.oax@donaji.local vendedor        1        -> sesión directa
 *     vendedor.tux@donaji.local vendedor        2        -> sesión directa
 *     multi@donaji.local        vendedor        1,3      -> picker con 2 opciones (no admin)
 *     sin.sucursal@donaji.local vendedor        (ninguna)-> login rechazado: sin_sucursal_activa
 *   (Los emails `.oax` / `.tux` son identificadores heredados: se conservan tal
 *    cual para no romper credenciales/pruebas ya existentes.)
 */

import 'dotenv/config';
import { Client } from 'pg';
import { hashPassword } from '../src/auth/passwords.js';
import { resolveConnection, targetFromArgs } from '../src/db/connection.js';
import { bootstrap } from '../src/sync/bootstrap.js';
import { barrerDominio } from './qa-comun.js';

const PASSWORD = process.env['QA_PASSWORD'] ?? 'donaji-qa';

interface DefSucursal {
  codigo: string;
  nombre: string;
  direccion: string;
  telefono: string;
  /** Segundo teléfono (celular). `null` si la sucursal no dio uno. */
  celular: string | null;
}

interface DefUsuario {
  email: string;
  nombre: string;
  rol: 'administrador' | 'gerente' | 'vendedor';
  /** Códigos de sucursal a los que se asigna. Vacío = sin sucursal activa. */
  sucursales: string[];
}

/**
 * Sucursales reales del cliente (`knowledge/sucursales.md`). `telefono` es el
 * fijo; `celular` el segundo número (o `null` si no dio). La columna
 * `core.sucursal.celular` la agrega la migración 0044.
 */
const SUCURSALES: DefSucursal[] = [
  {
    codigo: '1',
    nombre: 'Huajuapan de León',
    direccion: 'Carretera 2 de Abril #5, Col Centro, Huajuapan de León, Oaxaca.',
    telefono: '953 690 2956',
    celular: '953 157 9395',
  },
  {
    codigo: '2',
    nombre: 'Acatlán de Osorio',
    direccion: 'Calle Benito Juárez #2, Col Centro, Acatlán de Osorio, Puebla.',
    telefono: '953 209 5748',
    celular: null,
  },
  {
    codigo: '3',
    nombre: 'Acatitla',
    direccion: 'Cayetano Andrade 47, Santa Martha Acatitla, Deleg. Iztapalapa, Ciudad de México.',
    telefono: '559 219 6809',
    celular: '556 198 6891',
  },
  {
    codigo: '4',
    nombre: 'CDMX',
    direccion:
      'Calle Carlos Santa Ana #28, Esq con José Rivera, Col Moctezuma, 1ra Sección, Deleg. Venustiano Carranza.',
    telefono: '558 657 6645',
    celular: '554 562 5879',
  },
];

const USUARIOS: DefUsuario[] = [
  { email: 'admin@donaji.local', nombre: 'Administrador QA', rol: 'administrador', sucursales: ['1', '2', '3', '4'] },
  { email: 'gerente@donaji.local', nombre: 'Gerente Huajuapan', rol: 'gerente', sucursales: ['1'] },
  { email: 'vendedor.oax@donaji.local', nombre: 'Vendedor Huajuapan', rol: 'vendedor', sucursales: ['1'] },
  { email: 'vendedor.tux@donaji.local', nombre: 'Vendedor Acatlán', rol: 'vendedor', sucursales: ['2'] },
  { email: 'multi@donaji.local', nombre: 'Vendedor Multisucursal', rol: 'vendedor', sucursales: ['1', '3'] },
  { email: 'sin.sucursal@donaji.local', nombre: 'Vendedor Sin Sucursal', rol: 'vendedor', sucursales: [] },
];

/** Siembra el escenario en una base. Devuelve el id de la sucursal por código. */
async function sembrar(c: Client): Promise<Map<string, string>> {
  const sucursalId = new Map<string, string>();
  await c.query('BEGIN');
  try {
    // 1 · Agencia: reutiliza la activa más antigua (o crea una) y la deja como
    // "Agencia Donaji" (nombre real del cliente; ver también migración 0044).
    let { rows: ag } = await c.query<{ id: string }>(
      `SELECT id FROM core.agencia WHERE activo ORDER BY creado_en LIMIT 1`,
    );
    if (!ag[0]) {
      ag = (await c.query(`INSERT INTO core.agencia (nombre) VALUES ('Agencia Donaji') RETURNING id`)).rows;
    }
    const agenciaId = ag[0]!.id;
    await c.query(
      `UPDATE core.agencia SET nombre = 'Agencia Donaji' WHERE id = $1 AND nombre <> 'Agencia Donaji'`,
      [agenciaId],
    );

    // 2 · Sucursales.
    for (const s of SUCURSALES) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO core.sucursal (agencia_id, nombre, direccion_completa, telefono_principal, celular, codigo)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (codigo) DO UPDATE
            SET nombre = EXCLUDED.nombre, direccion_completa = EXCLUDED.direccion_completa,
                telefono_principal = EXCLUDED.telefono_principal, celular = EXCLUDED.celular,
                agencia_id = EXCLUDED.agencia_id, activo = true,
                effective_until = NULL, desactivado_en = NULL, desactivado_motivo = NULL
         RETURNING id`,
        [agenciaId, s.nombre, s.direccion, s.telefono, s.celular, s.codigo],
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
      // Desactiva las asignaciones a sucursales que este usuario ya no debe
      // tener. NO toca `admin@donaji.local` (lo comparte `sembrar-admin`): a él
      // solo se le SUMAN las 4 sucursales reales.
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
 * Vacía TODO `core.*` y `auth_local.*` del nodo local antes del bootstrap.
 *
 * POR QUÉ TAN AGRESIVO: el `bootstrap` copia la clase A de la nube fila por fila
 * por `id`. Si el nodo ya tiene esas filas con OTRO id —un `seed:qa --target
 * local` previo, restos de la PoC, un seed de otra máquina— choca contra las
 * constraints de clave natural (`usuario_email_key`, `usuario_sucursal_..._key`,
 * `credencial` por `usuario_id`, …) y el bootstrap revienta. Realinear caso por
 * caso es un pozo sin fondo: hay una constraint natural en casi cada tabla.
 *
 * La clase A del nodo es, por diseño, una COPIA de la nube (el nodo nunca la
 * escribe). Y `seed:qa` prepara un entorno de PRUEBA: las ventas / cortes locales
 * son desechables. Así que se vacía todo y el bootstrap lo reconstruye desde la
 * nube — que es exactamente lo que hace una terminal al reinstalarse. `sync.*`
 * (nodo, cursor, hlc) no se toca.
 */
async function resetNodoLocal(local: Client): Promise<void> {
  await local.query(`
    DO $$
    DECLARE t text;
    BEGIN
      FOR t IN
        SELECT format('%I.%I', schemaname, tablename)
          FROM pg_tables WHERE schemaname IN ('core', 'auth_local')
      LOOP
        EXECUTE 'TRUNCATE ' || t || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

/**
 * Deja el nodo local listo: fija su sucursal, lo vacía y hace un bootstrap desde
 * la nube.
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
    await resetNodoLocal(local);
    await local.query(
      `UPDATE sync.nodo SET sucursal_id = $1, es_nube = false WHERE singleton`,
      [sucursalId],
    );
    const r = await bootstrap(local, nube);
    console.log(`  nodo local vaciado + bootstrap: ${r.total} filas copiadas, cursor en ${r.cursorInicial}`);
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
  console.log(`Sembrando carga inicial de QA en ${target} (${conn.describe})`);
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
    console.log('\nBarriendo dominio operativo y de catálogo de prueba…');
    await barrerDominio(c, { limpiarLog: target === 'nube', sucursalesExtra: 'eliminar' });
    console.log('\nSembrando sucursales y usuarios…');
    sucursales = await sembrar(c);
  } finally {
    await c.end();
  }

  const nodoSucursal = sucursales.get(nodoCodigo);
  if (!nodoSucursal) {
    throw new Error(`--sucursal ${nodoCodigo} no existe en el escenario (usa 1, 2, 3 o 4)`);
  }
  if (target === 'nube') await prepararNodoLocal(nodoSucursal);

  console.log('\nListo. Contraseña de todos: ' + (process.env['QA_PASSWORD'] ? '(QA_PASSWORD)' : `"${PASSWORD}"`));
  if (target === 'nube') {
    console.log(
      `\n  El nodo local ya representa a la sucursal ${nodoCodigo} y tiene el catálogo\n` +
      `  de la nube (bootstrap). Corré  npm run api  para mantenerlo sincronizado.\n`,
    );
  }
  console.log(`  Sucursales reales: 1 Huajuapan de León · 2 Acatlán de Osorio · 3 Acatitla · 4 CDMX

  Escenarios de login (con "npm run api" + la SPA):
    admin@donaji.local         -> 4 sucursales: aparece el selector
    gerente@donaji.local       -> 1 sucursal (Huajuapan): sesión directa
    vendedor.oax@donaji.local  -> 1 sucursal (Huajuapan): sesión directa
    vendedor.tux@donaji.local  -> 1 sucursal (Acatlán): sesión directa
    multi@donaji.local         -> 2 sucursales (Huajuapan, Acatitla): selector, sin ser admin
    sin.sucursal@donaji.local  -> login rechazado: "sin_sucursal_activa"

  RBAC: administrador ve Administración y el Tablero; gerente/vendedor no.

  No hay rutas / horarios / tarifas / flota sembrados: cárgalos desde la sección
  Administración de la SPA (flujo real). Sin eso, "Vender" no encuentra salidas.

  Limpieza: npm run limpiar:qa (borra el escenario de nube y de local).`);
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
