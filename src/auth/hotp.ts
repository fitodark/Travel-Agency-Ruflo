/**
 * Código de revocación fuera de banda — HOTP ligado a `(usuario, contador)`.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5 (capa 3)
 *
 * No es TOTP (no depende de relojes sincronizados, que es justo lo que falla en
 * el escenario). Es HOTP (RFC 4226): `code = truncate(HMAC-SHA1(semilla, msg))`,
 * donde `msg` liga el código a un usuario y a un contador monótono por sucursal.
 * El contador evita que un código viejo sirva dos veces y permite revocar al
 * mismo usuario más de una vez.
 *
 * El verificador barre una VENTANA de contadores hacia adelante: el código lo
 * dicta el administrador por teléfono, más rápido de lo que el contador baja por
 * sync, así que el nodo puede estar varios pasos por detrás.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Dígitos del código. 8 es lo que pide §1.5. */
const DIGITOS = 8;
const MODULO = 10 ** DIGITOS;

const mensaje = (usuarioId: string, contador: number): Buffer =>
  Buffer.from(`${usuarioId}:${contador}`, 'utf8');

/** El código de 8 dígitos (con ceros a la izquierda) para `(usuario, contador)`. */
export function generarCodigo(semilla: Buffer, usuarioId: string, contador: number): string {
  const d = createHmac('sha1', semilla).update(mensaje(usuarioId, contador)).digest();
  // Truncación dinámica RFC 4226 §5.3.
  const off = d[d.length - 1]! & 0x0f;
  const bin =
    ((d[off]! & 0x7f) << 24) | (d[off + 1]! << 16) | (d[off + 2]! << 8) | d[off + 3]!;
  return String(bin % MODULO).padStart(DIGITOS, '0');
}

/** Quita separadores: el gerente lo captura como lo oye ("1234 5678", "1234-5678"). */
export const normalizarCodigo = (crudo: string): string => crudo.replace(/\D/g, '');

const igual = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Busca el contador (en `[desde, desde+ventana)`) cuyo código coincide con el
 * dado. Devuelve ese contador, o `null` si ninguno coincide.
 */
export function verificarCodigo(
  semilla: Buffer,
  usuarioId: string,
  codigo: string,
  args: { desde: number; ventana: number },
): number | null {
  const objetivo = normalizarCodigo(codigo);
  if (objetivo.length !== DIGITOS) return null;
  for (let c = args.desde; c < args.desde + args.ventana; c += 1) {
    if (igual(generarCodigo(semilla, usuarioId, c), objetivo)) return c;
  }
  return null;
}
