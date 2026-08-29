/**
 * Rutas de usuarios y accesos de la consola de administración (F2b, slice 3).
 *
 * Se registran bajo `/admin` en `src/api/rutas/admin.ts`, que aporta la auth
 */

import type { FastifyInstance } from 'fastify';
import type { Consultable } from '../db/consulta.js';
import type { ModoPropagacion } from './escribir-config.js';
import { generarCodigoRevocacion } from './revocacion.js';
import {
  asignarSucursal, crearUsuario, darDeBajaUsuario, editarUsuario, listarUsuarios,
  quitarSucursal, restablecerPassword,
} from './usuarios.js';

interface OpcionesRutas {
  db: Consultable;
  ahora: () => Date;
}

const propagacion = {
  modo: { type: 'string', enum: ['ventana', 'inmediato', 'programado'] },
  confirmarInmediato: { type: 'boolean' },
  fechaProgramada: { type: 'string', format: 'date-time' },
} as const;

interface CamposPropagacion {
  modo?: ModoPropagacion;
  confirmarInmediato?: boolean;
  fechaProgramada?: string;
}

const opsDe = (b: CamposPropagacion, ahora: () => Date): {
  modo?: ModoPropagacion; confirmarInmediato?: boolean; fechaProgramada?: Date; ahora: () => Date;
} => ({
  ...(b.modo ? { modo: b.modo } : {}),
  ...(b.confirmarInmediato ? { confirmarInmediato: true } : {}),
  ...(b.fechaProgramada ? { fechaProgramada: new Date(b.fechaProgramada) } : {}),
  ahora,
});

function esValidacion(err: unknown): err is Error {
  return err instanceof Error && !(err as { code?: string }).code;
}

const rol = { type: 'string', enum: ['administrador', 'gerente', 'vendedor'] } as const;

export function rutasUsuarios(app: FastifyInstance, { db, ahora }: OpcionesRutas): void {
  app.get('/usuarios', async () => listarUsuarios(db));

  app.post<{ Body: CamposPropagacion & {
    nombre: string; email: string; rol: 'administrador' | 'gerente' | 'vendedor';
    telefono?: string; sueldo?: number; sucursalIds?: string[]; passwordTemporal?: string;
  } }>(
    '/usuarios',
    {
      schema: {
        body: {
          type: 'object',
          required: ['nombre', 'email', 'rol'],
          properties: {
            nombre: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' },
            rol,
            telefono: { type: 'string' },
            sueldo: { type: 'number', minimum: 0 },
            sucursalIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
            passwordTemporal: { type: 'string', minLength: 8 },
            ...propagacion,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      try {
        const r = await crearUsuario(db, {
          nombre: b.nombre, email: b.email, rol: b.rol,
          ...(b.telefono !== undefined ? { telefono: b.telefono } : {}),
          ...(b.sueldo !== undefined ? { sueldo: b.sueldo } : {}),
          ...(b.sucursalIds ? { sucursalIds: b.sucursalIds } : {}),
          ...(b.passwordTemporal ? { passwordTemporal: b.passwordTemporal } : {}),
        }, opsDe(b, ahora));
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'usuario_invalido', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: CamposPropagacion & {
    nombre?: string; rol?: 'administrador' | 'gerente' | 'vendedor';
    telefono?: string | null; sueldo?: number | null;
  } }>(
    '/usuarios/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          properties: {
            nombre: { type: 'string', minLength: 1 },
            rol,
            telefono: { type: ['string', 'null'] },
            sueldo: { type: ['number', 'null'], minimum: 0 },
            ...propagacion,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      try {
        const r = await editarUsuario(db, req.params.id, {
          ...(b.nombre !== undefined ? { nombre: b.nombre } : {}),
          ...(b.rol !== undefined ? { rol: b.rol } : {}),
          ...(b.telefono !== undefined ? { telefono: b.telefono } : {}),
          ...(b.sueldo !== undefined ? { sueldo: b.sueldo } : {}),
        }, opsDe(b, ahora));
        return reply.send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'usuario_invalido', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: CamposPropagacion }>(
    '/usuarios/:id/baja',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', properties: { ...propagacion } },
      },
    },
    async (req, reply) => {
      const r = await darDeBajaUsuario(db, req.params.id, opsDe(req.body, ahora));
      return reply.send({ ...r, escritoPor: req.admin.email });
    },
  );

  app.post<{ Params: { id: string }; Body: CamposPropagacion & { sucursalId: string } }>(
    '/usuarios/:id/sucursales',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['sucursalId'],
          properties: { sucursalId: { type: 'string', format: 'uuid' }, ...propagacion },
        },
      },
    },
    async (req, reply) => {
      const r = await asignarSucursal(db, {
        usuarioId: req.params.id, sucursalId: req.body.sucursalId,
      }, opsDe(req.body, ahora));
      return reply.status(201).send({ ...r, escritoPor: req.admin.email });
    },
  );

  app.delete<{ Params: { id: string; sucursalId: string }; Body: CamposPropagacion }>(
    '/usuarios/:id/sucursales/:sucursalId',
    {
      schema: {
        params: {
          type: 'object', required: ['id', 'sucursalId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            sucursalId: { type: 'string', format: 'uuid' },
          },
        },
        body: { type: 'object', properties: { ...propagacion } },
      },
    },
    async (req, reply) => {
      try {
        const r = await quitarSucursal(db, {
          usuarioId: req.params.id, sucursalId: req.params.sucursalId,
        }, opsDe(req.body ?? {}, ahora));
        return reply.send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'asignacion_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { sucursalId: string } }>(
    '/usuarios/:id/codigo-revocacion',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['sucursalId'],
          properties: { sucursalId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await generarCodigoRevocacion(db, {
          usuarioId: req.params.id, sucursalId: req.body.sucursalId, ahora,
        });
        return reply.send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'revocacion_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { passwordTemporal?: string } }>(
    '/usuarios/:id/restablecer-password',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', properties: { passwordTemporal: { type: 'string', minLength: 8 } } },
      },
    },
    async (req, reply) => {
      const r = await restablecerPassword(
        db, req.params.id,
        req.body?.passwordTemporal ? { passwordTemporal: req.body.passwordTemporal } : {},
        { ahora },
      );
      return reply.send({ ...r, escritoPor: req.admin.email });
    },
  );
}
