/**
 * Flujo de venta / reservación (pasos 1-6) sobre la API local.
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F4)
 *
 * Expone lo que ya construyó F4 en `src/ventas/`. El mapa de asientos de la SPA
 * (paso 3) todavía espera el prototipo del cliente; hasta entonces el paso 3 es
 * elegir de la lista de `asientosOfrecibles` que devuelve la búsqueda.
 *
 * `sucursalVentaId` y `usuarioId` SIEMPRE salen de la sesión, nunca del body.
 */

import type { FastifyInstance } from 'fastify';
import { buscarSalidas } from '../../ventas/busqueda.js';
import { adquirirLease, liberarLease } from '../../ventas/lease.js';
import {
  registrarPago, registrarVenta, saldoDeVenta, verificarTransferencia,
} from '../../ventas/venta.js';
import { noEncontrado } from '../errores.js';
import { exige } from '../autenticar.js';

const pagoSchema = {
  type: 'object',
  required: ['metodo', 'monto'],
  properties: {
    metodo: { type: 'string', enum: ['efectivo', 'transferencia'] },
    monto: { type: 'number', exclusiveMinimum: 0 },
    esAbono: { type: 'boolean' },
    referencia: { type: 'string', maxLength: 120 },
    corteCajaId: { type: 'string', format: 'uuid' },
  },
} as const;

const ventaSchema = {
  type: 'object',
  required: ['salidaId', 'origenOrden', 'destinoOrden', 'contactoTelefono', 'pasajeros'],
  properties: {
    salidaId: { type: 'string', format: 'uuid' },
    origenOrden: { type: 'integer', minimum: 0 },
    destinoOrden: { type: 'integer', minimum: 1 },
    contactoTelefono: { type: 'string', minLength: 1, maxLength: 40 },
    esReservacion: { type: 'boolean' },
    clienteId: { type: 'string', format: 'uuid' },
    conConexion: { type: 'boolean' },
    pasajeros: {
      type: 'array',
      minItems: 1,
      maxItems: 18,
      items: {
        type: 'object',
        required: ['asientoNum', 'nombre', 'importe'],
        properties: {
          asientoNum: { type: 'integer', minimum: 1 },
          nombre: { type: 'string', minLength: 1, maxLength: 200 },
          importe: { type: 'number', minimum: 0 },
          leaseId: { type: 'string', format: 'uuid' },
        },
      },
    },
    pago: pagoSchema,
  },
} as const;

export async function rutasVentas(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', exige());

  // Paso 1-2: búsqueda de salidas con disponibilidad por tramo.
  app.get(
    '/salidas',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['fecha', 'origen', 'destino'],
          properties: {
            fecha: { type: 'string' },
            origen: { type: 'string', format: 'uuid' },
            destino: { type: 'string', format: 'uuid' },
            personas: { type: 'integer', minimum: 1, default: 1 },
            conConexion: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as {
        fecha: string; origen: string; destino: string;
        personas?: number; conConexion?: boolean;
      };
      return buscarSalidas(app.db, {
        fecha: q.fecha,
        sucursalOrigenId: q.origen,
        sucursalDestinoId: q.destino,
        nPersonas: q.personas ?? 1,
        sucursalVendedoraId: req.sesion.sucursalId!,
        conConexion: q.conConexion ?? true,
        ahora: app.ahora(),
      });
    },
  );

  // Paso 3 (con conexión): reservar un asiento fuera del cupo propio.
  app.post(
    '/lease',
    {
      schema: {
        body: {
          type: 'object',
          required: ['salidaId', 'asientoNum', 'desde', 'hasta'],
          properties: {
            salidaId: { type: 'string', format: 'uuid' },
            asientoNum: { type: 'integer', minimum: 1 },
            desde: { type: 'integer', minimum: 0 },
            hasta: { type: 'integer', minimum: 1 },
            duracionSeg: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req) => {
      const b = req.body as {
        salidaId: string; asientoNum: number; desde: number; hasta: number; duracionSeg?: number;
      };
      return adquirirLease(app.db, {
        salidaId: b.salidaId,
        asientoNum: b.asientoNum,
        desde: b.desde,
        hasta: b.hasta,
        sucursalId: req.sesion.sucursalId!,
        ...(b.duracionSeg ? { duracionSeg: b.duracionSeg } : {}),
        ahora: app.ahora(),
      });
    },
  );

  app.post(
    '/lease/:id/liberar',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req) => {
      const { id } = req.params as { id: string };
      return { liberado: await liberarLease(app.db, id, app.ahora()) };
    },
  );

  // Pasos 4-6: registrar la venta o reservación.
  app.post(
    '/',
    { schema: { body: ventaSchema }, preHandler: exige({ permiso: 'venta.crear' }) },
    async (req, reply) => {
      const b = req.body as {
        salidaId: string; origenOrden: number; destinoOrden: number;
        contactoTelefono: string; esReservacion?: boolean; clienteId?: string;
        conConexion?: boolean;
        pasajeros: Array<{ asientoNum: number; nombre: string; importe: number; leaseId?: string }>;
        pago?: {
          metodo: 'efectivo' | 'transferencia'; monto: number;
          esAbono?: boolean; referencia?: string; corteCajaId?: string;
        };
      };

      const r = await registrarVenta(app.db, {
        salidaId: b.salidaId,
        sucursalVentaId: req.sesion.sucursalId!,
        usuarioId: req.sesion.usuarioId,
        contactoTelefono: b.contactoTelefono,
        origenOrden: b.origenOrden,
        destinoOrden: b.destinoOrden,
        pasajeros: b.pasajeros,
        esReservacion: b.esReservacion ?? false,
        ...(b.clienteId ? { clienteId: b.clienteId } : {}),
        ...(b.pago ? { pago: b.pago } : {}),
        conConexion: b.conConexion ?? true,
        ahora: app.ahora(),
      });
      return reply.status(201).send(r);
    },
  );

  // Abono o liquidación posterior (posiblemente en otra sucursal, C5).
  app.post(
    '/:ventaId/pagos',
    {
      schema: {
        params: { type: 'object', required: ['ventaId'], properties: { ventaId: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['metodo', 'monto'],
          properties: {
            sucursalCobroId: { type: 'string', format: 'uuid' },
            metodo: { type: 'string', enum: ['efectivo', 'transferencia'] },
            monto: { type: 'number', exclusiveMinimum: 0 },
            esAbono: { type: 'boolean' },
            referencia: { type: 'string', maxLength: 120 },
            corteCajaId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req) => {
      const { ventaId } = req.params as { ventaId: string };
      const b = req.body as {
        sucursalCobroId?: string; metodo: 'efectivo' | 'transferencia'; monto: number;
        esAbono?: boolean; referencia?: string; corteCajaId?: string;
      };
      return registrarPago(app.db, {
        ventaId,
        sucursalCobroId: b.sucursalCobroId ?? req.sesion.sucursalId!,
        usuarioId: req.sesion.usuarioId,
        metodo: b.metodo,
        monto: b.monto,
        esAbono: b.esAbono ?? false,
        ...(b.referencia ? { referencia: b.referencia } : {}),
        ...(b.corteCajaId ? { corteCajaId: b.corteCajaId } : {}),
        ahora: app.ahora(),
      });
    },
  );

  app.post(
    '/pagos/:pagoId/verificar',
    { schema: { params: { type: 'object', required: ['pagoId'], properties: { pagoId: { type: 'string', format: 'uuid' } } } } },
    async (req) => {
      const { pagoId } = req.params as { pagoId: string };
      return verificarTransferencia(app.db, pagoId, req.sesion.usuarioId, app.ahora());
    },
  );

  app.get(
    '/:ventaId',
    { schema: { params: { type: 'object', required: ['ventaId'], properties: { ventaId: { type: 'string', format: 'uuid' } } } } },
    async (req) => {
      const { ventaId } = req.params as { ventaId: string };
      const saldo = await saldoDeVenta(app.db, ventaId);
      if (!saldo) throw noEncontrado('Venta no encontrada');

      const { rows: boletos } = await app.db.query(
        `SELECT b.id, b.folio, b.asiento_num AS "asientoNum", b.tramos::text AS tramos,
                b.pasajero_nombre AS "pasajeroNombre", b.importe, b.estado,
                b.impreso_en AS "impresoEn"
           FROM core.boleto b
          WHERE b.venta_id = $1::uuid AND b.activo
          ORDER BY b.asiento_num`,
        [ventaId],
      );
      return { ...saldo, boletos };
    },
  );
}
