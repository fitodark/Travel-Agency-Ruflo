/**
 * Plantilla del manifiesto de abordaje (F5).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
 *
 * DOS copias del mismo viaje, agrupadas por parada de ascenso:
 *   - `conductor` — lista para palomear al subir la gente, SIN importes ni saldo.
 *   - `terminal`  — la de origen: importes, saldo pendiente, boletos en conflicto
 *     marcados y ocupación por tramo.
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
  sucursal: string;
  /** `hora_paso_programada` tal como quedó en el jsonb (ISO con zona). */
  hora_paso: string;
}

export interface ManifiestoPasajero {
  folio: string;
  asiento: number;
  nombre: string;
  /** Orden de la parada donde baja. */
  destino_orden: number;
  destino: string;
  conflicto: boolean;
  /** Solo en la copia `terminal`. */
  importe?: number;
  /** Solo en la copia `terminal`, y solo si hay saldo. */
  saldo_pendiente?: number;
}

export interface ManifiestoAscenso {
  parada_orden: number;
  sucursal: string;
  pasajeros: ManifiestoPasajero[];
}

export interface ManifiestoOcupacionTramo {
  /** `[0,1)`, `[1,2)`, … */
  tramo: string;
  vendidos: number;
}

/**
 * La forma del jsonb de `core.datos_manifiesto`. Las claves van en `snake_case`
 * a propósito: es el blob congelado, se pasa tal cual sale de la base sin mapear.
 * `jsonb_strip_nulls` en la función SQL quita `conductor`/`unidad` si son nulos y
 * `ocupacion_por_tramo` en la copia del conductor.
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
  ascensos: ManifiestoAscenso[];
  ocupacion_por_tramo?: ManifiestoOcupacionTramo[];
}

export interface ConfigManifiesto {
  cols?: number;
  codePage?: CodePageName;
}

const money = (n: number): string =>
  n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * `HH:mm` de un timestamp ISO, sin aritmética de zona: se imprime tal como quedó
 * congelado. P12 (zona horaria de las 4 sucursales) sigue abierta; cuando se
 * cierre, la conversión se hace al generar el jsonb, no aquí.
 */
const hhmm = (iso: string): string => {
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
  const anchoDestino = Math.min(18, Math.floor(doc.cols / 2));

  // ---- Encabezado ---------------------------------------------------------
  const origen = m.paradas[0];
  const destino = m.paradas[m.paradas.length - 1];

  doc.align('center').bold(true);
  doc.line('MANIFIESTO DE ABORDAJE');
  doc.line(`COPIA ${m.copia.toUpperCase()}`);
  doc.bold(false).align('left').divider();

  if (origen && destino) {
    doc.line(etiqueta('Ruta:', `${origen.sucursal} -> ${destino.sucursal}`));
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

  // ---- Cuerpo: pasajeros por parada de ascenso ---------------------------
  let total = 0;
  let conflictos = 0;

  for (const asc of m.ascensos) {
    doc.bold(true).line(`ASCENSO ${asc.parada_orden} - ${asc.sucursal}`).bold(false);

    if (asc.pasajeros.length === 0) {
      doc.line('    (sin pasajeros en esta parada)');
      doc.feed(1);
      continue;
    }

    for (const p of asc.pasajeros) {
      total += 1;
      const asiento = String(p.asiento).padStart(2, '0');
      const dest = p.destino.length > anchoDestino ? p.destino.slice(0, anchoDestino) : p.destino;
      // twoCol trunca la ETIQUETA (marca + asiento + nombre) y conserva el
      // VALOR: el destino nunca se pierde, el nombre se recorta si no cabe.
      doc.twoCol(`[ ] ${asiento}  ${p.nombre}`, dest);

      if (esTerminal) {
        const partes = [`$${money(p.importe ?? 0)}`];
        if (p.saldo_pendiente && p.saldo_pendiente > 0) {
          partes.push(`SALDO $${money(p.saldo_pendiente)}`);
        }
        doc.line(`       ${partes.join('   ')}`);
      }

      if (p.conflicto) {
        conflictos += 1;
        doc.bold(true).line('    !! CONFLICTO DE SOBREVENTA - VERIFICAR').bold(false);
      }
    }
    doc.feed(1);
  }

  // ---- Pie: totales, ocupación, firma -----------------------------------
  doc.divider();
  doc.bold(true).line(`TOTAL PASAJEROS: ${total}`).bold(false);
  if (conflictos > 0) {
    doc.bold(true).line(`BOLETOS EN CONFLICTO: ${conflictos}`).bold(false);
  }

  if (esTerminal && m.ocupacion_por_tramo && m.ocupacion_por_tramo.length > 0) {
    doc.feed(1).line('OCUPACION POR TRAMO');
    for (const t of m.ocupacion_por_tramo) {
      doc.line(`  ${t.tramo}  ${t.vendidos}`);
    }
  }

  doc.feed(2);
  const firma = esTerminal ? 'Responsable de terminal:' : 'Firma del conductor:';
  doc.line(firma);
  doc.line('_'.repeat(Math.min(doc.cols, 32)));

  doc.feed(3).cut();
  return doc.build();
}
