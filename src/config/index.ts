/**
 * Aplicador de configuración de la terminal.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §3
 *
 * La configuración se propaga como un dato con fecha de vigencia, no como un
 * comando remoto. Este módulo es lo que materializa esa vigencia con el reloj
 * local del nodo.
 */

export { aplicarConfiguracion, ultimaPasadaAplicador } from './aplicador.js';
export type { ResultadoAplicacion } from './aplicador.js';
export { epocaConfig } from './epoca.js';
