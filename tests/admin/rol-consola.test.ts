/**
 * El rol `donaji_consola` tiene exactamente los permisos que la consola necesita.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.4 (P6)
 *
 * Se ejecutan las operaciones de la consola con `SET LOCAL ROLE donaji_consola`:
 * si falta un GRANT, PostgreSQL lanza `permission denied` y la prueba falla. Y se
 * comprueba que ese rol NO puede tocar datos transaccionales.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../../src/db/connection.js';
import { escribirConfig } from '../../src/admin/escribir-config.js';
import { crearSucursal } from '../../src/admin/sucursales.js';
import { crearUsuario, darDeBajaUsuario, editarUsuario } from '../../src/admin/usuarios.js';
import { generarCodigoRevocacion } from '../../src/admin/revocacion.js';
import { configurarImpresora, configurarTicket } from '../../src/admin/impresion.js';
import { crearTarifa } from '../../src/admin/tarifas.js';
import { seedRuta } from '../fleet/fixture.js';

const local = process.env['LOCAL_DATABASE_URL'];
const run = local ? describe : describe.skip;
const ahora = (): Date => new Date('2026-09-10T16:00:00.000Z');

run('rol donaji_consola (PostgreSQL real)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client(resolveConnection('local').config);
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });

  it('puede hacer todo el CRUD de configuración de la consola', async () => {
    // Setup como dueño: una ruta y la marca de nube.
    const fx = await seedRuta(db, { paradas: 3 });
    await db.query("SET LOCAL donaji.forzar_nube = 'on'");

    await db.query(`SET LOCAL ROLE donaji_consola`);

    const suc = await crearSucursal(db, {
      agenciaId: fx.agenciaId, nombre: 'Rol Test', direccionCompleta: 'x',
      telefonoPrincipal: 'x', codigo: 'Z',
    }, { modo: 'inmediato', confirmarInmediato: true, ahora });

    const usr = await crearUsuario(db, {
      nombre: 'U', email: `rol-${Math.floor(Math.random() * 1e9)}@donaji.test`, rol: 'vendedor',
      sucursalIds: [suc.id],
    }, { modo: 'inmediato', confirmarInmediato: true, ahora });

    await editarUsuario(db, usr.id, { nombre: 'Editado' },
      { modo: 'inmediato', confirmarInmediato: true, ahora });
    await darDeBajaUsuario(db, usr.id, { ahora });

    await generarCodigoRevocacion(db, { sucursalId: suc.id, usuarioId: usr.id, ahora });

    await configurarImpresora(db, {
      sucursalId: suc.id, nombre: 'Enduro', transporte: 'tcp', ip: '10.0.0.1',
    }, { ahora });
    await configurarTicket(db, { agenciaId: fx.agenciaId, leyendaPie: 'X' },
      { modo: 'inmediato', confirmarInmediato: true, ahora });

    await crearTarifa(db, {
      rutaId: fx.rutaId, paradaOrigenOrden: 0, paradaDestinoOrden: 2, importe: 400,
    }, { ahora });

    await escribirConfig(db, {
      tabla: 'core.parametro',
      fila: { clave: `p_${Math.floor(Math.random() * 1e9)}`, valor: JSON.stringify(1) },
      modo: 'inmediato', confirmarInmediato: true, ahora,
    });
    await escribirConfig(db, {
      tabla: 'core.rol_permiso', fila: { rol: 'gerente', permiso: 'config.tarifas' },
      modo: 'inmediato', confirmarInmediato: true, ahora,
    });

    // Y publicó a las terminales.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sync.cambio_log WHERE tabla = 'core.sucursal' AND fila_id = $1`,
      [suc.id],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('NO puede escribir datos transaccionales, solo configuración', async () => {
    const { rows } = await db.query<Record<string, boolean>>(
      `SELECT
         has_table_privilege('donaji_consola', 'core.venta', 'INSERT')    AS venta_ins,
         has_table_privilege('donaji_consola', 'core.boleto', 'UPDATE')   AS boleto_upd,
         has_table_privilege('donaji_consola', 'core.pago', 'INSERT')     AS pago_ins,
         has_table_privilege('donaji_consola', 'core.corte_caja', 'UPDATE') AS corte_upd,
         has_table_privilege('donaji_consola', 'core.venta', 'SELECT')    AS venta_sel,
         has_table_privilege('donaji_consola', 'core.config_impresora', 'INSERT') AS impr_ins,
         has_table_privilege('donaji_consola', 'core.tarifa', 'UPDATE')   AS tarifa_upd,
         has_table_privilege('donaji_consola', 'auth_local.credencial', 'INSERT') AS cred_ins,
         has_table_privilege('donaji_consola', 'auth_local.sesion', 'INSERT') AS sesion_ins`,
    );
    expect(rows[0]).toEqual({
      venta_ins: false, boleto_upd: false, pago_ins: false, corte_upd: false,
      venta_sel: true, // lee todo core (lo que el admin ya ve)
      impr_ins: true, tarifa_upd: true, cred_ins: true,
      sesion_ins: false,
    });
  });
});
