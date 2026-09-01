/**
 * Cortes de caja y movimientos (F6) sobre la API local.
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
 *
 * `sucursalId`, `usuarioId` y `rol` SIEMPRE salen de la sesión.
 *  - Visibilidad de movimientos INACTIVOS: la decide el rol (gerente/vendedor
 *    ven solo activos, el administrador ve todo — `movimientosDeCorte`).
 *  - Visibilidad de un CORTE y sus movimientos (0045): admin = todos; gerente =
 *    su sucursal; vendedor = los que él abrió (`corteVisiblePor`).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  abrirCorte, cerrarCorte, corteAbiertoDe, corteVisiblePor, historialCortes,
  saldoCorte, type AlcanceCorte,
} from '../../caja/corte.js';
import {
  anularMovimiento, movimientosDeCorte, registrarEgreso, type Rol,
} from '../../caja/movimiento.js';
import { exige } from '../autenticar.js';
import { prohibido } from '../errores.js';

const idParam = {
  type: 'object', required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const alcanceDe = (req: FastifyRequest): AlcanceCorte => ({
  rol: req.sesion.rol as Rol,
  usuarioId: req.sesion.usuarioId,
  sucursalId: req.sesion.sucursalId!,
});

export async function rutasCaja(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', exige());

  // El corte abierto de mi sucursal, con su saldo. `null` si no hay ninguno.
  app.get('/corte', async (req) => {
    const corteId = await corteAbiertoDe(app.db, req.sesion.sucursalId!);
    if (!corteId) return null;
    const saldo = await saldoCorte(app.db, corteId);
    return { corteId, ...saldo };
  });

  // Historial de cortes visible por rol (0045): admin = todos; gerente = su
  // sucursal; vendedor = los que él abrió. Filtros opcionales por fecha/estado.
  app.get(
    '/cortes',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            desde: { type: 'string', format: 'date' },
            hasta: { type: 'string', format: 'date' },
            estado: { type: 'string', enum: ['abierto', 'cerrado'] },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { desde?: string; hasta?: string; estado?: 'abierto' | 'cerrado' };
      return historialCortes(app.db, alcanceDe(req), q);
    },
  );

  app.post(
    '/corte',
    {
      preHandler: exige({ permiso: 'corte.abrir' }),
      schema: {
        body: {
          type: 'object', required: ['saldoInicial'],
          properties: { saldoInicial: { type: 'number', minimum: 0 } },
        },
      },
    },
    async (req, reply) => {
      const { saldoInicial } = req.body as { saldoInicial: number };
      const corteId = await abrirCorte(app.db, {
        sucursalId: req.sesion.sucursalId!,
        usuarioId: req.sesion.usuarioId,
        saldoInicial,
        ahora: app.ahora(),
      });
      return reply.status(201).send({ corteId });
    },
  );

  app.post(
    '/corte/:id/cerrar',
    {
      preHandler: exige({ permiso: 'corte.cerrar' }),
      schema: {
        params: idParam,
        body: {
          type: 'object', required: ['saldoDeclarado'],
          properties: { saldoDeclarado: { type: 'number', minimum: 0 } },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { saldoDeclarado } = req.body as { saldoDeclarado: number };
      return cerrarCorte(app.db, {
        corteId: id,
        usuarioCierreId: req.sesion.usuarioId,
        saldoDeclarado,
        ahora: app.ahora(),
      });
    },
  );

  app.get(
    '/corte/:id/movimientos',
    { schema: { params: idParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      if (!(await corteVisiblePor(app.db, id, alcanceDe(req)))) throw prohibido();
      return movimientosDeCorte(app.db, id, req.sesion.rol as Rol);
    },
  );

  app.post(
    '/corte/:id/egresos',
    {
      preHandler: exige({ permiso: 'movimiento.egreso.crear' }),
      schema: {
        params: idParam,
        body: {
          type: 'object', required: ['monto', 'descripcion'],
          properties: {
            monto: { type: 'number', exclusiveMinimum: 0 },
            descripcion: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { monto: number; descripcion: string };
      const movimientoId = await registrarEgreso(app.db, {
        corteId: id,
        usuarioId: req.sesion.usuarioId,
        monto: b.monto,
        descripcion: b.descripcion,
        ahora: app.ahora(),
      });
      return reply.status(201).send({ movimientoId });
    },
  );

  app.post(
    '/movimientos/:id/anular',
    {
      preHandler: exige({ permiso: 'movimiento.anular' }),
      schema: {
        params: idParam,
        body: {
          type: 'object', required: ['motivo'],
          properties: { motivo: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { motivo } = req.body as { motivo: string };
      // `false` = ya estaba inactivo (idempotente). El "no existe" y el "corte
      // cerrado" los lanza la función y el handler los mapea a 422.
      const anulado = await anularMovimiento(app.db, {
        movimientoId: id,
        usuarioId: req.sesion.usuarioId,
        motivo,
        ahora: app.ahora(),
      });
      return { anulado };
    },
  );
}
