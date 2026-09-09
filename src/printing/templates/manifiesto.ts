/**
 * Plantilla del manifiesto de abordaje (F5).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
 *                  docs/architecture/05-paradas-autorizadas-tarifas.md §2 (D11)
 *
 * "Lista única por pasajero" (D11): un solo renglón por boleto con nombre,
 * asiento, "sube en", "baja en" y estatus de pago. SIN importe ni saldo (N-8),
 * sin hora para los descensos, sin ocupación por tramo. Las dos copias
 * (`conductor` / `terminal`) llevan el MISMO contenido; `copia` solo cambia el
 * encabezado y la línea de firma. El checador de cada terminal de ascenso
 * palomea a mano la casilla de sus pasajeros sobre el impreso.
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
}

/**
 * La forma del jsonb de `core.datos_manifiesto`. Las claves van en `snake_case`
 * a propósito: es el blob congelado, se pasa tal cual sale de la base sin mapear.
 * `jsonb_strip_nulls` en la función SQL quita `conductor`/`unidad` si son nulos.
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
  paradas: ManifiestoParada[];
  /** Lista única, ordenada por punto de ascenso y luego asiento. */
  pasajeros: ManifiestoPasajero[];
}

export interface ConfigManifiesto {
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

/**
 * Renderiza un manifiesto completo a bytes ESC/POS, listo para cualquier
 * transporte. Una llamada, una copia: el spooler encola un `print_job` por copia.
 */
export function renderManifiesto(m: DatosManifiesto, cfg: ConfigManifiesto = {}): Buffer {
  const doc = new EscPosDocument({
    ...(cfg.cols !== undefined ? { cols: cfg.cols } : {}),
    ...(cfg.codePage !== undefined ? { codePage: cfg.codePage } : {}),
  });
  const esTerminal = m.copia === 'terminal';
  const anchoDestino = Math.min(16, Math.floor(doc.cols / 2));

  // ---- Encabezado --------------------------------------------------------
  const origen = m.paradas[0];
  const destino = m.paradas[m.paradas.length - 1];

  doc.align('center').bold(true);
  doc.line('MANIFIESTO DE ABORDAJE');
  doc.line(`COPIA ${m.copia.toUpperCase()}`);
  doc.bold(false).align('left').divider();

  if (origen && destino) {
    doc.line(etiqueta('Ruta:', `${origen.punto} -> ${destino.punto}`));
    doc.line(etiqueta('Salida:', hhmm(origen.hora_paso)));
  }
  doc.line(etiqueta('Fecha op.:', m.fecha_operacion));
  const unidad = m.unidad ? `${m.unidad} (${m.tipo_unidad})` : m.tipo_unidad;
  doc.line(etiqueta('Unidad:', unidad));
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

  if (m.pasajeros.length === 0) {
    doc.line('(sin pasajeros en esta salida)');
  }

  for (const p of m.pasajeros) {
    total += 1;
    const asiento = String(p.asiento).padStart(2, '0');
    const baja = p.baja_en.length > anchoDestino ? p.baja_en.slice(0, anchoDestino) : p.baja_en;
    // twoCol trunca la ETIQUETA (casilla + asiento + nombre) y conserva el
    // VALOR: el punto de descenso nunca se pierde, el nombre se recorta.
    doc.twoCol(`[ ] ${asiento} ${p.nombre}`, baja);
    doc.line(`       sube: ${p.sube_en}`);

    if (p.estatus_pago === 'pendiente') {
      pendientes += 1;
      doc.bold(true).line('       ** PAGO PENDIENTE **').bold(false);
    }
    if (p.conflicto) {
      conflictos += 1;
      doc.bold(true).line('    !! CONFLICTO DE SOBREVENTA - VERIFICAR').bold(false);
    }
  }

  // ---- Pie: totales, firma ---------------------------------------------
  doc.divider();
  doc.bold(true).line(`TOTAL PASAJEROS: ${total}`).bold(false);
  if (pendientes > 0) {
    doc.bold(true).line(`PENDIENTES DE PAGO: ${pendientes}`).bold(false);
  }
  if (conflictos > 0) {
    doc.bold(true).line(`BOLETOS EN CONFLICTO: ${conflictos}`).bold(false);
  }

  doc.feed(2);
  const firma = esTerminal ? 'Responsable de terminal:' : 'Firma del conductor:';
  doc.line(firma);
  doc.line('_'.repeat(Math.min(doc.cols, 32)));

  doc.feed(3).cut();
  return doc.build();
}
