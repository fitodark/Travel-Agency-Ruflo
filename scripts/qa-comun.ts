/**
 * Piezas compartidas entre `sembrar-qa.ts` y `limpiar-qa.ts`.
 *
 * El barrido del dominio operativo y la lista de tablas viven aquí para que las
 * dos herramientas no se desincronicen: si una nueva tabla de operación entra al
 * esquema, se agrega en un solo lugar.
 */

import type { Client } from 'pg';

/** Códigos de las 4 sucursales reales del cliente (`knowledge/sucursales.md`). */
export const CODIGOS_REALES = ['1', '2', '3', '4'] as const;

/**
 * Tablas del dominio operativo + catálogo de operación que se BORRAN por completo
 * (dejar "primera carga limpia"). NO incluye `core.sucursal`, `core.usuario`,
 * `core.usuario_sucursal`, `core.agencia`, `core.tipo_unidad`, `core.parametro`,
 * `core.rol_permiso` ni `auth_local.credencial`: eso se conserva o lo reescribe
 * el seed. Orden: hijos antes que padres (las FK son DEFERRABLE y la tx difiere,
 * pero se lee mejor así).
 */
export const TABLAS_A_BARRER: readonly string[] = [
  'core.print_job',
  'core.movimiento_caja',
  'core.pago',
  'core.boleto',
  'core.venta',
  'core.corte_caja',
  'core.evento_abordaje',
  'core.evento_salida',
  'core.cambio_conductor',
  'core.asiento_lease',
  'core.asiento_ocupacion',
  'core.cupo_offline',
  'core.salida_parada',
  'core.salida',
  'core.nota_auditoria',
  'core.horario_parada',
  'core.horario',
  'core.tarifa',
  'core.ruta_parada',
  'core.ruta',
  'core.unidad',
  'core.conductor',
  'core.cliente',
];

/**
 * Tablas cuyo `sync.cambio_log` hay que limpiar tras el barrido: NO hay triggers
 * en DELETE, así que borrar la fila de `core.*` no publica nada, pero su
 * historial de INSERT/UPDATE sigue en el log y un bootstrap/pull futuro la
 * reviviría. (Las que no aparezcan en el log no borran nada.)
 */
export const TABLAS_LOG_A_LIMPIAR: readonly string[] = [
  'core.ruta',
  'core.ruta_parada',
  'core.horario',
  'core.horario_parada',
  'core.tarifa',
  'core.unidad',
  'core.conductor',
  'core.salida',
  'core.salida_parada',
  'core.cupo_offline',
];

export interface BarridoOpts {
  /** Limpiar también `sync.cambio_log` (solo tiene sentido en la nube). */
  limpiarLog: boolean;
  /**
   * Qué hacer con las sucursales que no son las 4 reales:
   *  - 'eliminar': borrarlas de raíz (con su `usuario_sucursal`, `folio_secuencia`
   *     y semilla HOTP). Solo es seguro tras el barrido del dominio, que ya
   *     dejó las tablas de operación vacías.
   *  - 'desactivar': `activo = false` (la app las oculta igual)
   *  - 'conservar' (default): no tocarlas
   */
  sucursalesExtra?: 'eliminar' | 'desactivar' | 'conservar';
}

/**
 * Borra el dominio operativo y de catálogo. Corre en su propia transacción con
 * las FK diferidas, así el orden de borrado no importa. Idempotente.
 */
export async function barrerDominio(c: Client, opts: BarridoOpts): Promise<void> {
  await c.query('BEGIN');
  try {
    await c.query('SET CONSTRAINTS ALL DEFERRED');

    for (const tabla of TABLAS_A_BARRER) {
      const r = await c.query(`DELETE FROM ${tabla}`);
      if (r.rowCount) console.log(`  ${tabla.padEnd(24)} -${r.rowCount}`);
    }

    const modoExtra = opts.sucursalesExtra ?? 'conservar';
    if (modoExtra !== 'conservar') {
      const filtro = modoExtra === 'eliminar' ? '' : ' AND activo';
      const { rows: otras } = await c.query<{ id: string; codigo: string }>(
        `SELECT id, codigo FROM core.sucursal WHERE codigo <> ALL($1)${filtro}`,
        [CODIGOS_REALES],
      );
      if (otras.length) {
        const ids = otras.map((r) => r.id);
        if (modoExtra === 'eliminar') {
          // Solo seguro tras el barrido: las tablas de operación ya están vacías,
          // así que lo único que aún cuelga de estas sucursales es su enlace a
          // usuarios, su secuencia de folios y su semilla HOTP.
          await c.query(`DELETE FROM core.usuario_sucursal WHERE sucursal_id = ANY($1::uuid[])`, [ids]);
          await c.query(`DELETE FROM core.folio_secuencia WHERE sucursal_id = ANY($1::uuid[])`, [ids]);
          await c.query(`DELETE FROM auth_local.revocacion_hotp WHERE sucursal_id = ANY($1::uuid[])`, [ids]);
          await c.query(`DELETE FROM core.sucursal WHERE id = ANY($1::uuid[])`, [ids]);
          console.log(`  sucursales eliminadas: ${otras.map((r) => r.codigo).join(', ')}`);
        } else {
          await c.query(`DELETE FROM core.folio_secuencia WHERE sucursal_id = ANY($1::uuid[])`, [ids]);
          await c.query(
            `UPDATE core.sucursal
                SET activo = false, effective_until = now(),
                    desactivado_en = now(), desactivado_motivo = 'carga inicial QA'
              WHERE id = ANY($1::uuid[])`,
            [ids],
          );
          await c.query(
            `UPDATE core.usuario_sucursal SET activo = false, effective_until = now()
              WHERE sucursal_id = ANY($1::uuid[]) AND activo`,
            [ids],
          );
          console.log(`  sucursales desactivadas: ${otras.map((r) => r.codigo).join(', ')}`);
        }

        if (opts.limpiarLog) {
          // `core.sucursal` y `auth_local.revocacion_hotp` comparten `id` (== sucursal_id),
          // así que un solo filtro por `fila_id` limpia el log de ambas.
          const rs = await c.query(
            `DELETE FROM sync.cambio_log WHERE fila_id = ANY($1::uuid[])`, [ids],
          );
          if (rs.rowCount) console.log(`  sync.cambio_log (sucursales) -${rs.rowCount}`);
        }
      }
    }

    if (opts.limpiarLog) {
      const rl = await c.query(
        `DELETE FROM sync.cambio_log WHERE tabla = ANY($1)`,
        [TABLAS_LOG_A_LIMPIAR],
      );
      if (rl.rowCount) console.log(`  sync.cambio_log          -${rl.rowCount}`);
    }

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => { /* ya revertida */ });
    throw err;
  }
}
