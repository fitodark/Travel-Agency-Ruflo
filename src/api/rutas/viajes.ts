/**
 * Viajes efectuados (F7) sobre la API local: salidas del día, checklist de
 * abordaje, manifiestos y estado del viaje (en ruta / finalizada).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.5
 *                  docs/architecture/02b-modelo-transaccional.md §5
 *
 * `sucursalId` y `usuarioId` SIEMPRE salen de la sesión. Generar manifiestos,
 * marcar en ruta, finalizar y capturar abordaje piden `abordaje.registrar` — es
 * el rol operativo de la terminal (vendedor y por encima).
 */

import type { FastifyInstance } from 'fastify';
import {
  datosManifiesto, generarManifiestos, salidasDelDia, type CopiaManifiesto,
} from '../../fleet/manifiesto.js';
import {
  boletosReubicables, buscarBoletoPorFolio, cancelarBoleto, checklistAbordaje, corregirAbordaje,
  detalleBoleto, finalizarSalida, marcarEnRuta, registrarAbordaje, reimprimirBoleto,
  reubicarHuerfano, reubicarVentaHuerfana, verificarBoletoQr,
} from '../../fleet/abordaje.js';
import { exige } from '../autenticar.js';
import { noEncontrado } from '../errores.js';

const idParam = {
  type: 'object', required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const operar = { permiso: 'abordaje.registrar' } as const;

export async function rutasViajes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', exige());

  // Salidas de un día que tocan mi sucursal. `fecha` por defecto: hoy.
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { fecha: { type: 'string', format: 'date' } },
        },
      },
    },
    async (req) => {
      const { fecha } = req.query as { fecha?: string };
      return salidasDelDia(app.db, {
        fecha: fecha ?? app.ahora().toISOString().slice(0, 10),
        sucursalId: req.sesion.sucursalId!,
      });
    },
  );

  app.get('/:id/checklist', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params as { id: string };
    return checklistAbordaje(app.db, id);
  });

  // Buscar un boleto por su folio (string base32, no un consecutivo). Devuelve el
  // boleto + el contexto del viaje para capturar el abordaje o saltar al viaje.
  app.get(
    '/boleto',
    {
      schema: {
        querystring: {
          type: 'object', required: ['folio'],
          properties: { folio: { type: 'string', minLength: 1, maxLength: 20 } },
        },
      },
    },
    async (req) => {
      const { folio } = req.query as { folio: string };
      const b = await buscarBoletoPorFolio(app.db, folio);
      if (!b) throw noEncontrado('No hay ningún boleto con ese folio.');
      return b;
    },
  );

  // Verificación de un boleto escaneado (QR de texto plano, 03 §2.4): valida el
  // HMAC contra el secreto de la agencia y cruza el folio con la base local.
  // Todo offline. Cualquier usuario autenticado (es un chequeo de abordaje).
  app.post(
    '/boleto/verificar',
    {
      schema: {
        body: {
          type: 'object', required: ['qr'],
          properties: { qr: { type: 'string', minLength: 1, maxLength: 800 } },
        },
      },
    },
    async (req) => {
      const { qr } = req.body as { qr: string };
      return verificarBoletoQr(app.db, {
        qr, sucursalId: req.sesion.sucursalId!, ahora: app.ahora(),
      });
    },
  );

  // Detalle completo de un boleto vendido, para la modal del listado de viajes:
  // vendedor, sucursal y fecha/hora de venta, costo y tramo (origen → destino).
  app.get('/boleto/:id/detalle', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await detalleBoleto(app.db, id);
    if (!d) throw noEncontrado('No hay ningún boleto con ese id.');
    return d;
  });

  // Reimpresión de un boleto liquidado: mismo contenido + leyenda de reimpresión
  // (N-4). Encola un `print_job`; el spooler lo imprime como cualquier otro.
  app.post(
    '/boleto/:id/reimprimir',
    {
      preHandler: exige({ permiso: 'ticket.reimprimir' }),
      schema: {
        params: idParam,
        body: {
          type: 'object',
          properties: { motivo: { type: 'string', maxLength: 120 } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { motivo } = (req.body ?? {}) as { motivo?: string };
      const r = await reimprimirBoleto(app.db, {
        boletoId: id,
        usuarioId: req.sesion.usuarioId,
        sucursalId: req.sesion.sucursalId!,
        ...(motivo ? { motivo } : {}),
        ahora: app.ahora(),
      });
      return reply.status(201).send(r);
    },
  );

  // Cancelación de un boleto / reserva (D9): libera el asiento y reembolsa el
  // pago confirmado (efectivo / transferencia verificada) en el corte abierto.
  app.post(
    '/boleto/:id/cancelar',
    {
      preHandler: exige({ permiso: 'reserva.cancelar' }),
      schema: {
        params: idParam,
        body: { type: 'object', properties: { motivo: { type: 'string', maxLength: 200 } } },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { motivo } = (req.body ?? {}) as { motivo?: string };
      try {
        const r = await cancelarBoleto(app.db, {
          boletoId: id,
          usuarioId: req.sesion.usuarioId,
          sucursalId: req.sesion.sucursalId!,
          ...(motivo ? { motivo } : {}),
          ahora: app.ahora(),
        });
        return reply.status(201).send(r);
      } catch (err) {
        if (err instanceof Error && !(err as { code?: string }).code) {
          return reply.status(422).send({ error: 'cancelacion_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  // Reubicación de un boleto huérfano (D12/N-14): cancela el viejo y reemite en
  // una salida de la ruta nueva. Si ya pagó, mantiene el precio (traspasa el
  // pago); si no, cobra la tarifa vigente de la ruta nueva.
  app.post(
    '/boleto/:id/reubicar',
    {
      preHandler: exige({ permiso: 'reserva.cancelar' }),
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['salidaNuevaId', 'origenOrden', 'destinoOrden', 'asientoNum'],
          properties: {
            salidaNuevaId: { type: 'string', format: 'uuid' },
            origenOrden: { type: 'integer', minimum: 0 },
            destinoOrden: { type: 'integer', minimum: 1 },
            asientoNum: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as {
        salidaNuevaId: string; origenOrden: number; destinoOrden: number; asientoNum: number;
      };
      try {
        const r = await reubicarHuerfano(app.db, {
          boletoViejoId: id,
          usuarioId: req.sesion.usuarioId,
          sucursalId: req.sesion.sucursalId!,
          ...b,
          ahora: app.ahora(),
        });
        return reply.status(201).send(r);
      } catch (err) {
        if (err instanceof Error && !(err as { code?: string }).code) {
          return reply.status(422).send({ error: 'reubicacion_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  // Boletos vivos de una venta huérfana — para reubicar la venta completa
  // (familia multi-boleto) en una sola operación (D12/N-14, F6-D2).
  app.get(
    '/venta/:id/reubicables',
    { preHandler: exige({ permiso: 'reserva.cancelar' }), schema: { params: idParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      return boletosReubicables(app.db, id);
    },
  );

  // Reubicación de una venta huérfana completa: una venta nueva con todos los
  // boletos. Todos viajan el mismo tramo (el elegido en la salida nueva); si el
  // pasajero ya pagó, cada boleto mantiene su precio.
  app.post(
    '/venta/:id/reubicar',
    {
      preHandler: exige({ permiso: 'reserva.cancelar' }),
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['salidaNuevaId', 'origenOrden', 'destinoOrden', 'asientos'],
          properties: {
            salidaNuevaId: { type: 'string', format: 'uuid' },
            origenOrden: { type: 'integer', minimum: 0 },
            destinoOrden: { type: 'integer', minimum: 1 },
            asientos: {
              type: 'array', minItems: 1,
              items: {
                type: 'object',
                required: ['boletoViejoId', 'asientoNum'],
                properties: {
                  boletoViejoId: { type: 'string', format: 'uuid' },
                  asientoNum: { type: 'integer', minimum: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as {
        salidaNuevaId: string; origenOrden: number; destinoOrden: number;
        asientos: Array<{ boletoViejoId: string; asientoNum: number }>;
      };
      try {
        const r = await reubicarVentaHuerfana(app.db, {
          ventaViejaId: id,
          salidaNuevaId: b.salidaNuevaId,
          asignaciones: b.asientos.map((a) => ({
            boletoViejoId: a.boletoViejoId,
            origenOrden: b.origenOrden,
            destinoOrden: b.destinoOrden,
            asientoNum: a.asientoNum,
          })),
          usuarioId: req.sesion.usuarioId,
          sucursalId: req.sesion.sucursalId!,
          ahora: app.ahora(),
        });
        return reply.status(201).send(r);
      } catch (err) {
        if (err instanceof Error && !(err as { code?: string }).code) {
          return reply.status(422).send({ error: 'reubicacion_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.get(
    '/:id/manifiesto',
    {
      schema: {
        params: idParam,
        querystring: {
          type: 'object',
          properties: { copia: { type: 'string', enum: ['conductor', 'terminal'] } },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { copia } = req.query as { copia?: CopiaManifiesto };
      return datosManifiesto(app.db, id, copia ?? 'terminal', app.ahora());
    },
  );

  app.post(
    '/:id/manifiestos',
    { preHandler: exige(operar), schema: { params: idParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = await generarManifiestos(app.db, {
        salidaId: id, usuarioId: req.sesion.usuarioId, ahora: app.ahora(),
      });
      return reply.status(201).send(r);
    },
  );

  app.post(
    '/:id/en-ruta',
    {
      preHandler: exige(operar),
      schema: {
        params: idParam,
        body: {
          type: 'object',
          properties: { conductorId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { conductorId } = (req.body ?? {}) as { conductorId?: string };
      return marcarEnRuta(app.db, {
        salidaId: id,
        usuarioId: req.sesion.usuarioId,
        ...(conductorId ? { conductorId } : {}),
        ahora: app.ahora(),
      });
    },
  );

  app.post(
    '/:id/finalizar',
    { preHandler: exige(operar), schema: { params: idParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      return finalizarSalida(app.db, {
        salidaId: id, usuarioId: req.sesion.usuarioId, ahora: app.ahora(),
      });
    },
  );

  app.post(
    '/abordaje',
    {
      preHandler: exige(operar),
      schema: {
        body: {
          type: 'object', required: ['boletoId', 'abordo'],
          properties: {
            boletoId: { type: 'string', format: 'uuid' },
            abordo: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { boletoId: string; abordo: boolean };
      const eventoId = await registrarAbordaje(app.db, {
        boletoId: b.boletoId,
        abordo: b.abordo,
        usuarioId: req.sesion.usuarioId,
        sucursalId: req.sesion.sucursalId!,
        ahora: app.ahora(),
      });
      return reply.status(201).send({ eventoId });
    },
  );

  app.post(
    '/abordaje/:id/corregir',
    {
      preHandler: exige(operar),
      schema: {
        params: idParam,
        body: {
          type: 'object', required: ['abordo'],
          properties: { abordo: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { abordo } = req.body as { abordo: boolean };
      const eventoId = await corregirAbordaje(app.db, {
        eventoId: id,
        abordo,
        usuarioId: req.sesion.usuarioId,
        sucursalId: req.sesion.sucursalId!,
        ahora: app.ahora(),
      });
      return { eventoId };
    },
  );
}
