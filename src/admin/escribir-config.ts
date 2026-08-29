/**
 * Escritura de configuración clase A desde la consola de administración (F2b).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §3.1–§3.2
 *                  docs/architecture/04-riesgos-roadmap.md §F2b (slice 1)
 *
 * PRINCIPIO (§3.1): la configuración no se propaga como un comando remoto, sino
 * como un dato con fecha de vigencia. `escribirConfig` fija esa fecha según el
 * modo que elige el administrador al guardar:
 *
 *   ventana     (default) → próxima 03:00 hora local. Altas de horario, bajas de
 *                           usuario programadas, cambios de tarifa.
 *   inmediato   (exige confirmación) → ahora. Emergencias: baja de un vendedor,
 *                           corregir la IP de una impresora.
 *   programado  → una fecha elegida. Tarifa de temporada, horario que arranca
 *                           el día 1.
 *
 * El helper NO conoce la semántica de cada tabla (una fila por usuario vs. una
 * fila nueva por versión de tarifa): eso lo pone el llamador en `fila`. El helper
 * pone la fecha de vigencia, valida que la tabla sea clase A, y hace el upsert.
 * En la nube, `trg_cambio_log` lo publica hacia las terminales.
 *
 * Que la conexión sea de verdad la de la nube (`sync.nodo.es_nube`) se comprueba
 * UNA vez al arrancar la consola (`src/admin/main.ts`), no en cada escritura:
 * hacerlo por llamada tomaba un lock sobre la fila única `sync.nodo` que
 * serializaba con el resto del sistema.
 */

import type { Consultable } from '../db/consulta.js';
import { claseDe } from '../sync/clases.js';

export type ModoPropagacion = 'ventana' | 'inmediato' | 'programado';

/** P12 sin cerrar: se asume esta zona cuando la fila no apunta a una sucursal. */
export const ZONA_DEFECTO = 'America/Mexico_City';

/** Tablas de configuración que el administrador puede escribir. Allowlist explícita. */
export const TABLAS_ADMINISTRABLES: readonly string[] = [
  'core.agencia',
  'core.sucursal',
  'core.usuario',
  'core.usuario_sucursal',
  'core.rol_permiso',
  'core.ruta',
  'core.ruta_parada',
  'core.horario',
  'core.horario_parada',
  'core.config_impresora',
  'core.config_ticket',
  'core.tarifa',
  'core.parametro',
  'auth_local.credencial',
  'auth_local.revocacion_hotp',
];

export interface EscribirConfigOpts {
  /** Tabla de configuración, p. ej. `core.usuario`. Debe ser clase A. */
  tabla: string;
  /** Columna → valor. `id` es opcional (se genera un uuid v7 si falta). */
  fila: Record<string, unknown>;
  modo: ModoPropagacion;
  /**
   * Dónde va la fecha calculada. `effective_from` para un alta o un cambio
   * (default); `effective_until` para una baja (además el llamador pone
   * `activo: false` en `fila`).
   */
  vigenciaEn?: 'effective_from' | 'effective_until';
  /**
   * Modo `ventana`: zona en que se evalúan las 03:00. Si no se da, se deduce de
   * `fila.zona_horaria`, luego de la sucursal de `fila.sucursal_id`, y si no
   * queda nada, `ZONA_DEFECTO`.
   */
  zonaHoraria?: string;
  /** Modo `programado`: cuándo entra en vigor. Obligatorio en ese modo. */
  fechaProgramada?: Date;
  /** Modo `inmediato` lo exige en `true`: saltarse la ventana es deliberado. */
  confirmarInmediato?: boolean;
  ahora?: () => Date;
}

export interface EscribirConfigResultado {
  id: string;
  vigenciaEn: 'effective_from' | 'effective_until';
  vigenciaDesde: Date;
  /** `true` si fue un alta (INSERT), `false` si actualizó una fila existente. */
  creada: boolean;
}

/** La próxima 03:00 en `zonaHoraria`, a partir de `ahora`. */
export async function proximaVentana(
  db: Consultable,
  zonaHoraria: string,
  ahora: Date = new Date(),
): Promise<Date> {
  const { rows } = await db.query<{ ventana: Date }>(
    `SELECT CASE
              WHEN (h.t AT TIME ZONE $2) <= $1::timestamptz
              THEN ((h.t + interval '1 day') AT TIME ZONE $2)
              ELSE (h.t AT TIME ZONE $2)
            END AS ventana
       FROM (SELECT date_trunc('day', ($1::timestamptz AT TIME ZONE $2))
                    + interval '3 hours' AS t) h`,
    [ahora.toISOString(), zonaHoraria],
  );
  return rows[0]!.ventana;
}

async function columnasReales(db: Consultable, tabla: string): Promise<Set<string>> {
  const [schema, name] = tabla.split('.');
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER'`,
    [schema, name],
  );
  return new Set(rows.map((r) => r.column_name));
}

async function zonaDeLaFila(
  db: Consultable,
  fila: Record<string, unknown>,
  explicita?: string,
): Promise<string> {
  if (explicita) return explicita;
  if (typeof fila['zona_horaria'] === 'string' && fila['zona_horaria']) {
    return fila['zona_horaria'];
  }
  if (typeof fila['sucursal_id'] === 'string' && fila['sucursal_id']) {
    const { rows } = await db.query<{ zona_horaria: string }>(
      `SELECT zona_horaria FROM core.sucursal WHERE id = $1`,
      [fila['sucursal_id']],
    );
    if (rows[0]?.zona_horaria) return rows[0].zona_horaria;
  }
  return ZONA_DEFECTO;
}

async function calcularVigencia(
  db: Consultable,
  opts: EscribirConfigOpts,
  ahora: Date,
): Promise<Date> {
  switch (opts.modo) {
    case 'inmediato':
      if (opts.confirmarInmediato !== true) {
        throw new Error(
          'El modo "inmediato" salta la ventana nocturna y exige confirmarInmediato: true.',
        );
      }
      return ahora;
    case 'programado':
      if (!opts.fechaProgramada) {
        throw new Error('El modo "programado" exige fechaProgramada.');
      }
      return opts.fechaProgramada;
    case 'ventana':
      return proximaVentana(db, await zonaDeLaFila(db, opts.fila, opts.zonaHoraria), ahora);
    default: {
      const _exhaustivo: never = opts.modo;
      throw new Error(`modo de propagación desconocido: ${String(_exhaustivo)}`);
    }
  }
}

const ident = (col: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(col)) {
    throw new Error(`nombre de columna inválido: ${col}`);
  }
  return `"${col}"`;
};

export async function escribirConfig(
  db: Consultable,
  opts: EscribirConfigOpts,
): Promise<EscribirConfigResultado> {
  if (claseDe(opts.tabla) !== 'A') {
    throw new Error(
      `escribirConfig solo escribe configuración de clase A; "${opts.tabla}" no lo es.`,
    );
  }

  const ahora = opts.ahora?.() ?? new Date();
  const vigenciaEn = opts.vigenciaEn ?? 'effective_from';
  const vigenciaDesde = await calcularVigencia(db, opts, ahora);

  const reales = await columnasReales(db, opts.tabla);
  for (const k of Object.keys(opts.fila)) {
    if (!reales.has(k)) {
      throw new Error(`"${opts.tabla}" no tiene la columna "${k}".`);
    }
  }

  // Algunas tablas de clase A no llevan fecha de vigencia a propósito
  // (`core.config_impresora`: la IP es hardware presente, no una política). Ahí
  // solo tiene sentido el modo inmediato; diferir un cambio no tendría dónde
  // anotarse.
  const difiereVigencia = reales.has(vigenciaEn);
  if (!difiereVigencia && opts.modo !== 'inmediato') {
    throw new Error(
      `"${opts.tabla}" no tiene columna "${vigenciaEn}": no admite propagación ` +
        'diferida. Usá modo "inmediato".',
    );
  }

  // No se genera `id` aquí. Si el llamador no lo pasa, lo produce la tabla: un
  // `DEFAULT core.uuid_v7()` para las de id opaco, o el trigger de derivación
  // para las de id calculado (`core.parametro`, `core.rol_permiso`,
  // `auth_local.credencial`, `auth_local.revocacion_hotp`). Inventar un uuid aquí
  // le pisaría el id determinista a esas últimas y rompería la convergencia.
  const filaFinal: Record<string, unknown> = {
    ...opts.fila,
    ...(difiereVigencia ? { [vigenciaEn]: vigenciaDesde } : {}),
  };
  const idDado = opts.fila['id'];

  // ¿La fila ya existe? Un alta y una edición son sentencias distintas: un
  // `INSERT ... ON CONFLICT DO UPDATE` fallaría el NOT NULL de las columnas que
  // una edición parcial no trae (dirección, código...) antes de llegar al
  // `ON CONFLICT`.
  const existente = idDado != null && (
    (await db.query(`SELECT 1 FROM ${opts.tabla} WHERE id = $1`, [idDado])).rowCount ?? 0
  ) > 0;

  let id: string;
  if (existente) {
    const cols = Object.keys(filaFinal).filter((c) => c !== 'id');
    if (cols.length === 0) {
      throw new Error('`fila` no trae ninguna columna que escribir aparte de `id`.');
    }
    const sets = cols.map((c, i) => `${ident(c)} = $${i + 1}`);
    const valores = [...cols.map((c) => filaFinal[c]), idDado];
    const { rows } = await db.query<{ id: string }>(
      `UPDATE ${opts.tabla} SET ${sets.join(', ')} WHERE id = $${cols.length + 1} RETURNING id`,
      valores,
    );
    id = rows[0]!.id;
  } else {
    const cols = Object.keys(filaFinal);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO ${opts.tabla} (${cols.map(ident).join(', ')})
       VALUES (${placeholders.join(', ')}) RETURNING id`,
      Object.values(filaFinal),
    );
    id = rows[0]!.id;
  }

  return { id, vigenciaEn, vigenciaDesde, creada: !existente };
}
