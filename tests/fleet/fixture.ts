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

/** Un usuario con el rol dado. Para probar el RBAC de `cambiar_conductor`. */
export async function crearUsuario(client: Client, rol: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO core.usuario (nombre, email, rol)
     VALUES ('U ' || $1, ('u' || floor(random()*1e9)::bigint || '@donaji.test')::citext, $1::text)
     RETURNING id`,
    [rol],
  );
  return rows[0]!.id;
}

/**
 * Crea un `tipo_unidad` con un conductor asociado. Por defecto, una unidad
 * chica de 6 plazas (dos bloques de 3), útil para provocar la incompatibilidad
 * de mapa del caso 2.
 */
export async function crearConductorTipo(
  client: Client,
  opts: { mapa?: object; numAsientos?: number; clave?: string } = {},
): Promise<{ conductorId: string; tipoUnidadId: string }> {
  const suf = `${Date.now().toString(36)}${n++}`;
  const mapa = opts.mapa ?? {
    version: 1, filas: 2, columnas: 3, pasillo_despues_columna: 1, frente: 'arriba',
    asientos: [1, 2, 3, 4, 5, 6].map((num) => ({
      num, fila: num <= 3 ? 0 : 1, col: (num - 1) % 3, tipo: 'ventana', vendible: true,
    })),
    bloques: [
      { clave: 'X0', etiqueta: 'fila 1', asientos: [1, 2, 3] },
      { clave: 'X1', etiqueta: 'fila 2', asientos: [4, 5, 6] },
    ],
  };
  const { rows: tu } = await client.query<{ id: string }>(
    `INSERT INTO core.tipo_unidad (clave, nombre, num_asientos, mapa)
     VALUES ($1, 'Unidad chica ' || $1, $2, $3::jsonb) RETURNING id`,
    [opts.clave ?? `MINI-${suf}`, opts.numAsientos ?? 6, JSON.stringify(mapa)],
  );
  const { rows: co } = await client.query<{ id: string }>(
    `INSERT INTO core.conductor (nombre, tipo_unidad_id) VALUES ($1, $2) RETURNING id`,
    [`Conductor mini ${suf}`, tu[0]!.id],
  );
  return { conductorId: co[0]!.id, tipoUnidadId: tu[0]!.id };
}

/** Vende un asiento en una salida: venta + boleto + ocupación firme. */
let folioSeq = 700_000;
export async function venderEn(
  client: Client,
  args: { salidaId: string; sucursalId: string; usuarioId: string; asiento: number; tramos?: string },
): Promise<string> {
  const tramos = args.tramos ?? '[0,1)';
  const { rows: v } = await client.query<{ id: string }>(
    `INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, contacto_telefono, salida_id,
                             parada_origen_orden, parada_destino_orden, importe_total)
     VALUES (core.uuid_v7(), $1, $2, '953 000 0000', $3, 0, 1, 450) RETURNING id`,
    [args.sucursalId, args.usuarioId, args.salidaId],
  );
  const folio = `T${String(folioSeq++).slice(-5)}`;
  const { rows: b } = await client.query<{ id: string }>(
    `INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, pasajero_nombre, importe)
     VALUES (core.uuid_v7(), $1, $2, $3, $4, $5::int4range, 'Pasajero', 450) RETURNING id`,
    [v[0]!.id, folio, args.salidaId, args.asiento, tramos],
  );
  await client.query(
    `INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, boleto_id, estado, sucursal_id, emitido_en)
     VALUES (core.uuid_v7(), $1, $2, $3::int4range, $4, 'firme', $5, now())`,
    [args.salidaId, args.asiento, tramos, b[0]!.id, args.sucursalId],
  );
  return b[0]!.id;
}
