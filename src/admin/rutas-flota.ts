/**
 * Rutas de flota (unidades y conductores) de la sección Administración.
 *
 * Se registran bajo `/admin` en `src/api/rutas/admin.ts`, que aporta el
 * `preHandler` de autenticación + rol administrador. `core.unidad` y
 * `core.conductor` no llevan fecha de vigencia, así que todo va inmediato — no
 * hay campos de propagación (modo/ventana/programado).
 */

import type { FastifyInstance } from 'fastify';
import type { Consultable } from '../db/consulta.js';
import {
  crearConductor, crearUnidad, darDeBajaConductor, darDeBajaUnidad,
  editarConductor, editarUnidad, listarConductoresDetalle, listarTiposUnidad,
  listarUnidadesDetalle,
} from './flota.js';

interface OpcionesRutas {
  db: Consultable;
  ahora: () => Date;
}

/** Error de validación de dominio (sin `code` SQLSTATE) → 400. */
function esValidacion(err: unknown): err is Error {
  return err instanceof Error && !(err as { code?: string }).code;
}

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
} as const;

const uuidOrNull = { type: ['string', 'null'], format: 'uuid' } as const;
const textoOrNull = { type: ['string', 'null'] } as const;

export function rutasFlota(app: FastifyInstance, { db, ahora }: OpcionesRutas): void {
  // ---- lookups ----
  app.get('/tipos-unidad', async () => listarTiposUnidad(db));

  // ---- unidades ----
  app.get('/unidades-detalle', async () => listarUnidadesDetalle(db));

  app.post<{ Body: {
    numeroEconomico: string; placas?: string | null;
    tipoUnidadId: string; sucursalBaseId?: string | null;
  } }>(
    '/unidades',
    {
      schema: {
        body: {
          type: 'object',
          required: ['numeroEconomico', 'tipoUnidadId'],
          properties: {
            numeroEconomico: { type: 'string', minLength: 1 },
            placas: textoOrNull,
            tipoUnidadId: { type: 'string', format: 'uuid' },
            sucursalBaseId: uuidOrNull,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await crearUnidad(db, req.body, { ahora });
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'unidad_invalida', mensaje: err.message });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: {
    numeroEconomico?: string; placas?: string | null;
    tipoUnidadId?: string; sucursalBaseId?: string | null; activo?: boolean;
  } }>(
    '/unidades/:id',
    {
      schema: {
        ...idParam,
        body: {
          type: 'object',
          properties: {
            numeroEconomico: { type: 'string', minLength: 1 },
            placas: textoOrNull,
            tipoUnidadId: { type: 'string', format: 'uuid' },
            sucursalBaseId: uuidOrNull,
            activo: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await editarUnidad(db, req.params.id, req.body, { ahora });
        return reply.send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'unidad_invalida', mensaje: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/unidades/:id/baja',
    { schema: idParam },
    async (req, reply) => {
      const r = await darDeBajaUnidad(db, req.params.id, { ahora });
      return reply.send({ ...r, escritoPor: req.admin.email });
    },
  );

  // ---- conductores ----
  app.get('/conductores-detalle', async () => listarConductoresDetalle(db));

  app.post<{ Body: {
    nombre: string; telefono?: string | null; direccion?: string | null;
    ineNumero?: string | null; contactoNombre?: string | null; contactoTelefono?: string | null;
    tipoUnidadId: string; unidadHabitualId?: string | null;
  } }>(
    '/conductores',
    {
      schema: {
        body: {
          type: 'object',
          required: ['nombre', 'tipoUnidadId'],
          properties: {
            nombre: { type: 'string', minLength: 1 },
            telefono: textoOrNull,
            direccion: textoOrNull,
            ineNumero: textoOrNull,
            contactoNombre: textoOrNull,
            contactoTelefono: textoOrNull,
            tipoUnidadId: { type: 'string', format: 'uuid' },
            unidadHabitualId: uuidOrNull,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await crearConductor(db, req.body, { ahora });
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'conductor_invalido', mensaje: err.message });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: {
    nombre?: string; telefono?: string | null; direccion?: string | null;
    ineNumero?: string | null; contactoNombre?: string | null; contactoTelefono?: string | null;
    tipoUnidadId?: string; unidadHabitualId?: string | null; activo?: boolean;
  } }>(
    '/conductores/:id',
    {
      schema: {
        ...idParam,
        body: {
          type: 'object',
          properties: {
            nombre: { type: 'string', minLength: 1 },
            telefono: textoOrNull,
            direccion: textoOrNull,
            ineNumero: textoOrNull,
            contactoNombre: textoOrNull,
            contactoTelefono: textoOrNull,
            tipoUnidadId: { type: 'string', format: 'uuid' },
            unidadHabitualId: uuidOrNull,
            activo: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await editarConductor(db, req.params.id, req.body, { ahora });
        return reply.send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'conductor_invalido', mensaje: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conductores/:id/baja',
    { schema: idParam },
    async (req, reply) => {
      const r = await darDeBajaConductor(db, req.params.id, { ahora });
      return reply.send({ ...r, escritoPor: req.admin.email });
    },
  );
}
