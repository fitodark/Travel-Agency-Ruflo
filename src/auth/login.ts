/**
 * Login offline-safe.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.3, §1.5
 *
 * CERO llamadas a la nube. Valida contra la base local y funciona igual con o
 * sin internet. La secuencia:
 *
 *   rate-limit → credencial → Argon2id verify → vigencia del usuario y de la
 *   credencial → sucursal activa (req: "solo si tienen sucursal activa") →
 *   stale-guard §1.5 → abrir sesión.
 *
 * Todo con un reloj inyectable (`ahora`): las pruebas de "baja programada a las
 * 03:00" y "73 h sin sync" no pueden exigir esperar horas.
 */

import type { Consultable } from '../db/consulta.js';
import { abrirSesion } from './sesion.js';
import { verifyPassword } from './passwords.js';

/** Fallos permitidos por email antes de bloquear temporalmente. */
const MAX_INTENTOS_FALLIDOS = 10;
/** Ventana del rate-limit, en minutos. */
const VENTANA_INTENTOS_MIN = 15;
/** "No ha iniciado sesión en las últimas N horas" del stale-guard §1.5. */
const LOGIN_RECIENTE_HORAS = 24;
/** Umbral de modo degradado por defecto (SUPUESTO S9). El valor real vive en
 *  `core.parametro('umbral_sync_degradado_horas')`. */
const DEGRADADO_HORAS_DEFAULT = 72;

export type MotivoRechazo =
  | 'credenciales'
  | 'usuario_no_vigente'
  | 'credencial_no_vigente'
  | 'sin_sucursal_activa'
  | 'bloqueo_degradado'
  | 'demasiados_intentos';

export interface LoginOk {
  ok: true;
  /** Token opaco = `auth_local.sesion.id`. */
  token: string;
  usuarioId: string;
  rol: string;
  debeCambiar: boolean;
  /** Sucursales entre las que el usuario puede elegir para operar. */
  sucursales: { id: string; nombre: string }[];
  /**
   * `true` si la sesión ya tiene sucursal (el usuario tenía una sola, o se pasó
   * `sucursalId` válido). Si es `false`, hay que llamar a `seleccionarSucursal`
   * antes de operar.
   */
  sesionCompleta: boolean;
}

export type LoginResult = LoginOk | { ok: false; motivo: MotivoRechazo };

export interface LoginArgs {
  node: Consultable;
  email: string;
  password: string;
  /** Sucursal preseleccionada (p. ej. la SPA recuerda la última). Opcional. */
  sucursalId?: string;
  cajaId?: string | null;
  ip?: string | null;
  ahora?: () => Date;
  /** El gerente autoriza presencialmente el primer login en modo degradado. */
  autorizadoPorGerente?: boolean;
}

interface FilaCredencial {
  id: string;
  rol: string;
  activo: boolean;
  u_from: Date;
  u_until: Date | null;
  hash_password: string;
  c_from: Date;
  c_until: Date | null;
  debe_cambiar: boolean;
}

/**
 * ¿El nodo lleva más del umbral sin sincronizar?
 *
 * Un nodo que NUNCA sincronizó (recién instalado) NO está degradado: no está
 * atrasado, está empezando. Mismo criterio que `engine.ts` y `salud.ts`.
 */
export async function estaDegradado(node: Consultable, ahora: Date): Promise<boolean> {
  const { rows: p } = await node.query<{ valor: unknown }>(
    `SELECT valor FROM core.parametro
      WHERE clave = 'umbral_sync_degradado_horas' AND effective_from <= $1::timestamptz
      ORDER BY effective_from DESC LIMIT 1`,
    [ahora],
  );
  const horas = Number(p[0]?.valor ?? DEGRADADO_HORAS_DEFAULT);

  const { rows: s } = await node.query<{ ultima: Date | null }>(
    `SELECT ultima_sync_exitosa AS ultima FROM sync.salud
      WHERE sucursal_id = sync.sucursal_local()`,
  );
  const ultima = s[0]?.ultima ?? null;
  return ultima !== null && ahora.getTime() - ultima.getTime() > horas * 3_600_000;
}

async function registrarIntento(
  node: Consultable, email: string, exito: boolean, ip: string | null, ahora: Date,
): Promise<void> {
  await node.query(
    `INSERT INTO auth_local.intento (email, exito, ip, ocurrido_en)
     VALUES ($1::citext, $2::boolean, $3::inet, $4::timestamptz)`,
    [email, exito, ip, ahora],
  );
}

export async function login(args: LoginArgs): Promise<LoginResult> {
  const { node } = args;
  const ahora = args.ahora?.() ?? new Date();
  const email = args.email.trim();
  const ip = args.ip ?? null;

  // 1 · Rate-limit por email. No se registra el propio rechazo: la cuenta ya
  //     está alta y engordarla alargaría el bloqueo indefinidamente.
  const { rows: rl } = await node.query<{ n: string }>(
    `SELECT count(*) AS n FROM auth_local.intento
      WHERE email = $1::citext AND NOT exito
        AND ocurrido_en > $2::timestamptz - make_interval(mins => $3::int)`,
    [email, ahora, VENTANA_INTENTOS_MIN],
  );
  if (Number(rl[0]!.n) >= MAX_INTENTOS_FALLIDOS) {
    return { ok: false, motivo: 'demasiados_intentos' };
  }

  // 2 · Credencial. Un email inexistente y una contraseña mala devuelven lo
  //     mismo, para no revelar qué cuentas existen.
  const { rows: cred } = await node.query<FilaCredencial>(
    `SELECT u.id, u.rol, u.activo,
            u.effective_from AS u_from, u.effective_until AS u_until,
            c.hash_password,
            c.effective_from AS c_from, c.effective_until AS c_until, c.debe_cambiar
       FROM core.usuario u
       JOIN auth_local.credencial c ON c.usuario_id = u.id
      WHERE u.email = $1::citext`,
    [email],
  );
  const c = cred[0];
  if (!c || !(await verifyPassword(c.hash_password, args.password))) {
    await registrarIntento(node, email, false, ip, ahora);
    return { ok: false, motivo: 'credenciales' };
  }

  // 3 · Vigencia. La ventana de madrugada se implementa como DATO con fecha
  //     efectiva; aquí se evalúa contra `ahora` (inyectable).
  const vigente = (desde: Date, hasta: Date | null): boolean =>
    desde <= ahora && (hasta === null || hasta > ahora);

  if (!c.activo || !vigente(c.u_from, c.u_until)) {
    await registrarIntento(node, email, false, ip, ahora);
    return { ok: false, motivo: 'usuario_no_vigente' };
  }
  if (!vigente(c.c_from, c.c_until)) {
    await registrarIntento(node, email, false, ip, ahora);
    return { ok: false, motivo: 'credencial_no_vigente' };
  }

  // 4 · Sucursal activa (req: "los usuarios solo podrán ingresar si tienen una
  //     sucursal activa").
  const { rows: sucs } = await node.query<{ id: string; nombre: string }>(
    `SELECT s.id, s.nombre
       FROM core.usuario_sucursal us
       JOIN core.sucursal s ON s.id = us.sucursal_id
      WHERE us.usuario_id = $1 AND us.activo AND s.activo
        AND us.effective_from <= $2 AND (us.effective_until IS NULL OR us.effective_until > $2)
        AND s.effective_from  <= $2 AND (s.effective_until  IS NULL OR s.effective_until  > $2)
      ORDER BY s.nombre`,
    [c.id, ahora],
  );
  if (sucs.length === 0) {
    await registrarIntento(node, email, false, ip, ahora);
    return { ok: false, motivo: 'sin_sucursal_activa' };
  }

  // 5 · Stale-guard §1.5, capa 2. En modo degradado se sigue vendiendo, pero se
  //     bloquea el PRIMER login de un usuario que no entró en las últimas 24 h,
  //     salvo autorización presencial de un gerente.
  if (!args.autorizadoPorGerente && (await estaDegradado(node, ahora))) {
    const { rows: rec } = await node.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM auth_local.intento
          WHERE email = $1::citext AND exito
            AND ocurrido_en > $2::timestamptz - make_interval(hours => $3::int)
       ) AS ok`,
      [email, ahora, LOGIN_RECIENTE_HORAS],
    );
    if (!rec[0]!.ok) {
      await registrarIntento(node, email, false, ip, ahora);
      return { ok: false, motivo: 'bloqueo_degradado' };
    }
  }

  // 6 · Resolver sucursal: la preseleccionada si es válida; si el usuario tiene
  //     una sola, esa; si no, la sesión queda incompleta.
  let sucursalId: string | null = null;
  if (args.sucursalId && sucs.some((s) => s.id === args.sucursalId)) {
    sucursalId = args.sucursalId;
  } else if (sucs.length === 1) {
    sucursalId = sucs[0]!.id;
  }

  const sesion = await abrirSesion(node, {
    usuarioId: c.id,
    sucursalId,
    cajaId: args.cajaId ?? null,
    ahora: () => ahora,
  });
  await registrarIntento(node, email, true, ip, ahora);

  return {
    ok: true,
    token: sesion.id,
    usuarioId: c.id,
    rol: c.rol,
    debeCambiar: c.debe_cambiar,
    sucursales: sucs,
    sesionCompleta: sesion.sucursalId !== null,
  };
}
