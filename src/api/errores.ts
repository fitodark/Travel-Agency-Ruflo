/**
 * Errores HTTP del dominio. Un `throw` en cualquier handler con uno de estos se
 * traduce a la respuesta correcta; cualquier otro error es un 500 y se registra.
 */

export class ErrorHttp extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorHttp';
  }
}

export const noAutorizado = (m = 'Sesión ausente, inválida o expirada'): ErrorHttp =>
  new ErrorHttp(401, 'no_autorizado', m);

export const prohibido = (m = 'El rol no tiene permiso para esta acción'): ErrorHttp =>
  new ErrorHttp(403, 'prohibido', m);

export const noEncontrado = (m = 'El recurso no existe'): ErrorHttp =>
  new ErrorHttp(404, 'no_encontrado', m);

export const conflicto = (m: string): ErrorHttp =>
  new ErrorHttp(409, 'conflicto', m);

export const entradaInvalida = (m: string): ErrorHttp =>
  new ErrorHttp(400, 'entrada_invalida', m);
