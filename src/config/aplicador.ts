/**
 * Aplicador de configuración.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §3
 *
 * PRINCIPIO (§3.1): **la configuración no se propaga como un comando remoto; se
 * propaga como un dato con fecha de vigencia.** Un "aplícate este cambio a las
 * 3 a.m." exige estar conectado a las 3 a.m. y falla en silencio si no. Un cambio
 * con `effective_from` viaja como cualquier fila, se guarda aunque falten días
 * para su vigencia, y el nodo lo aplica solo con su propio reloj.
 *
 * Este job corre en el nodo cada 5 minutos y con una pasada dedicada en la
 * ventana nocturna. Lo que hace HOY (F2):
 *
 *   1. Cierra las sesiones de usuarios cuya vigencia terminó — sea una baja
 *      diferida que venció, o una baja recibida tarde (`effective_until` ya en el
 *      pasado) que surte efecto al recibirla.
 *   2. Cierra las sesiones cuya sucursal elegida dejó de estar asignada o
 *      vigente para ese usuario.
 *   3. Publica la época de configuración para que cualquier caché en memoria
 *      sepa si tiene que recargar.
 *
 * Lo que NO hace: tocar datos transaccionales ni interrumpir una venta en curso
 * (§3.3 punto 4). Aplicar salidas materializadas (horizonte 90 días) y el nuevo
 * reparto de `cupo_offline` son puntos 2 y 3 del §3.3 y aterrizan en F3, cuando
 * existan esos jobs.
 */

import type { Client } from 'pg';
import { epocaConfig } from './epoca.js';

export interface ResultadoAplicacion {
  ejecutadoEn: Date;
  /** Sesiones cerradas porque su usuario dejó de estar vigente. */
  sesionesCerradasPorUsuario: number;
  /** Sesiones cerradas porque su sucursal dejó de estar asignada o vigente. */
  sesionesCerradasPorSucursal: number;
  /** IDs de usuarios cuya sesión se cerró (sin repetir). Para logs y auditoría. */
  usuariosAfectados: string[];
  /** Época de configuración tras la pasada. */
  epoca: string;
  /** `true` si la época cambió desde la pasada anterior: hay caché que invalidar. */
  epocaCambio: boolean;
}

/**
 * Ejecuta una pasada del aplicador. Idempotente: correrlo dos veces seguidas no
 * cambia nada la segunda vez.
 *
 * NO abre transacción propia: cada `UPDATE` es atómico y la operación es
 * idempotente, así que un fallo a media pasada se corrige en la siguiente. El
 * llamador decide si quiere envolverlo (las pruebas lo hacen para revertir).
 */
export async function aplicarConfiguracion(
  node: Client,
  opts: { ahora?: () => Date } = {},
): Promise<ResultadoAplicacion> {
  const ahora = opts.ahora?.() ?? new Date();

  const { rows: prev } = await node.query<{ ultima_epoca: string | null }>(
    `SELECT ultima_epoca FROM sync.config_aplicado WHERE singleton`,
  );
  const epocaPrevia = prev[0]?.ultima_epoca ?? null;

  // 1 · Sesiones de usuarios que ya no están vigentes.
  const { rows: porUsuario } = await node.query<{ usuario_id: string }>(
    `UPDATE auth_local.sesion s
        SET cerrada_en = $1::timestamptz, cerrada_motivo = 'vigencia_usuario'
      WHERE s.cerrada_en IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM core.usuario u
           WHERE u.id = s.usuario_id AND u.activo
             AND u.effective_from <= $1::timestamptz
             AND (u.effective_until IS NULL OR u.effective_until > $1::timestamptz))
      RETURNING s.usuario_id`,
    [ahora],
  );

  // 2 · Sesiones cuya sucursal elegida dejó de valer para ese usuario.
  const { rows: porSucursal } = await node.query<{ usuario_id: string }>(
    `UPDATE auth_local.sesion s
        SET cerrada_en = $1::timestamptz, cerrada_motivo = 'vigencia_sucursal'
      WHERE s.cerrada_en IS NULL AND s.sucursal_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM core.usuario_sucursal us
            JOIN core.sucursal suc ON suc.id = us.sucursal_id
           WHERE us.usuario_id = s.usuario_id AND us.sucursal_id = s.sucursal_id
             AND us.activo AND us.effective_from <= $1::timestamptz
             AND (us.effective_until IS NULL OR us.effective_until > $1::timestamptz)
             AND suc.activo AND suc.effective_from <= $1::timestamptz
             AND (suc.effective_until IS NULL OR suc.effective_until > $1::timestamptz))
      RETURNING s.usuario_id`,
    [ahora],
  );

  const usuariosAfectados = [
    ...new Set([...porUsuario, ...porSucursal].map((r) => r.usuario_id)),
  ];
  const cerradas = porUsuario.length + porSucursal.length;

  // 3 · Época y marca de la pasada.
  const epoca = await epocaConfig(node);
  await node.query(
    `UPDATE sync.config_aplicado
        SET ultima_pasada = $1::timestamptz,
            ultima_epoca = $2,
            sesiones_cerradas_total = sesiones_cerradas_total + $3
      WHERE singleton`,
    [ahora, epoca, cerradas],
  );

  return {
    ejecutadoEn: ahora,
    sesionesCerradasPorUsuario: porUsuario.length,
    sesionesCerradasPorSucursal: porSucursal.length,
    usuariosAfectados,
    epoca,
    epocaCambio: epoca !== epocaPrevia,
  };
}

/** Cuándo corrió el aplicador por última vez. `null` si nunca. Para `salud.ts`. */
export async function ultimaPasadaAplicador(node: Client): Promise<Date | null> {
  const { rows } = await node.query<{ ultima_pasada: Date | null }>(
    `SELECT ultima_pasada FROM sync.config_aplicado WHERE singleton`,
  );
  return rows[0]?.ultima_pasada ?? null;
}
