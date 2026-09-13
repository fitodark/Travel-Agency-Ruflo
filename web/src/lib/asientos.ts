/**
 * Formato del número de asiento para TODA la SPA: siempre 2 dígitos (`04`,
 * nunca `4`) porque así se pinta en el mapa de asientos y así va impreso en
 * el boleto físico — mostrarlo distinto en el resumen/confirmación confundía.
 */
export function formatoAsiento(num: number): string {
  return String(num).padStart(2, '0');
}
