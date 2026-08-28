/**
 * Clases de propiedad de entidad.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §1 y §4
 *
 * > La sincronización no resuelve conflictos: los elimina por construcción.
 *
 * Tres de las cuatro clases NO PUEDEN generar conflicto jamás, y esa es toda la idea del
 * diseño: al reducir el problema real a una sola tabla —la capacidad de asientos— se
 * puede permitir el aparato pesado (cupos, leases, restricciones de exclusión, cola de
 * excepciones) que sería insostenible aplicado a treinta tablas.
 *
 * Esta clasificación vivía únicamente en el documento. Aquí se vuelve dato ejecutable,
 * para que la reconciliación y el diagnóstico sepan qué esperar de cada tabla en vez de
 * tratarlas todas igual.
 */

export type ClaseEntidad = 'A' | 'B' | 'C' | 'D';

export interface DefinicionClase {
  clase: ClaseEntidad;
  nombre: string;
  direccion: string;
  /** Quién puede escribir la fila. */
  escritores: string;
  /** Qué hacer cuando dos versiones compiten. */
  resolucion: string;
}

export const CLASES: Record<ClaseEntidad, DefinicionClase> = {
  A: {
    clase: 'A',
    nombre: 'Configuración',
    direccion: 'nube → sucursal',
    escritores: 'solo la nube (administrador)',
    resolucion: 'la nube gana siempre; el nodo nunca escribe estas tablas',
  },
  B: {
    clase: 'B',
    nombre: 'Transaccional local',
    direccion: 'sucursal → nube',
    escritores: 'solo la sucursal creadora',
    resolucion: 'el origen gana siempre; un conflicto aquí es un bug y se alerta como tal',
  },
  C: {
    clase: 'C',
    nombre: 'Hechos append-only',
    direccion: 'cualquier sucursal → nube → todas',
    escritores: 'cualquiera, solo INSERT',
    resolucion: 'unión conmutativa, deduplicada por id; converge sin arbitraje',
  },
  D: {
    clase: 'D',
    nombre: 'Capacidad compartida',
    direccion: 'bidireccional arbitrada',
    escritores: 'múltiples',
    resolucion: 'cupos disjuntos + lease + arbitraje determinista; el único caso real',
  },
};

/**
 * Tabla → clase. Fuente única de verdad para el resto del motor.
 *
 * Se enumera a propósito en vez de derivarse del catálogo: la clase de una entidad es una
 * decisión de diseño sobre quién es su dueño, no una propiedad de su estructura. Dos
 * tablas con columnas idénticas pueden pertenecer a clases distintas, y una tabla nueva
 * debe obligar a alguien a decidir conscientemente en cuál cae.
 */
export const CLASE_POR_TABLA: Readonly<Record<string, ClaseEntidad>> = {
  // A — Configuración. Coincide con la lista de `sync.publicar_a_nodos`.
  'core.agencia': 'A',
  'core.sucursal': 'A',
  'core.usuario': 'A',
  'core.usuario_sucursal': 'A',
  'core.tipo_unidad': 'A',
  'core.unidad': 'A',
  'core.conductor': 'A',
  'core.ruta': 'A',
  'core.ruta_parada': 'A',
  'core.horario': 'A',
  'core.horario_parada': 'A',
  'core.tarifa': 'A',
  'core.salida': 'A',
  'core.salida_parada': 'A',
  'core.config_impresora': 'A',
  'core.config_ticket': 'A',
  'core.parametro': 'A',
  // Añadidas por la migración 0012: el blueprint las declaraba clase A pero
  // `publicar_a_nodos` las había omitido, así que nunca bajaban a las terminales.
  'core.rol_permiso': 'A',
  // Añadida por 0034 (F2b slice 1): el hash de contraseña se calcula en la nube
  // y baja replicado (03 §1.2). Única tabla de `auth_local` que se sincroniza;
  // `sesion`, `intento` y `revocacion_hotp` son estado local del nodo.
  'auth_local.credencial': 'A',

  // B — Transaccional local. Single-writer: la sucursal que la creó.
  'core.corte_caja': 'B',
  'core.movimiento_caja': 'B',
  'core.venta': 'B',
  'core.boleto': 'B',
  'core.cliente': 'B',
  'core.print_job': 'B',

  // C — Hechos append-only. Nunca se actualizan; su unión converge sola.
  'core.pago': 'C',
  'core.evento_abordaje': 'C',
  'core.evento_salida': 'C',
  'core.nota_auditoria': 'C',
  'core.cambio_conductor': 'C',

  // D — Capacidad compartida. El único conflicto genuino del sistema.
  'core.asiento_ocupacion': 'D',
  'core.cupo_offline': 'D',
  'core.asiento_lease': 'D',
};

export function claseDe(tabla: string): ClaseEntidad | null {
  return CLASE_POR_TABLA[tabla] ?? null;
}

export function tablasDeClase(clase: ClaseEntidad): string[] {
  return Object.entries(CLASE_POR_TABLA)
    .filter(([, c]) => c === clase)
    .map(([tabla]) => tabla)
    .sort();
}

/**
 * ¿Un conflicto en esta tabla es esperable, o es un síntoma de bug?
 *
 * Distinción operativa, no académica. Un conflicto en clase D es el funcionamiento normal
 * del sistema y se arbitra. Un conflicto en clase B significa que dos escritores tocaron
 * una fila que por diseño tiene uno solo: eso no se arbitra, **se investiga**. Tratarlos
 * igual enterraría el bug bajo el ruido de los conflictos legítimos de asientos.
 */
export function conflictoEsEsperable(tabla: string): boolean {
  return claseDe(tabla) === 'D';
}

/**
 * ¿Qué tablas debe reconciliar el nodo contra la nube?
 *
 * Clases B y C: las que la sucursal produce y sube. No tiene sentido reconciliar clase A
 * —el nodo es una copia, no un origen— y la clase D tiene su propio mecanismo de
 * arbitraje, más fuerte que un checksum.
 */
export function tablasReconciliables(): string[] {
  return [...tablasDeClase('B'), ...tablasDeClase('C')].sort();
}
