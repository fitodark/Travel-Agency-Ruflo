/**
 * Hash y verificación de contraseñas — Argon2id.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.2
 *
 * El hash se calcula **en la nube** al crear o cambiar la contraseña y se
 * replica al nodo como cualquier dato de clase A. El nodo nunca ve la contraseña
 * en claro salvo en el instante del login, que valida **localmente y sin red**.
 *
 * Aislado en su propio archivo a propósito: es la única pieza con una dependencia
 * nativa, y así el resto del módulo se prueba sin ella.
 */

import { hash, verify } from '@node-rs/argon2';

// `@node-rs/argon2` expone `Algorithm` como `const enum`, que `verbatimModuleSyntax`
// no deja importar. El valor de Argon2id es 2 y es además el default de `hash()`;
// se pasa explícito para que quede escrito cuál es (requisito del blueprint §1.2).
const ARGON2ID = 2;

// Línea base OWASP 2024 para Argon2id. Verificar un hash existente no depende de
// estos valores —argon2 los lee del propio string codificado—; se usan solo al
// generar uno nuevo (rotación de contraseña, semillas de prueba).
const OPCIONES = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plano: string): Promise<string> {
  return hash(plano, OPCIONES);
}

/**
 * Verifica una contraseña contra un hash ya guardado.
 *
 * Un hash con formato inválido o de otro algoritmo NO es una excepción
 * operativa: cuenta como credencial incorrecta y no se distingue, para no
 * filtrar el estado de la cuenta.
 */
export async function verifyPassword(hashGuardado: string, plano: string): Promise<boolean> {
  try {
    return await verify(hashGuardado, plano);
  } catch {
    return false;
  }
}
