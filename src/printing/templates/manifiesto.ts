/**
 * Plantilla del manifiesto de abordaje (F5).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
 *                  docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D11)
 *                  docs/architecture/06-lugar-paso-paqueteria.md §1.1 (L8, L9)
 *
 * "Lista única por pasajero" (D11): un renglón por boleto con casilla, asiento,
 * nombre y "baja en". Las dos copias (`conductor` / `terminal`) llevan el MISMO
 * contenido; `copia` solo cambia el encabezado y la línea de firma.
 *
 * 0081 (L8/L9) — manifiesto POR TERMINAL y COMPACTO:
 *   * fuente B (≈ 4/3 de columnas: 64 en vez de 48 a 80 mm);
 *   * "sube en" ya no se repite: es la terminal que imprime. Solo aparece si el
 *     pasajero sube en otro punto que cubre esta terminal (parada sin sistema);
 *   * lugar de paso: `aborda: X` + `cobrar $Y` cuando lo cobra el conductor.
 *
 * 0088 (P12) — segunda sección PAQUETES: los envíos que la unidad se lleva de
 * esta terminal. Solo folio, descripción, monto (POR COBRAR si aplica) y
 * destino; sin QR ni numeración (esa va en los tickets de los bultos).
 * Un jsonb viejo (sin `terminal`) se imprime como antes: con "sube en" siempre.
 *
 * Recibe el jsonb CONGELADO que produce `core.datos_manifiesto` (ver
 * `src/fleet/manifiesto.ts`). No hace E/S ni conoce el transporte: eso permite
 * probar la maqueta completa contra `npm run printer:fake` sin la impresora
 * enfrente. El spooler que consume `core.print_job` la invoca por `template_key`
 * (`manifiesto_conductor` / `manifiesto_terminal`).
 */

import { EscPosDocument } from '../escpos/document.js';
import type { CodePageName } from '../escpos/codepage.js';

export type CopiaManifiesto = 'conductor' | 'terminal';

export interface ManifiestoParada {
  orden: number;
  /** Nombre del `core.punto_ruta` (terminal o parada). */
  punto: string;
  /** `'terminal'` | `'parada'`. */
  tipo: string;
  /** `hora_paso_programada` tal como quedó en el jsonb (ISO con zona); NULL en las paradas de solo descenso. */
  hora_paso: string | null;
}

export interface ManifiestoPasajero {
  folio: string;
  asiento: number;
  nombre: string;
  /** Punto de ascenso (`lower(tramos)`). */
  sube_en: string;
  sube_en_orden: number;
  /** Parada / terminal de descenso (`upper(tramos)`). */
  baja_en: string;
  baja_en_orden: number;
  estatus_pago: 'pagado' | 'pendiente';
  conflicto: boolean;
  /** 0081: lugar de paso en texto libre (0079). */
  lugar_abordaje?: string;
  /** 0081: lo que cobra el conductor al abordar (método `conductor`, 0079). */
  cobrar?: number;
}

/**
 * La forma del jsonb de `core.datos_manifiesto`. Las claves van en `snake_case`
 * a propósito: es el blob congelado, se pasa tal cual sale de la base sin mapear.
 * `jsonb_strip_nulls` en la función SQL quita las claves nulas.
 */
export interface DatosManifiesto {
  salida_id: string;
  copia: CopiaManifiesto;
  /** `YYYY-MM-DD`. */
  fecha_operacion: string;
  estado_salida: string;
  conductor?: string | null;
  unidad?: string | null;
  tipo_unidad: string;
  /** Momento del snapshot (ISO con zona). Las ventas posteriores no salen aquí. */
  generado_en: string;
  /** 0081: terminal cuyo manifiesto es. Ausente = lista completa (jsonb viejo). */
  terminal?: string;
  terminal_orden?: number;
  paradas: ManifiestoParada[];
  /** Lista única, ordenada por punto de ascenso y luego asiento. */
  pasajeros: ManifiestoPasajero[];
  /** 0088: paquetes que se cargan aquí. Ausente en un jsonb viejo. */
  paquetes?: ManifiestoPaquete[];
}

export interface ManifiestoPaquete {
  folio: string;
  descripcion: string;
  monto: number;
  /** Lo que se cobra en destino (solo por cobrar). */
  por_cobrar?: number;
  destino: string;
}

export interface ConfigManifiesto {
  /** Columnas de la impresora en fuente A (`config_impresora.ancho_cols`). */
  cols?: number;
  codePage?: CodePageName;
}

/**
 * `HH:mm` de un timestamp ISO, sin aritmética de zona: se imprime tal como quedó
 * congelado. P12 (zona horaria de las 4 sucursales) sigue abierta; cuando se
 * cierre, la conversión se hace al generar el jsonb, no aquí.
 */
const hhmm = (iso: string | null | undefined): string => {
  if (!iso) return '--:--';
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : iso;
};

const fechaHora = (iso: string): string => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
};

const etiqueta = (label: string, value: string): string => `${label.padEnd(10)} ${value}`;

const mxn = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Fuente B: ≈ 4/3 de las columnas de la fuente A (48 → 64 a 80 mm). */
export const colsFuenteB = (colsA: number): number => Math.floor((colsA * 4) / 3);

/**
 * Renderiza un manifiesto completo a bytes ESC/POS, listo para cualquier
 * transporte. Una llamada, una copia: el spooler encola un `print_job` por copia.
 */
export function renderManifiesto(m: DatosManifiesto, cfg: ConfigManifiesto = {}): Buffer {
  const doc = new EscPosDocument({
    cols: colsFuenteB(cfg.cols ?? 48),
    ...(cfg.codePage !== undefined ? { codePage: cfg.codePage } : {}),
  });
  doc.font('B');
  const esTerminal = m.copia === 'terminal';
  const anchoDestino = Math.min(20, Math.floor(doc.cols / 3));

  // `paradas` puede faltar si el jsonb lo generó un nodo en una migración
  // vieja (< 0072) — jsonb_strip_nulls borraba la clave entera.
  const paradas = m.paradas ?? [];
  const origen = paradas[0];
  const destino = paradas[paradas.length - 1];
  // 0081: con `terminal`, "sube en" se da por hecho salvo otro punto.
  const porTerminal = m.terminal_orden !== undefined;
  const mia = porTerminal ? paradas.find((p) => p.orden === m.terminal_orden) : origen;

  // ---- Encabezado --------------------------------------------------------
  doc.align('center').bold(true);
  doc.line('MANIFIESTO DE ABORDAJE');
  doc.line(`COPIA ${m.copia.toUpperCase()}${m.terminal ? ` - ${m.terminal.toUpperCase()}` : ''}`);
  doc.bold(false).align('left').divider();

  if (origen && destino) {
    doc.line(etiqueta('Ruta:', `${origen.punto} -> ${destino.punto}`));
    const pasaPor = mia && mia.orden !== origen.orden
      ? `  (pasa por ${mia.punto} ${hhmm(mia.hora_paso)})`
      : '';
    doc.line(etiqueta('Salida:', `${hhmm(origen.hora_paso)}${pasaPor}`));
  }
  const unidad = m.unidad ? `${m.unidad} (${m.tipo_unidad})` : m.tipo_unidad;
  doc.line(etiqueta('Fecha op.:', `${m.fecha_operacion}   Unidad: ${unidad}`));
  doc.line(etiqueta('Conductor:', m.conductor ?? 'sin asignar'));
  doc.line(etiqueta('Generado:', fechaHora(m.generado_en)));
  if (m.estado_salida !== 'programada') {
    doc.bold(true).line(etiqueta('Estado:', m.estado_salida.toUpperCase())).bold(false);
  }
  doc.divider();

  // ---- Cuerpo: lista única por pasajero --------------------------------
  let total = 0;
  let conflictos = 0;
  let pendientes = 0;
  let porCobrar = 0;
  let pasajerosPorCobrar = 0;

  if (m.pasajeros.length === 0) {
    doc.line('(sin pasajeros que aborden aqui)');
  }

  for (const p of m.pasajeros) {
    total += 1;
    const asiento = String(p.asiento).padStart(2, '0');
    const baja = p.baja_en.length > anchoDestino ? p.baja_en.slice(0, anchoDestino) : p.baja_en;
    // twoCol trunca la ETIQUETA (casilla + asiento + nombre) y conserva el
    // VALOR: el punto de descenso nunca se pierde, el nombre se recorta.
    doc.twoCol(`[ ] ${asiento} ${p.nombre}`, `baja: ${baja}`);

    if (p.lugar_abordaje) {
      const cobro = p.cobrar != null ? ` - COBRAR ${mxn(p.cobrar)}` : '';
      doc.bold(true).line(`       aborda: ${p.lugar_abordaje}${cobro}`).bold(false);
      if (p.cobrar != null) {
        porCobrar += p.cobrar;
        pasajerosPorCobrar += 1;
      }
    } else if (!porTerminal || p.sube_en_orden !== m.terminal_orden) {
      doc.line(`       sube: ${p.sube_en}`);
    }

    if (p.estatus_pago === 'pendiente') {
      pendientes += 1;
      doc.bold(true).line('       ** PAGO PENDIENTE **').bold(false);
    }
    if (p.conflicto) {
      conflictos += 1;
      doc.bold(true).line('    !! CONFLICTO DE SOBREVENTA - VERIFICAR').bold(false);
    }
  }

  // ---- Pie de pasajeros -------------------------------------------------
  doc.divider();
  doc.bold(true).line(`TOTAL PASAJEROS: ${total}`).bold(false);
  if (pasajerosPorCobrar > 0) {
    doc.bold(true)
      .line(`COBRA EL CONDUCTOR: ${mxn(porCobrar)} (${pasajerosPorCobrar} pasajero${pasajerosPorCobrar === 1 ? '' : 's'})`)
      .bold(false);
  }
  if (pendientes > 0) {
    doc.bold(true).line(`PENDIENTES DE PAGO: ${pendientes}`).bold(false);
  }
  if (conflictos > 0) {
    doc.bold(true).line(`BOLETOS EN CONFLICTO: ${conflictos}`).bold(false);
  }

  // ---- Segunda sección: paquetes (0088) ----------------------------------
  const paquetes = m.paquetes ?? [];
  if (paquetes.length > 0) {
    let porCobrarPaq = 0;
    doc.divider('=');
    doc.align('center').bold(true).line('PAQUETES').bold(false).align('left');
    doc.divider();
    for (const q of paquetes) {
      const monto = q.por_cobrar != null ? `POR COBRAR ${mxn(q.por_cobrar)}` : mxn(Number(q.monto));
      doc.twoCol(`[ ] ${q.folio} ${q.descripcion}`, monto);
      doc.line(`       destino: ${q.destino}`);
      if (q.por_cobrar != null) porCobrarPaq += Number(q.por_cobrar);
    }
    doc.divider();
    doc.bold(true).line(`TOTAL PAQUETES: ${paquetes.length}`).bold(false);
    if (porCobrarPaq > 0) {
      doc.bold(true).line(`POR COBRAR EN DESTINO: ${mxn(porCobrarPaq)}`).bold(false);
    }
  }

  doc.feed(2);
  const firma = esTerminal ? 'Responsable de terminal:' : 'Firma del conductor:';
  doc.line(firma);
  doc.line('_'.repeat(Math.min(doc.cols, 32)));

  // Ver nota en boleto.ts: `feed(1)` (antes `feed(3)`) deja ≈4mm de holgura
  // para la cuchilla física — a validar contra la Enduro real.
  doc.font('A').feed(1).cut();
  return doc.build();
}
