/**
 * Fixture de ventas: una salida materializada, con su cupo repartido, lista para
 * probar la búsqueda del paso 2 y (más adelante) leases y venta.
 *
 * Se apoya en el fixture de flota (`seedRuta`) y en `materializarHorario`.
 * Todo dentro de una transacción revertida por el test.
 */

import type { Client } from 'pg';
import { materializarHorario } from '../../src/fleet/materializar.js';
import { seedRuta, type SeedRutaOpts } from '../fleet/fixture.js';
import { hashPrueba } from '../auth/fixture.js';

let seq = 0;

export interface SalidaFixture {
  salidaId: string;
  horarioId: string;
  /** Sucursales en orden de parada: [origen, ...intermedias, destino]. */
  sucursales: string[];
  /** Órdenes de parada, 0..n-1 (paralelo a `sucursales`). */
  ordenes: number[];
  tipoUnidadId: string;
  conductorNombre: string;
  fechaOperacion: string;
}

/**
 * Materializa un solo día del horario y devuelve esa salida.
 *
 * Por defecto materializa a 7 días vista para que el cierre de venta quede
 * cómodamente en el futuro y `new Date()` sirva de reloj en las pruebas.
 */
export async function seedSalida(
  client: Client,
  opts: SeedRutaOpts & { diasAdelante?: number } = {},
): Promise<SalidaFixture> {
  const ruta = await seedRuta(client, opts);
  const desde = new Date(Date.now() + (opts.diasAdelante ?? 7) * 86_400_000)
    .toISOString().slice(0, 10);
  await materializarHorario(client, ruta.horarioId, { dias: 0, desde });

  const { rows } = await client.query<{ id: string; fecha: string }>(
    `SELECT id, fecha_operacion::text AS fecha
       FROM core.salida WHERE horario_id = $1
      ORDER BY fecha_operacion LIMIT 1`,
    [ruta.horarioId],
  );

  return {
    salidaId: rows[0]!.id,
    horarioId: ruta.horarioId,
    sucursales: ruta.sucursales,
    ordenes: ruta.sucursales.map((_, i) => i),
    tipoUnidadId: ruta.tipoUnidadId,
    conductorNombre: ruta.conductorNombre,
    fechaOperacion: rows[0]!.fecha,
  };
}

/** Una tarifa vigente para un tramo de la ruta del horario. */
export async function seedTarifa(
  client: Client,
  horarioId: string,
  origenOrden: number,
  destinoOrden: number,
  importe: number,
): Promise<void> {
  await client.query(
    `INSERT INTO core.tarifa (ruta_id, parada_origen_orden, parada_destino_orden, importe)
     SELECT h.ruta_id, $2::smallint, $3::smallint, $4::numeric
       FROM core.horario h WHERE h.id = $1`,
    [horarioId, origenOrden, destinoOrden, importe],
  );
}

/** Un corte de caja abierto en una sucursal. */
export async function seedCorte(
  client: Client, sucursalId: string, usuarioId: string, saldoInicial = 500,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO core.corte_caja (sucursal_id, usuario_apertura_id, saldo_inicial)
     VALUES ($1, $2, $3) RETURNING id`,
    [sucursalId, usuarioId, saldoInicial],
  );
  return rows[0]!.id;
}

/** Un instante cómodamente anterior al cierre de venta de la parada dada. */
export async function antesDelCierre(
  client: Client, salidaId: string, orden = 0,
): Promise<Date> {
  const { rows } = await client.query<{ cierre: Date }>(
    `SELECT cierre_venta_en AS cierre FROM core.salida_parada
      WHERE salida_id = $1 AND orden = $2`,
    [salidaId, orden],
  );
  return new Date(rows[0]!.cierre.getTime() - 60 * 60 * 1000);
}

/**
 * Un usuario con credencial (hash de `PASSWORD_OK`) y acceso a una sucursal,
 * para las pruebas HTTP que necesitan un token real.
 */
export async function crearUsuarioConAcceso(
  client: Client, sucursalId: string, rol = 'vendedor',
): Promise<{ usuarioId: string; email: string }> {
  const email = `v-${Date.now().toString(36)}${seq++}@donaji.test`;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO core.usuario (nombre, email, rol)
     VALUES ('Vendedor Prueba', $1::citext, $2::text) RETURNING id`,
    [email, rol],
  );
  const usuarioId = rows[0]!.id;
  await client.query(
    `INSERT INTO core.usuario_sucursal (usuario_id, sucursal_id) VALUES ($1, $2)`,
    [usuarioId, sucursalId],
  );
  await client.query(
    `INSERT INTO auth_local.credencial (usuario_id, hash_password) VALUES ($1, $2)`,
    [usuarioId, await hashPrueba()],
  );
  return { usuarioId, email };
}

/** Un usuario con el rol dado (para las ventas de prueba). */
export async function crearUsuario(client: Client, rol = 'vendedor'): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO core.usuario (nombre, email, rol)
     VALUES ('U ' || $1, ('u' || floor(random()*1e9)::bigint || '@donaji.test')::citext, $1::text)
     RETURNING id`,
    [rol],
  );
  return rows[0]!.id;
}

interface BoletoArgs {
  salidaId: string; sucursalId: string; usuarioId: string;
  asiento: number; desde: number; hasta: number;
}

/** Crea venta + boleto (sin ocupación firme). Devuelve el id del boleto. */
let folioSeq = 900_000;
export async function crearBoleto(client: Client, args: BoletoArgs): Promise<string> {
  const tramos = `[${args.desde},${args.hasta})`;
  const { rows: v } = await client.query<{ id: string }>(
    `INSERT INTO core.venta (id, sucursal_venta_id, usuario_id, contacto_telefono, salida_id,
                             parada_origen_orden, parada_destino_orden, importe_total)
     VALUES (core.uuid_v7(), $1, $2, '953 000 0000', $3, $4, $5, 450) RETURNING id`,
    [args.sucursalId, args.usuarioId, args.salidaId, args.desde, args.hasta],
  );
  const folio = `T${String(folioSeq++).slice(-5)}`;
  const { rows: b } = await client.query<{ id: string }>(
    `INSERT INTO core.boleto (id, venta_id, folio, salida_id, asiento_num, tramos, pasajero_nombre, importe)
     VALUES (core.uuid_v7(), $1, $2, $3, $4, $5::int4range, 'Pasajero', 450) RETURNING id`,
    [v[0]!.id, folio, args.salidaId, args.asiento, tramos],
  );
  return b[0]!.id;
}

/** Ocupa un asiento en firme (sin pasar por la venta completa: aún no existe). */
export async function ocuparAsiento(client: Client, args: BoletoArgs): Promise<string> {
  const boletoId = await crearBoleto(client, args);
  await client.query(
    `INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, boleto_id, estado, sucursal_id, emitido_en)
     VALUES (core.uuid_v7(), $1, $2, $3::int4range, $4, 'firme', $5, now())`,
    [args.salidaId, args.asiento, `[${args.desde},${args.hasta})`, boletoId, args.sucursalId],
  );
  return boletoId;
}

/**
 * Boleto + ocupación en el estado pedido, con pago/impresión opcionales.
 * Bajo nivel: para montar escenarios de conflicto y reasignación sin pasar por
 * `registrar_venta`.
 */
export async function sembrarOcupacion(
  client: Client,
  a: {
    salidaId: string; sucursalId: string; usuarioId: string; corteId?: string;
    asiento: number; desde: number; hasta: number;
    estado?: 'firme' | 'conflicto';
    emitidoEn?: string;
    pagar?: boolean;
    impreso?: boolean;
  },
): Promise<{ boletoId: string; ocupacionId: string; ventaId: string }> {
  const boletoId = await crearBoleto(client, {
    salidaId: a.salidaId, sucursalId: a.sucursalId, usuarioId: a.usuarioId,
    asiento: a.asiento, desde: a.desde, hasta: a.hasta,
  });
  const { rows: v } = await client.query<{ venta_id: string }>(
    `SELECT venta_id FROM core.boleto WHERE id = $1`, [boletoId],
  );
  if (a.pagar) {
    if (!a.corteId) throw new Error('sembrarOcupacion: pagar requiere corteId');
    await client.query(
      `INSERT INTO core.pago (id, venta_id, sucursal_cobro_id, corte_caja_id, usuario_id,
                              metodo, monto, verificado, pagado_en)
       SELECT core.uuid_v7(), b.venta_id, $2, $3, $4, 'efectivo', b.importe, true, now()
         FROM core.boleto b WHERE b.id = $1`,
      [boletoId, a.sucursalId, a.corteId, a.usuarioId],
    );
  }
  if (a.impreso) {
    await client.query(`UPDATE core.boleto SET impreso_en = now() WHERE id = $1`, [boletoId]);
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO core.asiento_ocupacion (id, salida_id, asiento_num, tramos, boleto_id,
                                         estado, sucursal_id, emitido_en, prioridad)
     VALUES (core.uuid_v7(), $1, $2, $3::int4range, $4, $5, $6, $7::timestamptz, 0)
     RETURNING id`,
    [
      a.salidaId, a.asiento, `[${a.desde},${a.hasta})`, boletoId,
      a.estado ?? 'firme', a.sucursalId, a.emitidoEn ?? new Date().toISOString(),
    ],
  );
  return { boletoId, ocupacionId: rows[0]!.id, ventaId: v[0]!.venta_id };
}

/** Un lease vivo sobre un asiento (para probar que bloquea la oferta). */
export async function crearLease(
  client: Client,
  args: {
    salidaId: string; sucursalId: string; asiento: number;
    desde: number; hasta: number; minutos?: number;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO core.asiento_lease (id, salida_id, asiento_num, tramos, sucursal_id, expira_en)
     VALUES (core.uuid_v7(), $1, $2, $3::int4range, $4, now() + make_interval(mins => $5::int))
     RETURNING id`,
    [args.salidaId, args.asiento, `[${args.desde},${args.hasta})`, args.sucursalId, args.minutos ?? 15],
  );
  return rows[0]!.id;
}
