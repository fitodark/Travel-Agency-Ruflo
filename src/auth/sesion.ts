/**
 * Sesiones locales — token opaco, no JWT.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.2, §1.3
 *
 * Siendo todo local no hay ventaja en un token autocontenido y sí desventaja: un
 * JWT no se puede revocar. La sesión es una fila en `auth_local.sesion` y el
 * token es su `id` (uuidv7). TTL 12 h o cierre de turno, lo que ocurra primero.
 *
 * Las sesiones NO se replican a la nube (son ruido operativo); solo un resumen
 * de login viaja para auditoría.
 */

import type { Consultable } from '../db/consulta.js';

/** Duración de la sesión. Blueprint §1.2. */
export const TTL_HORAS = 12;

export interface Sesion {
  id: string;
  usuarioId: string;
  rol: string;
  /** `null` mientras el usuario no ha elegido sucursal: la sesión no puede operar. */
  sucursalId: string | null;
  sucursalElegidaEn: Date | null;
  emitidaEn: Date;
  expiraEn: Date;
}

interface FilaSesion {
  id: string;
  usuario_id: string;
  rol: string;
  sucursal_id: string | null;
  sucursal_elegida_en: Date | null;
  emitida_en: Date;
  expira_en: Date;
}

const mapear = (f: FilaSesion): Sesion => ({
  id: f.id,
  usuarioId: f.usuario_id,
  rol: f.rol,
  sucursalId: f.sucursal_id,
  sucursalElegidaEn: f.sucursal_elegida_en,
  emitidaEn: f.emitida_en,
  expiraEn: f.expira_en,
});

/**
 * Abre una sesión. Si viene `sucursalId` queda completa y lista para operar; si
 * no, hay que llamar a `seleccionarSucursal` antes.
 *
 * NO valida credenciales ni vigencia: eso es responsabilidad de `login`. Aquí
 * solo se materializa la fila.
 */
export async function abrirSesion(
  node: Consultable,
  args: {
    usuarioId: string;
    sucursalId?: string | null;
    cajaId?: string | null;
    ahora?: () => Date;
  },
): Promise<Sesion> {
  const ahora = args.ahora?.() ?? new Date();
  const expira = new Date(ahora.getTime() + TTL_HORAS * 3_600_000);
  const sucursal = args.sucursalId ?? null;

  const { rows } = await node.query<FilaSesion>(
    `WITH nueva AS (
       INSERT INTO auth_local.sesion
         (usuario_id, sucursal_id, sucursal_elegida_en, caja_id, emitida_en, expira_en)
       VALUES ($1::uuid, $2::uuid,
               CASE WHEN $2::uuid IS NULL THEN NULL ELSE $3::timestamptz END,
               $4::text, $3::timestamptz, $5::timestamptz)
       RETURNING id, usuario_id, sucursal_id, sucursal_elegida_en, emitida_en, expira_en
     )
     SELECT n.*, u.rol
       FROM nueva n
       JOIN core.usuario u ON u.id = n.usuario_id`,
    [args.usuarioId, sucursal, ahora, args.cajaId ?? null, expira],
  );
  return mapear(rows[0]!);
}

/**
 * Devuelve la sesión si está viva: existe, no cerrada, no expirada, y su usuario
 * sigue vigente. `null` en cualquier otro caso.
 *
 * La vigencia del usuario se comprueba aquí como defensa en profundidad: aunque
 * el aplicador de configuración cierra las sesiones de un usuario dado de baja,
 * una sesión no debe sobrevivir a la baja de su dueño ni un minuto. Se evalúa
 * contra `ahora` (inyectable) para poder probar el paso del tiempo.
 */
export async function verificarSesion(
  node: Consultable,
  token: string,
  opts: { ahora?: () => Date } = {},
): Promise<Sesion | null> {
  const ahora = opts.ahora?.() ?? new Date();
  const { rows } = await node.query<FilaSesion>(
    `SELECT s.id, s.usuario_id, s.sucursal_id, s.sucursal_elegida_en,
            s.emitida_en, s.expira_en, u.rol
       FROM auth_local.sesion s
       JOIN core.usuario u ON u.id = s.usuario_id
      WHERE s.id = $1
        AND s.cerrada_en IS NULL
        AND s.expira_en > $2
        AND u.activo
        AND u.effective_from <= $2
        AND (u.effective_until IS NULL OR u.effective_until > $2)`,
    [token, ahora],
  );
  return rows[0] ? mapear(rows[0]) : null;
}

export interface SucursalBreve {
  id: string;
  nombre: string;
}

/**
 * Sucursales que el usuario tiene asignadas y vigentes ahora — las que puede
 * elegir para operar. Misma regla que el paso 4 de `login`.
 */
export async function sucursalesDe(
  node: Consultable,
  usuarioId: string,
  ahora: Date = new Date(),
): Promise<SucursalBreve[]> {
  const { rows } = await node.query<{ id: string; nombre: string }>(
    `SELECT s.id, s.nombre
       FROM core.usuario_sucursal us
       JOIN core.sucursal s ON s.id = us.sucursal_id
      WHERE us.usuario_id = $1 AND us.activo AND s.activo
        AND us.effective_from <= $2 AND (us.effective_until IS NULL OR us.effective_until > $2)
        AND s.effective_from  <= $2 AND (s.effective_until  IS NULL OR s.effective_until  > $2)
      ORDER BY s.nombre`,
    [usuarioId, ahora],
  );
  return rows;
}

export type SeleccionResultado =
  | { ok: true; sucursalId: string }
  | { ok: false; motivo: 'sesion_invalida' | 'sucursal_no_asignada' | 'ya_elegida' };

/**
 * Completa una sesión eligiendo la sucursal desde la que se va a operar, o —con
 * `permitirCambio`— la cambia a otra de las asignadas.
 *
 * Solo acepta sucursales que el usuario tiene asignadas y vigentes. Sin
 * `permitirCambio` no se puede reelegir (el flujo de login es de una vía); el
 * cambio en caliente lo habilita `POST /auth/cambiar-sucursal`, que además
 * comprueba que no haya un corte de caja abierto en la sucursal que se deja.
 */
export async function seleccionarSucursal(
  node: Consultable,
  args: { token: string; sucursalId: string; ahora?: () => Date; permitirCambio?: boolean },
): Promise<SeleccionResultado> {
  const ahora = args.ahora?.() ?? new Date();
  const sesion = await verificarSesion(node, args.token, { ahora: () => ahora });
  if (!sesion) return { ok: false, motivo: 'sesion_invalida' };
  if (sesion.sucursalId !== null && !args.permitirCambio) {
    return { ok: false, motivo: 'ya_elegida' };
  }

  const { rows } = await node.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM core.usuario_sucursal us
        WHERE us.usuario_id = $1 AND us.sucursal_id = $2 AND us.activo
          AND us.effective_from <= $3
          AND (us.effective_until IS NULL OR us.effective_until > $3)
     ) AS ok`,
    [sesion.usuarioId, args.sucursalId, ahora],
  );
  if (!rows[0]!.ok) return { ok: false, motivo: 'sucursal_no_asignada' };

  await node.query(
    `UPDATE auth_local.sesion
        SET sucursal_id = $2, sucursal_elegida_en = $3
      WHERE id = $1`,
    [args.token, args.sucursalId, ahora],
  );
  return { ok: true, sucursalId: args.sucursalId };
}

/** Cierra una sesión. Idempotente: cerrar una ya cerrada no hace nada. */
export async function cerrarSesion(
  node: Consultable,
  token: string,
  motivo = 'logout',
): Promise<void> {
  await node.query(
    `UPDATE auth_local.sesion
        SET cerrada_en = now(), cerrada_motivo = $2
      WHERE id = $1 AND cerrada_en IS NULL`,
    [token, motivo],
  );
}

/**
 * Cierra todas las sesiones vivas de un usuario. Lo usa el aplicador de
 * configuración cuando la vigencia de un usuario termina (03 §3.3).
 * Devuelve cuántas cerró.
 */
export async function cerrarSesionesDe(
  node: Consultable,
  usuarioId: string,
  motivo: string,
): Promise<number> {
  const { rowCount } = await node.query(
    `UPDATE auth_local.sesion
        SET cerrada_en = now(), cerrada_motivo = $2
      WHERE usuario_id = $1 AND cerrada_en IS NULL`,
    [usuarioId, motivo],
  );
  return rowCount ?? 0;
}
