/**
 * Verificación de tokens de Supabase Auth para la consola de administración (F2b).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.1
 *
 * La autenticación de la OPERACIÓN es local y offline (`src/auth/`). Pero la
 * consola de administración vive EN LA NUBE, donde el internet es un
 * prerrequisito, así que ahí sí sirve Supabase Auth (GoTrue): el administrador
 * inicia sesión contra Supabase y su navegador manda el `access_token` (un JWT
 * HS256 firmado con el secreto del proyecto) en cada petición.
 *
 * Este módulo solo VERIFICA ese JWT — no habla con GoTrue. La verificación es
 * offline: HMAC-SHA256 contra `SUPABASE_JWT_SECRET`. Sin dependencias: el formato
 * es tres segmentos base64url y una firma.
 *
 * SUPUESTO: el proyecto usa el secreto JWT simétrico (HS256), que es el modo por
 * defecto histórico de Supabase y el que expone "Legacy JWT Secret". Si el
 * proyecto rota a claves asimétricas (ES256/RS256 + JWKS), este verificador hay
 * que cambiarlo por uno que traiga la clave pública del endpoint JWKS.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface IdentidadSupabase {
  /** `sub`: el id del usuario en `auth.users` de Supabase. */
  sub: string;
  email: string;
  /** Claim `role` del JWT (normalmente `authenticated`). */
  rol: string;
  /** `exp` en segundos epoch. */
  exp: number;
}

const b64urlEncode = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const firma = (entrada: string, secreto: string): string =>
  b64urlEncode(createHmac('sha256', secreto).update(entrada).digest());

export class TokenInvalido extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'TokenInvalido';
  }
}

/**
 * Verifica un JWT HS256 de Supabase y devuelve la identidad.
 *
 * Comprueba: algoritmo `HS256`, firma contra `secreto`, `exp` en el futuro, y
 * `aud = 'authenticated'` (lo que pone GoTrue para un usuario que inició sesión).
 * Lanza `TokenInvalido` en cualquier fallo — nunca devuelve una identidad a medias.
 */
export function verificarTokenSupabase(
  token: string,
  secreto: string,
  ahora: () => Date = () => new Date(),
): IdentidadSupabase {
  if (!secreto) throw new TokenInvalido('falta el secreto de verificación');

  const partes = token.split('.');
  if (partes.length !== 3) throw new TokenInvalido('formato de JWT inválido');
  const [h, p, s] = partes as [string, string, string];

  let header: { alg?: string; typ?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    throw new TokenInvalido('JWT ilegible');
  }

  if (header.alg !== 'HS256') throw new TokenInvalido(`algoritmo no admitido: ${header.alg}`);

  const esperada = Buffer.from(firma(`${h}.${p}`, secreto));
  const recibida = Buffer.from(s);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) {
    throw new TokenInvalido('firma inválida');
  }

  const exp = typeof payload['exp'] === 'number' ? payload['exp'] : 0;
  if (exp * 1000 <= ahora().getTime()) throw new TokenInvalido('token expirado');

  if (payload['aud'] !== 'authenticated') {
    throw new TokenInvalido(`audiencia inesperada: ${String(payload['aud'])}`);
  }

  const email = typeof payload['email'] === 'string' ? payload['email'].toLowerCase() : '';
  const sub = typeof payload['sub'] === 'string' ? payload['sub'] : '';
  if (!email || !sub) throw new TokenInvalido('el token no trae email o sub');

  return {
    sub,
    email,
    rol: typeof payload['role'] === 'string' ? payload['role'] : 'authenticated',
    exp,
  };
}

/**
 * Firma un JWT HS256 con la forma de uno de Supabase.
 *
 * NO se usa en producción — los tokens reales los emite GoTrue. Existe para las
 * pruebas y para el desarrollo local sin un proyecto Supabase enfrente
 * (`npm run admin` con un secreto de prueba).
 */
export function firmarTokenSupabase(
  claims: { sub: string; email: string; role?: string; ttlSegundos?: number },
  secreto: string,
  ahora: () => Date = () => new Date(),
): string {
  const iat = Math.floor(ahora().getTime() / 1000);
  const header = b64urlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64urlEncode(
    Buffer.from(
      JSON.stringify({
        sub: claims.sub,
        email: claims.email,
        role: claims.role ?? 'authenticated',
        aud: 'authenticated',
        iat,
        exp: iat + (claims.ttlSegundos ?? 3600),
      }),
    ),
  );
  return `${header}.${payload}.${firma(`${header}.${payload}`, secreto)}`;
}
