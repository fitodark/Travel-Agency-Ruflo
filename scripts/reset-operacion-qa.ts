/**
 * Reset PARCIAL para QA: borra la operación y el catálogo de rutas/tarifas,
 * CONSERVANDO la flota (conductores, unidades), las paradas (`core.punto_ruta`),
 * las sucursales y los usuarios.
 *
 *   npx tsx scripts/reset-operacion-qa.ts                    # local (default)
 *   npx tsx scripts/reset-operacion-qa.ts --target nube
 *   npx tsx scripts/reset-operacion-qa.ts --target ambos
 *
 * POR QUÉ EXISTE: cuando QA está iterando la configuración de rutas/horarios/
 * tarifas "según la necesidad de la agencia" y quiere volver a foja cero SIN
 * perder la flota y el catálogo de paradas ya capturados. `limpiar:qa` es
 * demasiado: borra usuarios, desactiva sucursales y barre conductores/unidades.
 *
 * QUÉ BORRA (mismo alcance en local y nube):
 *  - Cortes de caja + sus movimientos y pagos.
 *  - Ventas, boletos, ocupaciones, leases, print jobs, eventos de abordaje.
 *  - Rutas + `ruta_parada`, tarifas, horarios + `horario_parada`.
 *  - Salidas materializadas + `salida_parada` + `cupo_offline` + `cambio_conductor`.
 *  - En la nube además: las filas de `sync.cambio_log` de esas tablas de catálogo,
 *    para que un pull/bootstrap posterior no las reviva. (Los DELETE no publican:
 *    `trg_cambio_log` es solo INSERT/UPDATE.)
 *
 * QUÉ NO TOCA: `core.conductor`, `core.unidad`, `core.punto_ruta`, `core.cliente`,
 * `core.sucursal`, `core.usuario*`, `auth_local.*`, `core.folio_secuencia`,
 * `core.nota_auditoria`, ni el estado de runtime de `sync.*`.
 *
 * OJO — los DELETE no se replican. Correlo en CADA base que deba quedar limpia
 * (la nube Y el nodo local; `--target ambos` hace las dos).
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection, type Target } from '../src/db/connection.js';

/** Orden hijos → padres. Las FK son DEFERRABLE y la tx las difiere; se lee mejor así. */
const PASOS: readonly string[] = [
  'DELETE FROM core.print_job',
  'DELETE FROM core.movimiento_caja',
  'DELETE FROM core.pago',
  'DELETE FROM core.evento_abordaje',
  'DELETE FROM core.evento_salida',
  'DELETE FROM core.asiento_lease',
  'DELETE FROM core.asiento_ocupacion',
  'DELETE FROM core.boleto',
  'DELETE FROM core.venta',
  'DELETE FROM core.corte_caja',
  'DELETE FROM core.cambio_conductor',
  'DELETE FROM core.cupo_offline',
  'DELETE FROM core.salida_parada',
  'DELETE FROM core.salida',
  'DELETE FROM core.horario_parada',
  'DELETE FROM core.horario',
  'DELETE FROM core.tarifa',
  'DELETE FROM core.ruta_parada',
  'DELETE FROM core.ruta',
];

/** Tablas de catálogo barridas cuyo `sync.cambio_log` hay que limpiar en la nube. */
const LOG_A_LIMPIAR: readonly string[] = [
  'core.ruta', 'core.ruta_parada', 'core.horario', 'core.horario_parada',
  'core.tarifa', 'core.salida', 'core.salida_parada', 'core.cupo_offline',
];

async function resetear(target: Target): Promise<void> {
  const conn = resolveConnection(target);
  const c = new Client(conn.config);
  await c.connect();
  console.log(`\nReset de operación en ${target} (${conn.describe})`);
  try {
    await c.query('BEGIN');
    await c.query('SET CONSTRAINTS ALL DEFERRED');

    for (const sql of PASOS) {
      const r = await c.query(sql);
      const tabla = sql.replace('DELETE FROM ', '');
      if (r.rowCount) console.log(`  ${tabla.padEnd(24)} -${r.rowCount}`);
    }

    if (target === 'nube') {
      const r = await c.query(
        'DELETE FROM sync.cambio_log WHERE tabla = ANY($1)', [LOG_A_LIMPIAR],
      );
      if (r.rowCount) console.log(`  sync.cambio_log          -${r.rowCount}`);
    }

    await c.query('COMMIT');
    console.log('  ok');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => { /* ya revertida */ });
    throw err;
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--target');
  const raw = i >= 0 ? args[i + 1] : 'local';
  const targets: Target[] =
    raw === 'ambos' ? ['nube', 'local'] :
    raw === 'nube' ? ['nube'] :
    raw === 'local' ? ['local'] :
    (() => { throw new Error(`Destino inválido: "${raw}". Usa local, nube o ambos.`); })();

  for (const t of targets) {
    const env = t === 'local' ? 'LOCAL_DATABASE_URL' : 'DATABASE_URL';
    if (!process.env[env]) {
      console.log(`Sin ${env}: se omite "${t}".`);
      continue;
    }
    await resetear(t);
  }
  console.log('\nListo. La flota, las paradas y las sucursales quedan cargadas.');
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
