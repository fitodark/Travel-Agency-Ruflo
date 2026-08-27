/**
 * Flota: materialización de salidas, reparto de cupos y cambio de conductor.
 *
 * Blueprint v0.2 · docs/architecture/02-modelo-datos.md §5, §6
 */

export { materializarHorario, materializarVigentes } from './materializar.js';
export type { ResultadoMaterializacion, ResumenMaterializacion } from './materializar.js';

export { repartirCupo, cupoDeSalida } from './cupo.js';
export type { CupoSucursal } from './cupo.js';
