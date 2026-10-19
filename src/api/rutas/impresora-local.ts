/**
 * Override LOCAL de emergencia para la impresora (0078).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §2.1 (D-4)
 *
 * Deliberadamente FUERA de `/admin`: esas rutas exigen `dbNube` (escriben
 * configuración clase A en la nube) y responden 503 entero sin conexión — que
 * es justo el escenario que esto resuelve. Esta ruta solo toca `app.db` (la
 * base LOCAL) y debe funcionar con o sin internet.
 *
 * Mismo criterio de autorización que `/admin` (rol, no permiso de
 * `rol_permiso`): es una corrección de hardware de la propia terminal, no una
 * operación que un vendedor o gerente deba tocar.
 */

import type { FastifyInstance } from 'fastify';
import {
  fijarOverrideLocal, listarImpresorasLocales, quitarOverrideLocal, type Transporte,
} from '../../printing/override-local.js';
import { exige } from '../autenticar.js';
import { entradaInvalida, prohibido } from '../errores.js';

export async function rutasImpresoraLocal(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', exige({ conSucursal: false }));
  app.addHook('preHandler', async (req) => {
    if (req.sesion.rol !== 'administrador') throw prohibido();
  });

  app.get<{ Querystring: { sucursalId?: string } }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { sucursalId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) => {
      const sucursalId = req.query.sucursalId ?? req.sesion.sucursalId;
      if (!sucursalId) {
        throw entradaInvalida('Falta sucursalId: la sesión no tiene una sucursal activa.');
      }
      return listarImpresorasLocales(app.db, sucursalId);
    },
  );

  app.post<{ Params: { id: string }; Body: {
    transporte: Transporte; ip?: string; puerto?: number; usbNombreCola?: string; nota?: string;
  } }>(
    '/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['transporte'],
          properties: {
            transporte: { type: 'string', enum: ['tcp', 'usb'] },
            ip: { type: 'string' },
            puerto: { type: 'integer', minimum: 1, maximum: 65535 },
            usbNombreCola: { type: 'string' },
            nota: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        await fijarOverrideLocal(app.db, {
          impresoraId: req.params.id,
          transporte: req.body.transporte,
          ...(req.body.ip !== undefined ? { ip: req.body.ip } : {}),
          ...(req.body.puerto !== undefined ? { puerto: req.body.puerto } : {}),
          ...(req.body.usbNombreCola !== undefined ? { usbNombreCola: req.body.usbNombreCola } : {}),
          ...(req.body.nota !== undefined ? { nota: req.body.nota } : {}),
          actualizadoPor: req.sesion.usuarioId,
        }, { ahora: app.ahora });
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof Error) {
          return reply.status(400).send({ error: 'override_invalido', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (req, reply) => {
      await quitarOverrideLocal(app.db, req.params.id);
      return reply.status(204).send();
    },
  );
}
