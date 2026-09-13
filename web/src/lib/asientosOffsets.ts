/**
 * Desfase visual (px) de los asientos individuales del lado del pasillo —
 * criterio de QA, `knowledge/sprinter-mapv2/`. Se reduce fila con fila hasta
 * alinear en la fila de 11/12-13. Es puramente cosmético (por eso vive en el
 * frontend y no en `core.tipo_unidad.mapa`): la unidad real tiene esos
 * asientos ligeramente descuadrados entre sí, no es un error de captura.
 */
export const OFFSETS_ASIENTO: Record<number, number> = { 4: 18, 7: 12, 10: 6 };
