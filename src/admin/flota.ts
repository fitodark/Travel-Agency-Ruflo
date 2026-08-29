/**
 * Catálogos de flota: unidades y conductores (F3, cadena D-7).
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §3-4
 *
 * Cadena `conductor → unidad → tipo_unidad → mapa de asientos` (P11 / D-7):
 *
 *   core.tipo_unidad  plantilla con el mapa declarativo (SPRINTER-18, …).
 *                     Se siembra por SQL (`src/db/seed/0001`), NO se edita aquí.
 *   core.unidad       el vehículo físico: nº económico (va en el ticket), placas,
 *                     su tipo, su sucursal base.
 *   core.conductor    la persona: `tipo_unidad_id` OBLIGATORIO (es el portador de
 *                     la relación con el esquema), `unidad_habitual_id` OPCIONAL.
 *
 * Son dos catálogos SEPARADOS. La "asociación con la unidad" es un campo del
 * conductor, no una entidad aparte: una unidad sobrevive a los conductores y se
 * reasigna entre sucursales. El trigger `validar_conductor_unidad` (0003) exige
 * que, si el conductor tiene unidad habitual, su tipo coincida.
 *
 * Ni `core.unidad` ni `core.conductor` llevan `effective_from`/`until`: un
 * vehículo o una persona es un hecho presente, no una política con fecha. Por eso
 * todo va en modo `inmediato` (como `core.config_impresora`).
 */

import type { Consultable } from '../db/consulta.js';
import { escribirConfig } from './escribir-config.js';

const INMEDIATO = { modo: 'inmediato', confirmarInmediato: true } as const;

// ---------------------------------------------------------------------------
// Tipos de unidad — solo lectura (para los selectores de unidad y conductor).
// ---------------------------------------------------------------------------

export interface TipoUnidadResumen {
  id: string;
  clave: string;
  nombre: string;
  numAsientos: number;
}

export async function listarTiposUnidad(db: Consultable): Promise<TipoUnidadResumen[]> {
  const { rows } = await db.query<{ id: string; clave: string; nombre: string; num_asientos: number }>(
    `SELECT id, clave, nombre, num_asientos FROM core.tipo_unidad ORDER BY clave`,
  );
  return rows.map((r) => ({
    id: r.id, clave: r.clave, nombre: r.nombre, numAsientos: Number(r.num_asientos),
  }));
}

// ---------------------------------------------------------------------------
// Unidades
// ---------------------------------------------------------------------------

export interface UnidadResumen {
  id: string;
  numeroEconomico: string;
  placas: string | null;
  tipoUnidadId: string;
  tipoUnidad: string;
  sucursalBaseId: string | null;
  sucursalBase: string | null;
  activo: boolean;
}

export interface DatosUnidadNueva {
  numeroEconomico: string;
  placas?: string | null;
  tipoUnidadId: string;
  sucursalBaseId?: string | null;
}

export interface CambiosUnidad {
  numeroEconomico?: string;
  placas?: string | null;
  tipoUnidadId?: string;
  sucursalBaseId?: string | null;
  activo?: boolean;
}

interface Opciones { ahora?: () => Date }

const conAhora = (o: Opciones): { ahora?: () => Date } => (o.ahora ? { ahora: o.ahora } : {});

export async function listarUnidadesDetalle(db: Consultable): Promise<UnidadResumen[]> {
  const { rows } = await db.query<{
    id: string; numero_economico: string; placas: string | null;
    tipo_unidad_id: string; tipo_unidad: string;
    sucursal_base_id: string | null; sucursal_base: string | null; activo: boolean;
  }>(
    `SELECT u.id, u.numero_economico, u.placas,
            u.tipo_unidad_id, tu.clave AS tipo_unidad,
            u.sucursal_base_id, s.nombre AS sucursal_base, u.activo
       FROM core.unidad u
       JOIN core.tipo_unidad tu ON tu.id = u.tipo_unidad_id
       LEFT JOIN core.sucursal s ON s.id = u.sucursal_base_id
      ORDER BY u.activo DESC, u.numero_economico`,
  );
  return rows.map((r) => ({
    id: r.id,
    numeroEconomico: r.numero_economico,
    placas: r.placas,
    tipoUnidadId: r.tipo_unidad_id,
    tipoUnidad: r.tipo_unidad,
    sucursalBaseId: r.sucursal_base_id,
    sucursalBase: r.sucursal_base,
    activo: r.activo,
  }));
}

export async function crearUnidad(
  db: Consultable, datos: DatosUnidadNueva, opts: Opciones = {},
): Promise<{ id: string }> {
  const numero = datos.numeroEconomico.trim();
  if (!numero) throw new Error('el número económico es obligatorio');
  if (!datos.tipoUnidadId) throw new Error('la unidad necesita un tipo de unidad');

  const { rowCount } = await db.query(
    `SELECT 1 FROM core.unidad WHERE numero_economico = $1`, [numero],
  );
  if (rowCount) throw new Error(`ya hay una unidad con número económico "${numero}"`);

  const fila: Record<string, unknown> = {
    numero_economico: numero,
    tipo_unidad_id: datos.tipoUnidadId,
    placas: datos.placas ?? null,
    sucursal_base_id: datos.sucursalBaseId ?? null,
  };
  const r = await escribirConfig(db, { tabla: 'core.unidad', fila, ...INMEDIATO, ...conAhora(opts) });
  return { id: r.id };
}

export async function editarUnidad(
  db: Consultable, id: string, cambios: CambiosUnidad, opts: Opciones = {},
): Promise<{ id: string }> {
  const fila: Record<string, unknown> = { id };
  if (cambios.numeroEconomico !== undefined) fila['numero_economico'] = cambios.numeroEconomico.trim();
  if (cambios.placas !== undefined) fila['placas'] = cambios.placas;
  if (cambios.tipoUnidadId !== undefined) fila['tipo_unidad_id'] = cambios.tipoUnidadId;
  if (cambios.sucursalBaseId !== undefined) fila['sucursal_base_id'] = cambios.sucursalBaseId;
  if (cambios.activo !== undefined) {
    fila['activo'] = cambios.activo;
    if (cambios.activo) fila['desactivado_en'] = null;
  }
  const r = await escribirConfig(db, { tabla: 'core.unidad', fila, ...INMEDIATO, ...conAhora(opts) });
  return { id: r.id };
}

/** Baja lógica: `activo = false` (el trigger estándar pone `desactivado_en`). */
export async function darDeBajaUnidad(
  db: Consultable, id: string, opts: Opciones = {},
): Promise<{ id: string }> {
  const r = await escribirConfig(db, {
    tabla: 'core.unidad', fila: { id, activo: false }, ...INMEDIATO, ...conAhora(opts),
  });
  return { id: r.id };
}

// ---------------------------------------------------------------------------
// Conductores
// ---------------------------------------------------------------------------

export interface ConductorResumen {
  id: string;
  nombre: string;
  telefono: string | null;
  ineNumero: string | null;
  contactoNombre: string | null;
  contactoTelefono: string | null;
  tipoUnidadId: string;
  tipoUnidad: string;
  unidadHabitualId: string | null;
  unidadHabitual: string | null;
  activo: boolean;
}

export interface DatosConductorNuevo {
  nombre: string;
  telefono?: string | null;
  direccion?: string | null;
  ineNumero?: string | null;
  contactoNombre?: string | null;
  contactoTelefono?: string | null;
  tipoUnidadId: string;
  unidadHabitualId?: string | null;
}

export interface CambiosConductor {
  nombre?: string;
  telefono?: string | null;
  direccion?: string | null;
  ineNumero?: string | null;
  contactoNombre?: string | null;
  contactoTelefono?: string | null;
  tipoUnidadId?: string;
  unidadHabitualId?: string | null;
  activo?: boolean;
}

export async function listarConductoresDetalle(db: Consultable): Promise<ConductorResumen[]> {
  const { rows } = await db.query<{
    id: string; nombre: string; telefono: string | null; ine_numero: string | null;
    contacto_nombre: string | null; contacto_telefono: string | null;
    tipo_unidad_id: string; tipo_unidad: string;
    unidad_habitual_id: string | null; unidad_habitual: string | null; activo: boolean;
  }>(
    `SELECT c.id, c.nombre, c.telefono, c.ine_numero, c.contacto_nombre, c.contacto_telefono,
            c.tipo_unidad_id, tu.clave AS tipo_unidad,
            c.unidad_habitual_id, u.numero_economico AS unidad_habitual, c.activo
       FROM core.conductor c
       JOIN core.tipo_unidad tu ON tu.id = c.tipo_unidad_id
       LEFT JOIN core.unidad u ON u.id = c.unidad_habitual_id
      ORDER BY c.activo DESC, c.nombre`,
  );
  return rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    telefono: r.telefono,
    ineNumero: r.ine_numero,
    contactoNombre: r.contacto_nombre,
    contactoTelefono: r.contacto_telefono,
    tipoUnidadId: r.tipo_unidad_id,
    tipoUnidad: r.tipo_unidad,
    unidadHabitualId: r.unidad_habitual_id,
    unidadHabitual: r.unidad_habitual,
    activo: r.activo,
  }));
}

/**
 * Coherencia de la cadena antes de escribir: si se da unidad habitual, su tipo
 * tiene que ser el mismo que el del conductor. El trigger de la base lo valida
 * también, pero un mensaje claro aquí evita un `P0001` opaco en el cliente.
 */
async function validarCadena(
  db: Consultable, tipoUnidadId: string | undefined, unidadHabitualId: string | null | undefined,
): Promise<void> {
  if (!unidadHabitualId) return;
  const { rows } = await db.query<{ tipo_unidad_id: string }>(
    `SELECT tipo_unidad_id FROM core.unidad WHERE id = $1`, [unidadHabitualId],
  );
  if (!rows[0]) throw new Error('la unidad habitual no existe');
  if (tipoUnidadId !== undefined && rows[0].tipo_unidad_id !== tipoUnidadId) {
    throw new Error('la unidad habitual es de otro tipo que el del conductor');
  }
}

export async function crearConductor(
  db: Consultable, datos: DatosConductorNuevo, opts: Opciones = {},
): Promise<{ id: string }> {
  const nombre = datos.nombre.trim();
  if (!nombre) throw new Error('el nombre del conductor es obligatorio');
  if (!datos.tipoUnidadId) throw new Error('el conductor necesita un tipo de unidad (D-7)');
  await validarCadena(db, datos.tipoUnidadId, datos.unidadHabitualId);

  const fila: Record<string, unknown> = {
    nombre,
    tipo_unidad_id: datos.tipoUnidadId,
    telefono: datos.telefono ?? null,
    direccion: datos.direccion ?? null,
    ine_numero: datos.ineNumero ?? null,
    contacto_nombre: datos.contactoNombre ?? null,
    contacto_telefono: datos.contactoTelefono ?? null,
    unidad_habitual_id: datos.unidadHabitualId ?? null,
  };
  const r = await escribirConfig(db, { tabla: 'core.conductor', fila, ...INMEDIATO, ...conAhora(opts) });
  return { id: r.id };
}

export async function editarConductor(
  db: Consultable, id: string, cambios: CambiosConductor, opts: Opciones = {},
): Promise<{ id: string }> {
  // El tipo efectivo tras el cambio, para validar la cadena aunque solo se toque
  // uno de los dos campos.
  let tipoEfectivo = cambios.tipoUnidadId;
  if (cambios.unidadHabitualId && tipoEfectivo === undefined) {
    const { rows } = await db.query<{ tipo_unidad_id: string }>(
      `SELECT tipo_unidad_id FROM core.conductor WHERE id = $1`, [id],
    );
    tipoEfectivo = rows[0]?.tipo_unidad_id;
  }
  await validarCadena(db, tipoEfectivo, cambios.unidadHabitualId);

  const fila: Record<string, unknown> = { id };
  if (cambios.nombre !== undefined) fila['nombre'] = cambios.nombre.trim();
  if (cambios.telefono !== undefined) fila['telefono'] = cambios.telefono;
  if (cambios.direccion !== undefined) fila['direccion'] = cambios.direccion;
  if (cambios.ineNumero !== undefined) fila['ine_numero'] = cambios.ineNumero;
  if (cambios.contactoNombre !== undefined) fila['contacto_nombre'] = cambios.contactoNombre;
  if (cambios.contactoTelefono !== undefined) fila['contacto_telefono'] = cambios.contactoTelefono;
  if (cambios.tipoUnidadId !== undefined) fila['tipo_unidad_id'] = cambios.tipoUnidadId;
  if (cambios.unidadHabitualId !== undefined) fila['unidad_habitual_id'] = cambios.unidadHabitualId;
  if (cambios.activo !== undefined) {
    fila['activo'] = cambios.activo;
    if (cambios.activo) fila['desactivado_en'] = null;
  }
  const r = await escribirConfig(db, { tabla: 'core.conductor', fila, ...INMEDIATO, ...conAhora(opts) });
  return { id: r.id };
}

export async function darDeBajaConductor(
  db: Consultable, id: string, opts: Opciones = {},
): Promise<{ id: string }> {
  const r = await escribirConfig(db, {
    tabla: 'core.conductor', fila: { id, activo: false }, ...INMEDIATO, ...conAhora(opts),
  });
  return { id: r.id };
}
