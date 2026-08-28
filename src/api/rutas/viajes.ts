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
  checklistAbordaje, corregirAbordaje, finalizarSalida, marcarEnRuta, registrarAbordaje,
} from '../../fleet/abordaje.js';
import { exige } from '../autenticar.js';

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
