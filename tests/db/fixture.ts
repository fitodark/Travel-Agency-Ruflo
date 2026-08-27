/**
 * Fixture mínima del dominio para pruebas contra PostgreSQL real.
 *
 * Construye la cadena mínima que exigen las claves foráneas:
 *   agencia → sucursal → ruta → horario → tipo_unidad → salida
 *
 * Todo corre dentro de una transacción que se revierte al final, así que las pruebas
 * no dejan basura en la base y pueden correr contra la misma instancia de desarrollo.
 */

import { Client } from 'pg';

export interface Fixture {
  agenciaId: string;
  sucursal1Id: string;
  sucursal2Id: string;
  usuarioId: string;
  rutaId: string;
  horarioId: string;
  tipoUnidadId: string;
  salidaId: string;
}

async function scalar(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await client.query<{ id: string }>(sql, params);
  return rows[0]!.id;
}

/** Crea la cadena mínima. Debe llamarse dentro de una transacción abierta. */
export async function seedFixture(client: Client): Promise<Fixture> {
  const agenciaId = await scalar(
    client,
    `INSERT INTO core.agencia (id, nombre) VALUES (core.uuid_v7(), 'Donaji Test') RETURNING id`,
  );

  const sucursal = (codigo: string, nombre: string): Promise<string> =>
    scalar(
      client,
      `INSERT INTO core.sucursal (id, agencia_id, nombre, direccion_completa, telefono_principal, codigo)
       VALUES (core.uuid_v7(), $1, $2, 'Calle sin nombre 1', '953 000 0000', $3) RETURNING id`,
      [agenciaId, nombre, codigo],
    );

  // `codigo` es char(1) a propósito: es el prefijo que particiona el espacio de folios
  // entre sucursales para que dos terminales offline no generen el mismo folio.
  // Alfabeto sin caracteres ambiguos (sin I, L, O, U) -> hasta 32 sucursales.
  const sucursal1Id = await sucursal('A', 'Terminal Origen');
  const sucursal2Id = await sucursal('B', 'Terminal Intermedia');

  const usuarioId = await scalar(
    client,
    `INSERT INTO core.usuario (id, nombre, email, rol)
     VALUES (core.uuid_v7(), 'Vendedor de prueba', 'vendedor@test.local', 'vendedor') RETURNING id`,
  );

  const rutaId = await scalar(
    client,
    `INSERT INTO core.ruta (id, nombre, sucursal_origen_id, sucursal_destino_id)
     VALUES (core.uuid_v7(), 'S1 - S4', $1, $2) RETURNING id`,
    [sucursal1Id, sucursal2Id],
  );

  const horarioId = await scalar(
    client,
    `INSERT INTO core.horario (id, ruta_id, hora_salida, dias_semana)
     VALUES (core.uuid_v7(), $1, '07:00', ARRAY[1,2,3,4,5,6,7]) RETURNING id`,
    [rutaId],
  );

  const tipoUnidadId = await scalar(
    client,
    `SELECT id FROM core.tipo_unidad ORDER BY creado_en LIMIT 1`,
  );

  const salidaId = await scalar(
    client,
    `INSERT INTO core.salida (id, horario_id, fecha_operacion, tipo_unidad_id, mapa_snapshot)
     SELECT core.uuid_v7(), $1, current_date + 7, id, mapa FROM core.tipo_unidad WHERE id = $2
     RETURNING id`,
    [horarioId, tipoUnidadId],
  );

  return { agenciaId, sucursal1Id, sucursal2Id, usuarioId, rutaId, horarioId, tipoUnidadId, salidaId };
}

export interface OcuparArgs {
  fx: Fixture;
  salidaId?: string;
  asiento: number;
  /** Rango de tramos, p. ej. `[0,3)`. */
  tramos: string;
  sucursalId: string;
  estado?: string;
}

let folioSeq = 0;

/**
 * Vende un asiento: crea venta + boleto + ocupación, que es la cadena real.
 *
 * La ocupación NO se puede fabricar suelta: `boleto_id` tiene clave foránea contra
 * `core.boleto`, y eso es correcto — una ocupación sin boleto sería un asiento bloqueado
 * sin dueño, exactamente el estado que la auditoría del administrador no podría explicar.
 */
export async function ocupar(client: Client, a: OcuparArgs): Promise<void> {
  const salidaId = a.salidaId ?? a.fx.salidaId;

  const ventaId = await scalar(
    client,
    `INSERT INTO core.venta
       (id, sucursal_venta_id, usuario_id, contacto_telefono, salida_id,
        parada_origen_orden, parada_destino_orden, importe_total)
     VALUES (core.uuid_v7(), $1, $2, '953 000 0000', $3, 0, 3, 450) RETURNING id`,
    [a.sucursalId, a.fx.usuarioId, salidaId],
  );

  // Folio determinista para las pruebas: el generador real vive en core.siguiente_folio()
  // y se prueba por separado (colisiones entre sucursales offline).
  const folio = `T${String(folioSeq++).padStart(5, '0')}`;

  const boletoId = await scalar(
    client,
    `INSERT INTO core.boleto
       (id, venta_id, folio, salida_id, asiento_num, tramos, pasajero_nombre, importe)
     VALUES (core.uuid_v7(), $1, $2, $3, $4, $5::int4range, 'Pasajero de prueba', 450)
     RETURNING id`,
    [ventaId, folio, salidaId, a.asiento, a.tramos],
  );

  await client.query(
    `INSERT INTO core.asiento_ocupacion
       (id, salida_id, asiento_num, tramos, boleto_id, estado, sucursal_id, emitido_en)
     VALUES (core.uuid_v7(), $1, $2, $3::int4range, $4, $5, $6, now())`,
    [salidaId, a.asiento, a.tramos, boletoId, a.estado ?? 'firme', a.sucursalId],
  );
}
