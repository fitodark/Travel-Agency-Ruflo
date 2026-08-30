/**
 * Captura de abordaje y estado del viaje (F7).
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §5
 *
 * El checklist se marca a mano y luego se captura. Corregir es un hecho nuevo
 * que anula el anterior, nunca un UPDATE. Marcar "en ruta" bloquea la venta
 * desde ese instante (lo respetan `registrar_venta` / `buscar_salidas` /
 * `adquirir_lease`).
 */

import type { Consultable } from '../db/consulta.js';

export async function registrarAbordaje(
  db: Consultable,
  args: {
    boletoId: string; abordo: boolean; usuarioId: string;
    sucursalId: string; ahora?: Date;
  },
): Promise<string> {
  const { rows } = await db.query<{ registrar_abordaje: string }>(
    `SELECT core.registrar_abordaje($1::uuid, $2::boolean, $3::uuid, $4::uuid, $5::timestamptz)`,
    [args.boletoId, args.abordo, args.usuarioId, args.sucursalId, args.ahora ?? new Date()],
  );
  return rows[0]!.registrar_abordaje;
}

export async function corregirAbordaje(
  db: Consultable,
  args: {
    eventoId: string; abordo: boolean; usuarioId: string;
    sucursalId: string; ahora?: Date;
  },
): Promise<string> {
  const { rows } = await db.query<{ corregir_abordaje: string }>(
    `SELECT core.corregir_abordaje($1::uuid, $2::boolean, $3::uuid, $4::uuid, $5::timestamptz)`,
    [args.eventoId, args.abordo, args.usuarioId, args.sucursalId, args.ahora ?? new Date()],
  );
  return rows[0]!.corregir_abordaje;
}

export interface EstadoViaje {
  salidaId: string;
  estado: string;
  salidaRealEn?: Date;
}

export async function marcarEnRuta(
  db: Consultable,
  args: { salidaId: string; usuarioId: string; conductorId?: string; ahora?: Date },
): Promise<EstadoViaje> {
  const { rows } = await db.query<{
    salida_id: string; estado: string; salida_real_en: Date;
  }>(
    `SELECT salida_id, estado, salida_real_en
       FROM core.marcar_en_ruta($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
    [args.salidaId, args.usuarioId, args.conductorId ?? null, args.ahora ?? new Date()],
  );
  const r = rows[0]!;
  return { salidaId: r.salida_id, estado: r.estado, salidaRealEn: r.salida_real_en };
}

export async function finalizarSalida(
  db: Consultable,
  args: { salidaId: string; usuarioId: string; ahora?: Date },
): Promise<EstadoViaje> {
  const { rows } = await db.query<{ salida_id: string; estado: string }>(
    `SELECT salida_id, estado FROM core.finalizar_salida($1::uuid, $2::uuid, $3::timestamptz)`,
    [args.salidaId, args.usuarioId, args.ahora ?? new Date()],
  );
  const r = rows[0]!;
  return { salidaId: r.salida_id, estado: r.estado };
}

export type EstadoAbordaje = 'abordo' | 'no_presento' | 'pendiente';

export interface FilaChecklist {
  boletoId: string;
  folio: string;
  asientoNum: number;
  pasajeroNombre: string;
  tramos: string;
  conflicto: boolean;
  estadoAbordaje: EstadoAbordaje;
  capturadoEn: Date | null;
}

export interface BoletoPorFolio extends FilaChecklist {
  salida: {
    salidaId: string;
    fechaOperacion: string;
    horaSalida: Date;
    origen: string;
    destino: string;
    estado: string;
    conductor: string | null;
  };
}

/**
 * Normaliza un folio tecleado a mano para buscarlo.
 *
 * El folio es un STRING de 6 caracteres (02b §1): `[código de sucursal][contador
 * base32 de 5]`, alfabeto `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — NO un consecutivo
 * numérico. El alfabeto excluye `I L O U` a propósito porque los folios se dictan
 * por teléfono; si el operador teclea uno de esos, se asume el símbolo real que
 * suena/parece igual (`O→0`, `I/L→1`). Un folio verdadero nunca los contiene, así
 * que el mapeo no puede llevar a otro folio.
 */
export function normalizarFolio(entrada: string): string {
  return entrada
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Busca un boleto por su folio (exacto tras normalizar) y devuelve su fila del
 * checklist más el contexto de la salida, para que el operador pueda capturar el
 * abordaje o saltar al viaje. El folio es UNIQUE global, así que no se filtra por
 * sucursal.
 */
export async function buscarBoletoPorFolio(
  db: Consultable, folioEntrada: string,
): Promise<BoletoPorFolio | null> {
  const folio = normalizarFolio(folioEntrada);
  if (folio.length !== 6) return null;

  const { rows } = await db.query<{
    boleto_id: string; folio: string; asiento_num: number; pasajero_nombre: string;
    tramos: string; conflicto: boolean; estado_abordaje: EstadoAbordaje;
    capturado_en: Date | null;
    salida_id: string; fecha_operacion: string; salida_estado: string;
    conductor: string | null; hora_salida: Date; origen: string; destino: string;
  }>(
    `SELECT c.boleto_id, c.folio, c.asiento_num, c.pasajero_nombre, c.tramos::text AS tramos,
            c.conflicto, c.estado_abordaje, c.capturado_en,
            s.id AS salida_id, s.fecha_operacion::text AS fecha_operacion,
            s.estado AS salida_estado, s.conductor_nombre_snapshot AS conductor,
            spo.hora_paso_programada AS hora_salida,
            suo.nombre AS origen, sud.nombre AS destino
       FROM core.v_checklist_abordaje c
       JOIN core.salida s ON s.id = c.salida_id
       JOIN core.salida_parada spo ON spo.salida_id = s.id AND spo.orden = 0
       JOIN core.sucursal suo ON suo.id = spo.sucursal_id
       JOIN core.salida_parada spd ON spd.salida_id = s.id
        AND spd.orden = (SELECT max(orden) FROM core.salida_parada WHERE salida_id = s.id)
       JOIN core.sucursal sud ON sud.id = spd.sucursal_id
      WHERE c.folio = $1`,
    [folio],
  );

  const r = rows[0];
  if (!r) return null;
  return {
    boletoId: r.boleto_id,
    folio: r.folio,
    asientoNum: Number(r.asiento_num),
    pasajeroNombre: r.pasajero_nombre,
    tramos: r.tramos,
    conflicto: r.conflicto,
    estadoAbordaje: r.estado_abordaje,
    capturadoEn: r.capturado_en,
    salida: {
      salidaId: r.salida_id,
      fechaOperacion: r.fecha_operacion,
      horaSalida: r.hora_salida,
      origen: r.origen,
      destino: r.destino,
      estado: r.salida_estado,
      conductor: r.conductor,
    },
  };
}

export async function checklistAbordaje(
  db: Consultable, salidaId: string,
): Promise<FilaChecklist[]> {
  const { rows } = await db.query<{
    boleto_id: string; folio: string; asiento_num: number; pasajero_nombre: string;
    tramos: string; conflicto: boolean; estado_abordaje: EstadoAbordaje;
    capturado_en: Date | null;
  }>(
    `SELECT boleto_id, folio, asiento_num, pasajero_nombre, tramos::text AS tramos,
            conflicto, estado_abordaje, capturado_en
       FROM core.v_checklist_abordaje
      WHERE salida_id = $1::uuid
      ORDER BY asiento_num`,
    [salidaId],
  );
  return rows.map((r) => ({
    boletoId: r.boleto_id,
    folio: r.folio,
    asientoNum: Number(r.asiento_num),
    pasajeroNombre: r.pasajero_nombre,
    tramos: r.tramos,
    conflicto: r.conflicto,
    estadoAbordaje: r.estado_abordaje,
    capturadoEn: r.capturado_en,
  }));
}
