/**
 * Alta, edición y baja de sucursales desde la consola de administración (F2b, slice 2).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5, §3
 *                  docs/architecture/02b-modelo-transaccional.md §1 (folios)
 *
 * `core.sucursal` es clase A: se escribe aquí, en la nube, y baja replicada. Al
 * alta pasan además dos cosas:
 *
 *   - La SEMILLA HOTP (`auth_local.revocacion_hotp`) se genera aquí y baja
 *     replicada (0035). Es la base de la capa 3 de revocación offline (§1.5): el
 *     nodo valida contra ella los códigos que el administrador dicta por teléfono.
 *   - La SECUENCIA DE FOLIOS (`core.folio_secuencia`) la crea sola el trigger
 *     `core.trg_secuencia_folio` cuando la fila de sucursal aterriza en el nodo.
 *     Aquí no hay que hacer nada.
 */

import { randomBytes } from 'node:crypto';
import type { Consultable } from '../db/consulta.js';
import { escribirConfig, type ModoPropagacion } from './escribir-config.js';

/** Alfabeto base32 de Donaji (sin I, L, O, U). Techo de 32 sucursales. */
export const ALFABETO_CODIGO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Bytes de la semilla HOTP. 20 es el estándar de RFC 4226 (SHA-1). */
const BYTES_SEMILLA = 20;

export interface DatosSucursalNueva {
  agenciaId: string;
  nombre: string;
  direccionCompleta: string;
  telefonoPrincipal: string;
  /** Segundo teléfono (celular). Opcional. */
  celular?: string | null;
  /** Un carácter de `ALFABETO_CODIGO`. Si se omite, se asigna el siguiente libre. */
  codigo?: string;
  zonaHoraria?: string;
}

export interface CambiosSucursal {
  nombre?: string;
  direccionCompleta?: string;
  telefonoPrincipal?: string;
  /** Segundo teléfono (celular). Cadena vacía o `null` lo borra. */
  celular?: string | null;
  zonaHoraria?: string;
}

export interface SucursalResumen {
  id: string;
  nombre: string;
  codigo: string;
  direccionCompleta: string;
  telefonoPrincipal: string;
  celular: string | null;
  zonaHoraria: string;
  activo: boolean;
  effectiveFrom: string;
  effectiveUntil: string | null;
  /** ¿Ya tiene semilla HOTP para la revocación offline? */
  tieneHotp: boolean;
}

interface OpcionesEscritura {
  modo?: ModoPropagacion;
  confirmarInmediato?: boolean;
  fechaProgramada?: Date;
  ahora?: () => Date;
}

const pasarModo = (o: OpcionesEscritura): {
  modo: ModoPropagacion; confirmarInmediato?: boolean; fechaProgramada?: Date; ahora?: () => Date;
} => ({
  modo: o.modo ?? 'ventana',
  ...(o.confirmarInmediato ? { confirmarInmediato: true } : {}),
  ...(o.fechaProgramada ? { fechaProgramada: o.fechaProgramada } : {}),
  ...(o.ahora ? { ahora: o.ahora } : {}),
});

/** Todas las sucursales — vigentes, futuras y dadas de baja (vista de administrador). */
export async function listarSucursales(db: Consultable): Promise<SucursalResumen[]> {
  const { rows } = await db.query<{
    id: string; nombre: string; codigo: string; direccion_completa: string;
    telefono_principal: string; celular: string | null; zona_horaria: string; activo: boolean;
    effective_from: Date; effective_until: Date | null; tiene_hotp: boolean;
  }>(
    `SELECT s.id, s.nombre, s.codigo, s.direccion_completa, s.telefono_principal,
            s.celular, s.zona_horaria, s.activo, s.effective_from, s.effective_until,
            EXISTS (SELECT 1 FROM auth_local.revocacion_hotp h
                     WHERE h.sucursal_id = s.id AND h.activo) AS tiene_hotp
       FROM core.sucursal s
      ORDER BY s.codigo`,
  );
  return rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    codigo: r.codigo.trim(),
    direccionCompleta: r.direccion_completa,
    telefonoPrincipal: r.telefono_principal,
    celular: r.celular,
    zonaHoraria: r.zona_horaria,
    activo: r.activo,
    effectiveFrom: r.effective_from.toISOString(),
    effectiveUntil: r.effective_until ? r.effective_until.toISOString() : null,
    tieneHotp: r.tiene_hotp,
  }));
}

async function validarZona(db: Consultable, zona: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM pg_timezone_names WHERE name = $1`, [zona],
  );
  if (rows.length === 0) {
    throw new Error(`zona horaria desconocida: "${zona}"`);
  }
}

async function codigoLibre(db: Consultable): Promise<string> {
  const { rows } = await db.query<{ codigo: string }>(
    `SELECT codigo FROM core.sucursal`,
  );
  const usados = new Set(rows.map((r) => r.codigo.trim()));
  for (const c of ALFABETO_CODIGO) {
    if (!usados.has(c)) return c;
  }
  throw new Error('no quedan códigos de sucursal libres (techo de 32).');
}

/**
 * Da de alta una sucursal y genera su semilla HOTP.
 *
 * La sucursal se propaga según `modo` (default `ventana`); la semilla HOTP va
 * siempre inmediata — es provisión, no una política con fecha.
 */
export async function crearSucursal(
  db: Consultable,
  datos: DatosSucursalNueva,
  opts: OpcionesEscritura = {},
): Promise<{ id: string; codigo: string; effectiveFrom: string }> {
  let codigo = datos.codigo?.toUpperCase();
  if (codigo === undefined) {
    codigo = await codigoLibre(db);
  } else if (codigo.length !== 1 || !ALFABETO_CODIGO.includes(codigo)) {
    throw new Error(
      `código de sucursal inválido: "${datos.codigo}". Un carácter de ${ALFABETO_CODIGO}.`,
    );
  }

  const zona = datos.zonaHoraria ?? 'America/Mexico_City';
  await validarZona(db, zona);

  const celular = datos.celular?.trim() ? datos.celular.trim() : null;
  const sucursal = await escribirConfig(db, {
    tabla: 'core.sucursal',
    fila: {
      agencia_id: datos.agenciaId,
      nombre: datos.nombre,
      direccion_completa: datos.direccionCompleta,
      telefono_principal: datos.telefonoPrincipal,
      celular,
      codigo,
      zona_horaria: zona,
    },
    ...pasarModo(opts),
  });

  await escribirConfig(db, {
    tabla: 'auth_local.revocacion_hotp',
    fila: { sucursal_id: sucursal.id, semilla: randomBytes(BYTES_SEMILLA) },
    modo: 'inmediato',
    confirmarInmediato: true,
    ...(opts.ahora ? { ahora: opts.ahora } : {}),
  });

  return {
    id: sucursal.id,
    codigo,
    effectiveFrom: sucursal.vigenciaDesde.toISOString(),
  };
}

/** Edita campos de una sucursal existente. El `codigo` no se cambia — es la raíz de sus folios. */
export async function editarSucursal(
  db: Consultable,
  id: string,
  cambios: CambiosSucursal,
  opts: OpcionesEscritura = {},
): Promise<{ id: string; effectiveFrom: string }> {
  const fila: Record<string, unknown> = { id };
  if (cambios.nombre !== undefined) fila['nombre'] = cambios.nombre;
  if (cambios.direccionCompleta !== undefined) fila['direccion_completa'] = cambios.direccionCompleta;
  if (cambios.telefonoPrincipal !== undefined) fila['telefono_principal'] = cambios.telefonoPrincipal;
  if (cambios.celular !== undefined) fila['celular'] = cambios.celular?.trim() ? cambios.celular.trim() : null;
  if (cambios.zonaHoraria !== undefined) {
    await validarZona(db, cambios.zonaHoraria);
    fila['zona_horaria'] = cambios.zonaHoraria;
  }

  const r = await escribirConfig(db, { tabla: 'core.sucursal', fila, ...pasarModo(opts) });
  return { id: r.id, effectiveFrom: r.vigenciaDesde.toISOString() };
}

/** Baja lógica: `activo = false` con `effective_until` según el modo. */
export async function darDeBajaSucursal(
  db: Consultable,
  id: string,
  opts: OpcionesEscritura = {},
): Promise<{ id: string; effectiveUntil: string }> {
  const r = await escribirConfig(db, {
    tabla: 'core.sucursal',
    fila: { id, activo: false },
    vigenciaEn: 'effective_until',
    ...pasarModo(opts),
  });
  return { id: r.id, effectiveUntil: r.vigenciaDesde.toISOString() };
}

/** Regenera la semilla HOTP (sospecha de compromiso). Los códigos viejos dejan de valer. */
export async function regenerarHotp(
  db: Consultable,
  sucursalId: string,
  opts: Pick<OpcionesEscritura, 'ahora'> = {},
): Promise<{ sucursalId: string }> {
  await escribirConfig(db, {
    tabla: 'auth_local.revocacion_hotp',
    fila: { id: sucursalId, sucursal_id: sucursalId, semilla: randomBytes(BYTES_SEMILLA), ultimo_usado: -1 },
    modo: 'inmediato',
    confirmarInmediato: true,
    ...(opts.ahora ? { ahora: opts.ahora } : {}),
  });
  return { sucursalId };
}
