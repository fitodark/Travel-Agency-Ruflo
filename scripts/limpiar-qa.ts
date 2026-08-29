/**
 * Borra el escenario de QA que siembra `sembrar-qa.ts` — de la NUBE y de LOCAL.
 *
 *   npm run limpiar:qa                 # nube + local (lo que esté configurado)
 *   npm run limpiar:qa -- --target nube
 *
 * Qué borra:
 *  - Los 5 usuarios de prueba (gerente@, vendedor.oax@, vendedor.tux@, multi@,
 *    sin.sucursal@donaji.local) con sus credenciales, sesiones y asignaciones.
 *  - El viaje vendible de QA de ids fijos (ruta "QA Oaxaca-Puebla", su horario,
 *    tarifa, unidad QA-01, "Conductor QA") con sus salidas materializadas y
 *    CUALQUIER venta/boleto/lease encima (datos de prueba, desechables).
 *  - Las 3 sucursales de prueba (códigos 1, 2, 3): se DESACTIVAN (`activo=false`),
 *    no se borran. Hard-borrarlas rompería contra cualquier corte de caja, venta
 *    o ruta que QA haya creado a mano sobre ellas; desactivarlas es lo que hace
 *    la propia app y re-`seed:qa` las reactiva. Su `folio_secuencia` y
 *    `revocacion_hotp` sí se borran.
 *  - En la NUBE: además las filas de `sync.cambio_log` de esas entidades, para que
 *    un pull no las vuelva a bajar.
 *
 * Qué NO toca: `admin@donaji.local` (lo comparte `sembrar-admin.ts`); solo se
 * quitan sus asignaciones a las sucursales de prueba.
 *
 * Un nodo que ya había bajado los datos y no corre este limpiado contra su base
 * local se queda con residuo: córrelo también ahí (es el comportamiento por
 * defecto) o vuelve a hacer bootstrap.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection } from '../src/db/connection.js';

const CODIGOS = ['1', '2', '3'];

/** Ids fijos del viaje vendible — deben coincidir con `VIAJE` de `sembrar-qa.ts`. */
const VIAJE = {
  ruta:      'd0d0da01-0000-7000-8000-000000000001',
  paradaOax: 'd0d0da01-0000-7000-8000-0000000000a0',
  paradaPue: 'd0d0da01-0000-7000-8000-0000000000b0',
  unidad:    'd0d0da01-0000-7000-8000-000000000010',
  conductor: 'd0d0da01-0000-7000-8000-000000000020',
  horario:   'd0d0da01-0000-7000-8000-000000000030',
  hpOax:     'd0d0da01-0000-7000-8000-0000000000a1',
  hpPue:     'd0d0da01-0000-7000-8000-0000000000b1',
  tarifa:    'd0d0da01-0000-7000-8000-000000000040',
} as const;
const EMAILS = [
  'gerente@donaji.local',
  'vendedor.oax@donaji.local',
  'vendedor.tux@donaji.local',
  'multi@donaji.local',
  'sin.sucursal@donaji.local',
];

async function limpiar(c: Client, esNube: boolean): Promise<void> {
  await c.query('BEGIN');
  try {
    const { rows: sucs } = await c.query<{ id: string }>(
      `SELECT id FROM core.sucursal WHERE codigo = ANY($1)`, [CODIGOS],
    );
    const { rows: usrs } = await c.query<{ id: string }>(
      `SELECT id FROM core.usuario WHERE email = ANY($1::citext[])`, [EMAILS],
    );
    const sucIds = sucs.map((r) => r.id);
    const usrIds = usrs.map((r) => r.id);

    // Primero el viaje: sus salidas y andamiaje cuelgan de las sucursales de QA
    // (`unidad.sucursal_base_id`, `salida_parada.sucursal_id`), así que hay que
    // borrarlo antes que ellas.
    const viajeIds = await limpiarViajeVendible(c);
    const todos = [...sucIds, ...usrIds, ...viajeIds];

    const pasos: Array<[string, string, unknown[]]> = [
      ['auth_local.sesion',              `DELETE FROM auth_local.sesion WHERE usuario_id = ANY($1::uuid[])`, [usrIds]],
      ['auth_local.revocacion_aplicada', `DELETE FROM auth_local.revocacion_aplicada WHERE usuario_id = ANY($1::uuid[])`, [usrIds]],
      ['auth_local.credencial',          `DELETE FROM auth_local.credencial WHERE usuario_id = ANY($1::uuid[])`, [usrIds]],
      ['auth_local.intento',             `DELETE FROM auth_local.intento WHERE email = ANY($1::citext[])`, [EMAILS]],
      ['core.usuario_sucursal',          `DELETE FROM core.usuario_sucursal WHERE usuario_id = ANY($1::uuid[]) OR sucursal_id = ANY($2::uuid[])`, [usrIds, sucIds]],
      ['auth_local.revocacion_hotp',     `DELETE FROM auth_local.revocacion_hotp WHERE sucursal_id = ANY($1::uuid[])`, [sucIds]],
      ['core.folio_secuencia',           `DELETE FROM core.folio_secuencia WHERE sucursal_id = ANY($1::uuid[])`, [sucIds]],
      ['core.usuario',                   `DELETE FROM core.usuario WHERE id = ANY($1::uuid[])`, [usrIds]],
      // Las sucursales se DESACTIVAN (no se borran): un corte de caja / venta /
      // ruta que QA armó a mano las referencia por FK. La propia app las quita
      // así, y re-`seed:qa` las reactiva por `ON CONFLICT (codigo)`.
      ['core.sucursal (desactivar)',     `UPDATE core.sucursal SET activo = false, effective_until = now() WHERE id = ANY($1::uuid[]) AND activo`, [sucIds]],
    ];
    for (const [nombre, sql, params] of pasos) {
      const r = await c.query(sql, params);
      if (r.rowCount) console.log(`  ${nombre.padEnd(30)} -${r.rowCount}`);
    }

    if (esNube && todos.length > 0) {
      const r = await c.query(
        `DELETE FROM sync.cambio_log WHERE fila_id = ANY($1::uuid[])`, [todos],
      );
      if (r.rowCount) console.log(`  sync.cambio_log                 -${r.rowCount}`);
    }

    // El nodo local deja de "ser" una de las sucursales borradas.
    await c.query(
      `UPDATE sync.nodo SET sucursal_id = NULL
        WHERE singleton AND sucursal_id = ANY($1::uuid[])`, [sucIds],
    );

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => { /* ya revertida */ });
    throw err;
  }
}

/**
 * Borra el viaje vendible de QA (ids fijos de `VIAJE`): sus salidas materializadas
 * y todo lo que cuelga de ellas (ventas, boletos, pagos, leases, ocupaciones,
 * eventos, cupos), luego el andamiaje (horario, tarifa, ruta, conductor, unidad).
 * NO toca rutas/horarios que QA haya armado a mano — esos referencian sucursales
 * que solo se desactivan, así que no bloquean nada. Devuelve los `fila_id`
 * borrados para limpiar su `sync.cambio_log` en la nube.
 */
async function limpiarViajeVendible(c: Client): Promise<string[]> {
  const col = async (sql: string, params: unknown[]): Promise<string[]> =>
    (await c.query<{ id: string }>(sql, params)).rows.map((r) => r.id);

  const salIds = await col(`SELECT id FROM core.salida WHERE horario_id = $1::uuid`, [VIAJE.horario]);
  const bolIds = salIds.length
    ? await col(`SELECT id FROM core.boleto WHERE salida_id = ANY($1::uuid[])`, [salIds]) : [];
  const ventaIds = salIds.length
    ? await col(`SELECT id FROM core.venta WHERE salida_id = ANY($1::uuid[])`, [salIds]) : [];

  const pasos: Array<[string, string, unknown[]]> = [
    ['core.pago',              `DELETE FROM core.pago WHERE venta_id = ANY($1::uuid[])`, [ventaIds]],
    ['core.print_job',         `DELETE FROM core.print_job WHERE boleto_id = ANY($1::uuid[])`, [bolIds]],
    ['core.nota_auditoria',    `DELETE FROM core.nota_auditoria WHERE entidad = 'core.boleto' AND entidad_id = ANY($1::uuid[])`, [bolIds]],
    ['core.cambio_conductor',  `DELETE FROM core.cambio_conductor WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.evento_abordaje',   `DELETE FROM core.evento_abordaje WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.evento_salida',     `DELETE FROM core.evento_salida WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.asiento_lease',     `DELETE FROM core.asiento_lease WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.asiento_ocupacion', `DELETE FROM core.asiento_ocupacion WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.boleto',            `DELETE FROM core.boleto WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.venta',             `DELETE FROM core.venta WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.cupo_offline',      `DELETE FROM core.cupo_offline WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.salida_parada',     `DELETE FROM core.salida_parada WHERE salida_id = ANY($1::uuid[])`, [salIds]],
    ['core.salida',            `DELETE FROM core.salida WHERE id = ANY($1::uuid[])`, [salIds]],
    ['core.horario_parada',    `DELETE FROM core.horario_parada WHERE horario_id = $1::uuid`, [VIAJE.horario]],
    ['core.horario',           `DELETE FROM core.horario WHERE id = $1::uuid`, [VIAJE.horario]],
    ['core.tarifa',            `DELETE FROM core.tarifa WHERE id = $1::uuid`, [VIAJE.tarifa]],
    ['core.ruta_parada',       `DELETE FROM core.ruta_parada WHERE ruta_id = $1::uuid`, [VIAJE.ruta]],
    ['core.ruta',              `DELETE FROM core.ruta WHERE id = $1::uuid`, [VIAJE.ruta]],
    ['core.conductor',         `DELETE FROM core.conductor WHERE id = $1::uuid`, [VIAJE.conductor]],
    ['core.unidad',            `DELETE FROM core.unidad WHERE id = $1::uuid`, [VIAJE.unidad]],
  ];
  for (const [nombre, sql, params] of pasos) {
    const r = await c.query(sql, params);
    if (r.rowCount) console.log(`  ${nombre.padEnd(30)} -${r.rowCount}`);
  }

  return [...Object.values(VIAJE), ...salIds, ...bolIds, ...ventaIds];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--target');
  const explicit = i >= 0 ? args[i + 1] : undefined;
  const targets: ('local' | 'nube')[] = explicit === 'local' ? ['local']
    : explicit === 'nube' ? ['nube']
    : ['nube', 'local'];

  for (const t of targets) {
    const env = t === 'local' ? 'LOCAL_DATABASE_URL' : 'DATABASE_URL';
    if (!process.env[env]) {
      console.log(`Sin ${env}: se omite "${t}".`);
      continue;
    }
    const conn = resolveConnection(t);
    console.log(`Limpiando QA en ${t} (${conn.describe})`);
    const c = new Client(conn.config);
    await c.connect();
    try {
      await limpiar(c, t === 'nube');
    } finally {
      await c.end();
    }
  }
  console.log('\nListo.');
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
