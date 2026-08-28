/**
 * Alta, edición, baja y credenciales de usuarios desde la consola (F2b, slice 3).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.2, §1.4, §3
 *
 * `core.usuario`, `core.usuario_sucursal` y `auth_local.credencial` son clase A:
 * se escriben aquí, en la nube, y bajan replicadas. El hash Argon2id de la
 * contraseña se calcula EN LA NUBE (§1.2) — el nodo nunca ve la contraseña en
 * claro salvo en el instante del login.
 *
 * Un usuario nuevo se entrega con una CONTRASEÑA TEMPORAL y `debe_cambiar = true`:
 * la consola la devuelve una sola vez para que el administrador la comunique, y
 * el nodo obliga a cambiarla en el primer login.
 */

import { randomInt } from 'node:crypto';
import type { Consultable } from '../db/consulta.js';
import { hashPassword } from '../auth/passwords.js';
import { escribirConfig, type ModoPropagacion } from './escribir-config.js';

export type RolUsuario = 'administrador' | 'gerente' | 'vendedor';
const ROLES: readonly RolUsuario[] = ['administrador', 'gerente', 'vendedor'];

/** Alfabeto sin caracteres que se confunden al dictar por teléfono. */
const ALFABETO_PW = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Contraseña temporal legible: 3 grupos de 4, p. ej. `K7NP-2QRS-9XYZ`. */
export function contraseñaTemporal(): string {
  const grupo = (): string =>
    Array.from({ length: 4 }, () => ALFABETO_PW[randomInt(ALFABETO_PW.length)]).join('');
  return `${grupo()}-${grupo()}-${grupo()}`;
}

export interface OpcionesEscritura {
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

export interface DatosUsuarioNuevo {
  nombre: string;
  email: string;
  rol: RolUsuario;
  telefono?: string;
  sueldo?: number;
  /** Sucursales a las que queda asignado. */
  sucursalIds?: string[];
  /** Si se omite, se genera una. */
  passwordTemporal?: string;
}

export interface CambiosUsuario {
  nombre?: string;
  rol?: RolUsuario;
  telefono?: string | null;
  sueldo?: number | null;
}

export interface UsuarioResumen {
  id: string;
  nombre: string;
  email: string;
  rol: RolUsuario;
  telefono: string | null;
  activo: boolean;
  effectiveFrom: string;
  effectiveUntil: string | null;
  tieneCredencial: boolean;
  debeCambiarPassword: boolean;
  sucursales: { id: string; nombre: string; codigo: string; activa: boolean }[];
}

function exigeRol(rol: string): asserts rol is RolUsuario {
  if (!ROLES.includes(rol as RolUsuario)) {
    throw new Error(`rol inválido: "${rol}". Uno de: ${ROLES.join(', ')}.`);
  }
}

export async function listarUsuarios(db: Consultable): Promise<UsuarioResumen[]> {
  const { rows } = await db.query<{
    id: string; nombre: string; email: string; rol: RolUsuario; telefono: string | null;
    activo: boolean; effective_from: Date; effective_until: Date | null;
    tiene_credencial: boolean; debe_cambiar: boolean;
    sucursales: { id: string; nombre: string; codigo: string; activa: boolean }[] | null;
  }>(
    `SELECT u.id, u.nombre, u.email::text AS email, u.rol, u.telefono, u.activo,
            u.effective_from, u.effective_until,
            c.usuario_id IS NOT NULL AS tiene_credencial,
            COALESCE(c.debe_cambiar, false) AS debe_cambiar,
            (SELECT jsonb_agg(jsonb_build_object(
                      'id', s.id, 'nombre', s.nombre, 'codigo', trim(s.codigo),
                      'activa', us.activo AND us.effective_from <= now()
                                AND (us.effective_until IS NULL OR us.effective_until > now()))
                    ORDER BY s.codigo)
               FROM core.usuario_sucursal us
               JOIN core.sucursal s ON s.id = us.sucursal_id
              WHERE us.usuario_id = u.id) AS sucursales
       FROM core.usuario u
       LEFT JOIN auth_local.credencial c ON c.usuario_id = u.id
      ORDER BY u.nombre`,
  );
  return rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    email: r.email,
    rol: r.rol,
    telefono: r.telefono,
    activo: r.activo,
    effectiveFrom: r.effective_from.toISOString(),
    effectiveUntil: r.effective_until ? r.effective_until.toISOString() : null,
    tieneCredencial: r.tiene_credencial,
    debeCambiarPassword: r.debe_cambiar,
    sucursales: r.sucursales ?? [],
  }));
}

/**
 * Da de alta un usuario: la fila, sus sucursales, y una credencial temporal.
 *
 * El usuario y las asignaciones se propagan según `modo`; la credencial va
 * siempre inmediata — sin ella el usuario no puede entrar aunque su fila ya esté
 * vigente.
 */
export async function crearUsuario(
  db: Consultable,
  datos: DatosUsuarioNuevo,
  opts: OpcionesEscritura = {},
): Promise<{ id: string; passwordTemporal: string; effectiveFrom: string }> {
  exigeRol(datos.rol);
  const pw = datos.passwordTemporal ?? contraseñaTemporal();

  const usuario = await escribirConfig(db, {
    tabla: 'core.usuario',
    fila: {
      nombre: datos.nombre,
      email: datos.email.toLowerCase(),
      rol: datos.rol,
      ...(datos.telefono !== undefined ? { telefono: datos.telefono } : {}),
      ...(datos.sueldo !== undefined ? { sueldo: datos.sueldo } : {}),
    },
    ...pasarModo(opts),
  });

  for (const sucursalId of datos.sucursalIds ?? []) {
    await asignarSucursal(db, { usuarioId: usuario.id, sucursalId }, opts);
  }

  await ponerCredencial(db, usuario.id, pw, opts.ahora);

  return { id: usuario.id, passwordTemporal: pw, effectiveFrom: usuario.vigenciaDesde.toISOString() };
}

export async function editarUsuario(
  db: Consultable,
  id: string,
  cambios: CambiosUsuario,
  opts: OpcionesEscritura = {},
): Promise<{ id: string; effectiveFrom: string }> {
  const fila: Record<string, unknown> = { id };
  if (cambios.nombre !== undefined) fila['nombre'] = cambios.nombre;
  if (cambios.rol !== undefined) { exigeRol(cambios.rol); fila['rol'] = cambios.rol; }
  if (cambios.telefono !== undefined) fila['telefono'] = cambios.telefono;
  if (cambios.sueldo !== undefined) fila['sueldo'] = cambios.sueldo;

  const r = await escribirConfig(db, { tabla: 'core.usuario', fila, ...pasarModo(opts) });
  return { id: r.id, effectiveFrom: r.vigenciaDesde.toISOString() };
}

/**
 * Baja lógica del usuario. Por defecto INMEDIATA (§3.4: "riesgo de seguridad",
 * recomendado). El aplicador del nodo cierra su sesión viva en la siguiente pasada.
 */
export async function darDeBajaUsuario(
  db: Consultable,
  id: string,
  opts: OpcionesEscritura = {},
): Promise<{ id: string; effectiveUntil: string }> {
  const r = await escribirConfig(db, {
    tabla: 'core.usuario',
    fila: { id, activo: false },
    vigenciaEn: 'effective_until',
    ...pasarModo({ modo: 'inmediato', confirmarInmediato: true, ...opts }),
  });
  return { id: r.id, effectiveUntil: r.vigenciaDesde.toISOString() };
}

/** Asigna (o reactiva) al usuario en una sucursal. */
export async function asignarSucursal(
  db: Consultable,
  args: { usuarioId: string; sucursalId: string },
  opts: OpcionesEscritura = {},
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM core.usuario_sucursal WHERE usuario_id = $1 AND sucursal_id = $2`,
    [args.usuarioId, args.sucursalId],
  );
  const fila: Record<string, unknown> = rows[0]
    ? { id: rows[0].id, activo: true, effective_until: null }
    : { usuario_id: args.usuarioId, sucursal_id: args.sucursalId };

  const r = await escribirConfig(db, { tabla: 'core.usuario_sucursal', fila, ...pasarModo(opts) });
  return { id: r.id };
}

/** Quita al usuario de una sucursal (baja lógica con `effective_until`). */
export async function quitarSucursal(
  db: Consultable,
  args: { usuarioId: string; sucursalId: string },
  opts: OpcionesEscritura = {},
): Promise<{ id: string; effectiveUntil: string }> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM core.usuario_sucursal WHERE usuario_id = $1 AND sucursal_id = $2`,
    [args.usuarioId, args.sucursalId],
  );
  if (!rows[0]) throw new Error('el usuario no está asignado a esa sucursal');

  const r = await escribirConfig(db, {
    tabla: 'core.usuario_sucursal',
    fila: { id: rows[0].id, activo: false },
    vigenciaEn: 'effective_until',
    ...pasarModo({ modo: 'inmediato', confirmarInmediato: true, ...opts }),
  });
  return { id: r.id, effectiveUntil: r.vigenciaDesde.toISOString() };
}

/** Nueva contraseña temporal + `debe_cambiar`. La contraseña vieja deja de valer. */
export async function restablecerPassword(
  db: Consultable,
  usuarioId: string,
  args: { passwordTemporal?: string } = {},
  opts: Pick<OpcionesEscritura, 'ahora'> = {},
): Promise<{ passwordTemporal: string }> {
  const pw = args.passwordTemporal ?? contraseñaTemporal();
  await ponerCredencial(db, usuarioId, pw, opts.ahora);
  return { passwordTemporal: pw };
}

/**
 * Upsert de la credencial. Siempre inmediata: sin credencial vigente el usuario
 * no entra, aunque su fila ya lo esté. `id = usuario_id` (1:1), así que se pasa
 * explícito para que un restablecimiento sea UPDATE y no choque contra la PK.
 */
async function ponerCredencial(
  db: Consultable,
  usuarioId: string,
  passwordPlano: string,
  ahora?: () => Date,
): Promise<void> {
  await escribirConfig(db, {
    tabla: 'auth_local.credencial',
    fila: {
      id: usuarioId,
      usuario_id: usuarioId,
      hash_password: await hashPassword(passwordPlano),
      algoritmo: 'argon2id',
      debe_cambiar: true,
    },
    modo: 'inmediato',
    confirmarInmediato: true,
    ...(ahora ? { ahora } : {}),
  });
}
