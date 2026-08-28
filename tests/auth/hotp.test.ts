/**
 * HOTP de revocación (RFC 4226 ligado a usuario + contador). Sin base.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.5
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generarCodigo, normalizarCodigo, verificarCodigo } from '../../src/auth/hotp.js';

const SEMILLA = Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex'); // 20 bytes
const USUARIO = '11111111-2222-3333-4444-555555555555';

describe('hotp de revocación', () => {
  it('genera un código de 8 dígitos, determinista', () => {
    const a = generarCodigo(SEMILLA, USUARIO, 3);
    expect(a).toMatch(/^\d{8}$/);
    expect(generarCodigo(SEMILLA, USUARIO, 3)).toBe(a);
  });

  it('el código cambia con el contador y con el usuario', () => {
    expect(generarCodigo(SEMILLA, USUARIO, 3)).not.toBe(generarCodigo(SEMILLA, USUARIO, 4));
    expect(generarCodigo(SEMILLA, USUARIO, 3)).not.toBe(
      generarCodigo(SEMILLA, '99999999-2222-3333-4444-555555555555', 3),
    );
  });

  it('verificarCodigo encuentra el contador dentro de la ventana', () => {
    const codigo = generarCodigo(SEMILLA, USUARIO, 12);
    expect(verificarCodigo(SEMILLA, USUARIO, codigo, { desde: 5, ventana: 20 })).toBe(12);
    expect(verificarCodigo(SEMILLA, USUARIO, codigo, { desde: 5, ventana: 3 })).toBeNull();
    expect(verificarCodigo(SEMILLA, USUARIO, codigo, { desde: 13, ventana: 20 })).toBeNull();
  });

  it('rechaza semilla o usuario equivocados', () => {
    const codigo = generarCodigo(SEMILLA, USUARIO, 7);
    expect(verificarCodigo(randomBytes(20), USUARIO, codigo, { desde: 0, ventana: 20 })).toBeNull();
    expect(verificarCodigo(SEMILLA, 'otro-usuario', codigo, { desde: 0, ventana: 20 })).toBeNull();
  });

  it('acepta el código con separadores como lo captura el gerente', () => {
    const codigo = generarCodigo(SEMILLA, USUARIO, 2);
    const conEspacios = `${codigo.slice(0, 4)} ${codigo.slice(4)}`;
    expect(normalizarCodigo(conEspacios)).toBe(codigo);
    expect(verificarCodigo(SEMILLA, USUARIO, conEspacios, { desde: 0, ventana: 10 })).toBe(2);
  });

  it('rechaza algo que no son 8 dígitos', () => {
    expect(verificarCodigo(SEMILLA, USUARIO, '123', { desde: 0, ventana: 10 })).toBeNull();
    expect(verificarCodigo(SEMILLA, USUARIO, 'abcdefgh', { desde: 0, ventana: 10 })).toBeNull();
  });
});
