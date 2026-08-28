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
