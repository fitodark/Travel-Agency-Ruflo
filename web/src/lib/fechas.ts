/**
 * Formato de fecha y hora para TODA la SPA: 24 h, sin segundos, sin AM/PM.
 *
 * Se centraliza acá porque cada pantalla llamaba a `toLocaleString` a su manera
 * —a veces sin locale, a veces con uno que usa 12 h— y salía "1:00:00 p. m.".
 * El cliente pidió "13:00 hrs" en todas partes y nunca segundos.
 *
 * NO se hace aritmética de zona horaria: se muestra el instante tal como llega
 * (P12 sigue abierta). Lo único que cambia respecto de antes es el formato.
 */

const OPCIONES_HORA: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

/**
 * Hora del día en 24 h, sin segundos: `13:05` (nunca `1:05 p.m.`).
 * Acepta un ISO / `Date`, o un string de hora suelto (`H:MM`, `HH:MM`, `HH:MM:SS`).
 */
export function hora(valor: string | Date): string {
  if (typeof valor === 'string') {
    const m = /^(\d{1,2}):(\d{2})(:\d{2})?$/.exec(valor);
    if (m) return `${m[1]!.padStart(2, '0')}:${m[2]}`;
  }
  return new Date(valor).toLocaleTimeString('es-MX', OPCIONES_HORA);
}

/** Fecha sola (`d/m/aaaa`). `—` si no hay valor. */
export function fecha(valor: string | Date | null | undefined): string {
  if (valor == null || valor === '') return '—';
  return new Date(valor).toLocaleDateString('es-MX');
}

/** Fecha + hora en 24 h, sin segundos: `31/8/2026, 13:05`. `—` si no hay valor. */
export function fechaHora(valor: string | Date | null | undefined): string {
  if (valor == null || valor === '') return '—';
  const d = new Date(valor);
  return `${d.toLocaleDateString('es-MX')}, ${d.toLocaleTimeString('es-MX', OPCIONES_HORA)}`;
}
