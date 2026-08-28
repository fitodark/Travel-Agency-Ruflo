/**
 * Rutas de sucursales de la consola de administración (F2b, slice 2).
 *
 * Se registra dentro del bloque `/api` de `servidor.ts`, así que hereda el
 * `preHandler` de autenticación: todo lo de aquí exige un admin.
 */

import type { FastifyInstance } from 'fastify';
import type { Consultable } from '../db/consulta.js';
import type { ModoPropagacion } from './escribir-config.js';
import { resolverAgencia } from './lookups.js';
import {
  crearSucursal, darDeBajaSucursal, editarSucursal, listarSucursales, regenerarHotp,
} from './sucursales.js';

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

/** Errores de validación de dominio (código inválido, zona desconocida, sin códigos libres). */
function esValidacion(err: unknown): err is Error {
  return err instanceof Error && !(err as { code?: string }).code;
}

export function rutasSucursales(app: FastifyInstance, { db, ahora }: OpcionesRutas): void {
  app.get('/sucursales', async () => listarSucursales(db));

  app.post<{ Body: CamposPropagacion & {
    agenciaId?: string; nombre: string; direccionCompleta: string;
    telefonoPrincipal: string; codigo?: string; zonaHoraria?: string;
  } }>(
    '/sucursales',
    {
      schema: {
        body: {
          type: 'object',
          required: ['nombre', 'direccionCompleta', 'telefonoPrincipal'],
          properties: {
            agenciaId: { type: 'string', format: 'uuid' },
            nombre: { type: 'string', minLength: 1 },
            direccionCompleta: { type: 'string', minLength: 1 },
            telefonoPrincipal: { type: 'string', minLength: 1 },
            codigo: { type: 'string', minLength: 1, maxLength: 1 },
            zonaHoraria: { type: 'string' },
            ...propagacion,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      try {
        const r = await crearSucursal(db, {
          agenciaId: await resolverAgencia(db, b.agenciaId),
          nombre: b.nombre,
          direccionCompleta: b.direccionCompleta,
          telefonoPrincipal: b.telefonoPrincipal,
          ...(b.codigo ? { codigo: b.codigo } : {}),
          ...(b.zonaHoraria ? { zonaHoraria: b.zonaHoraria } : {}),
        }, opsDe(b, ahora));
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'sucursal_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: CamposPropagacion & {
    nombre?: string; direccionCompleta?: string; telefonoPrincipal?: string; zonaHoraria?: string;
  } }>(
    '/sucursales/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          properties: {
            nombre: { type: 'string', minLength: 1 },
            direccionCompleta: { type: 'string', minLength: 1 },
            telefonoPrincipal: { type: 'string', minLength: 1 },
            zonaHoraria: { type: 'string' },
            ...propagacion,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      try {
        const r = await editarSucursal(db, req.params.id, {
          ...(b.nombre !== undefined ? { nombre: b.nombre } : {}),
          ...(b.direccionCompleta !== undefined ? { direccionCompleta: b.direccionCompleta } : {}),
          ...(b.telefonoPrincipal !== undefined ? { telefonoPrincipal: b.telefonoPrincipal } : {}),
          ...(b.zonaHoraria !== undefined ? { zonaHoraria: b.zonaHoraria } : {}),
        }, opsDe(b, ahora));
        return reply.send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'sucursal_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: CamposPropagacion }>(
    '/sucursales/:id/baja',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', properties: { ...propagacion } },
      },
    },
    async (req, reply) => {
      const r = await darDeBajaSucursal(db, req.params.id, opsDe(req.body, ahora));
      return reply.send({ ...r, escritoPor: req.admin.email });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/sucursales/:id/regenerar-hotp',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (req, reply) => {
      const r = await regenerarHotp(db, req.params.id, { ahora });
      return reply.send({ ...r, escritoPor: req.admin.email });
    },
  );
}
