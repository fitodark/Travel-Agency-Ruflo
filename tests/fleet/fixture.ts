/**
 * Fixture de flota: ruta con paradas, conductor Sprinter y horario.
 *
 * Todo dentro de una transacción revertida. Usa el `tipo_unidad` SPRINTER-18 que
 * ya viene sembrado (`src/db/seed/0001_...`).
 */

import type { Client } from 'pg';

export interface RutaFixture {
  agenciaId: string;
  /** Sucursales en orden de parada: [origen, intermedia, destino]. */
  sucursales: string[];
  rutaId: string;
  conductorId: string;
  conductorNombre: string;
  tipoUnidadId: string;
  horarioId: string;
}

let n = 0;
const COD = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

async function codigosLibres(client: Client, cuantos: number): Promise<string[]> {
  const { rows } = await client.query<{ c: string }>(
    `SELECT c FROM unnest(string_to_array($1, NULL)) c
      WHERE c NOT IN (SELECT codigo FROM core.sucursal) ORDER BY c LIMIT $2`,
    [COD, cuantos],
  );
  return rows.map((r) => r.c);
}

export interface SeedRutaOpts {
  /** Nº de paradas (>=2). Por defecto 3: origen, intermedia, destino. */
  paradas?: number;
  /** Días de la semana ISO (1=lun..7=dom). Por defecto todos. */
  diasSemana?: number[];
  horaSalida?: string;
  /** Horas de paso por parada. Por defecto se reparten desde `horaSalida`. */
  horasPaso?: string[];
  /** El horario arranca/termina en estas fechas. */
  vigenteDesde?: string | null;
  vigenteHasta?: string | null;
  /** No asignar conductor al horario (para probar el rechazo). */
  sinConductor?: boolean;
  /** El conductor usa un tipo_unidad distinto (para probar incompatibilidad, slice 3). */
  claveTipoUnidad?: string;
}

export async function seedRuta(client: Client, opts: SeedRutaOpts = {}): Promise<RutaFixture> {
  const paradas = opts.paradas ?? 3;
  const suf = `${Date.now().toString(36)}${n++}`;

  const { rows: ag } = await client.query<{ id: string }>(
    `INSERT INTO core.agencia (nombre) VALUES ('Donaji Flota Test') RETURNING id`,
  );
  const agenciaId = ag[0]!.id;

  const cods = await codigosLibres(client, paradas);
  const sucursales: string[] = [];
  for (let i = 0; i < paradas; i++) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.sucursal (agencia_id, nombre, direccion_completa, telefono_principal, codigo, zona_horaria)
       VALUES ($1, $2, 'Calle 1', '953 000 0000', $3, 'America/Mexico_City') RETURNING id`,
      [agenciaId, `Parada ${i} ${suf}`, cods[i]],
    );
    sucursales.push(rows[0]!.id);
  }

  const { rows: r } = await client.query<{ id: string }>(
    `INSERT INTO core.ruta (nombre, sucursal_origen_id, sucursal_destino_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Ruta ${suf}`, sucursales[0], sucursales[paradas - 1]],
  );
  const rutaId = r[0]!.id;

  const rutaParadaIds: string[] = [];
  for (let i = 0; i < paradas; i++) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.ruta_parada (ruta_id, sucursal_id, orden) VALUES ($1, $2, $3) RETURNING id`,
      [rutaId, sucursales[i], i],
    );
    rutaParadaIds.push(rows[0]!.id);
  }

  const { rows: tu } = await client.query<{ id: string }>(
    `SELECT id FROM core.tipo_unidad WHERE clave = $1`,
    [opts.claveTipoUnidad ?? 'SPRINTER-18'],
  );
  const tipoUnidadId = tu[0]!.id;

  const conductorNombre = `Conductor ${suf}`;
  const { rows: co } = await client.query<{ id: string }>(
    `INSERT INTO core.conductor (nombre, tipo_unidad_id) VALUES ($1, $2) RETURNING id`,
    [conductorNombre, tipoUnidadId],
  );
  const conductorId = co[0]!.id;

  const horaSalida = opts.horaSalida ?? '07:00';
  const { rows: h } = await client.query<{ id: string }>(
    `INSERT INTO core.horario (ruta_id, hora_salida, dias_semana, conductor_id,
                               vigente_desde, vigente_hasta)
     VALUES ($1, $2::time, $3::smallint[], $4, $5::date, $6::date) RETURNING id`,
    [
      rutaId, horaSalida,
      opts.diasSemana ?? [1, 2, 3, 4, 5, 6, 7],
      opts.sinConductor ? null : conductorId,
      opts.vigenteDesde ?? null,
      opts.vigenteHasta ?? null,
    ],
  );
  const horarioId = h[0]!.id;

  // Horas de paso: la de origen es `horaSalida`; las demás, +45 min por tramo.
  const base = Number(horaSalida.split(':')[0]) * 60 + Number(horaSalida.split(':')[1]);
  const horas = opts.horasPaso
    ?? Array.from({ length: paradas }, (_, i) => {
      const m = base + i * 45;
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    });
  for (let i = 0; i < paradas; i++) {
    await client.query(
      `INSERT INTO core.horario_parada (horario_id, ruta_parada_id, orden, hora_paso)
       VALUES ($1, $2, $3, $4::time)`,
      [horarioId, rutaParadaIds[i], i, horas[i]],
    );
  }

  return { agenciaId, sucursales, rutaId, conductorId, conductorNombre, tipoUnidadId, horarioId };
}
