/**
 * Rutas de autoría de rutas y horarios (F2c / Fase 3).
 *
 * Se registran bajo `/admin` en `src/api/rutas/admin.ts`, que aporta la auth
 * (sesión local del administrador) y la conexión a la nube.
 */

import type { FastifyInstance } from 'fastify';
import type { Consultable } from '../db/consulta.js';
import {
  crearHorario, crearRuta, darDeBajaHorario, darDeBajaRuta, editarHorario, editarRuta,
  listarConductores, listarHorarios, listarRutasDetalle, listarUnidades,
} from './horarios.js';
import { crearPunto, darDeBajaPunto, editarPunto, listarPuntos } from './puntos.js';
import { boletosHuerfanos, reemplazarRuta } from './rutas-reemplazo.js';

interface OpcionesRutas {
  db: Consultable;
}

function esValidacion(err: unknown): err is Error {
  return err instanceof Error && !(err as { code?: string }).code;
}

const paso = {
  type: 'object',
  required: ['rutaParadaId', 'orden', 'horaPaso'],
  properties: {
    rutaParadaId: { type: 'string', format: 'uuid' },
    orden: { type: 'integer', minimum: 0 },
    horaPaso: { type: 'string' },
  },
} as const;

const paradaNueva = {
  type: 'object',
  required: ['puntoId', 'permiteAscenso', 'permiteDescenso'],
  properties: {
    puntoId: { type: 'string', format: 'uuid' },
    permiteAscenso: { type: 'boolean' },
    permiteDescenso: { type: 'boolean' },
  },
} as const;

export function rutasHorarios(app: FastifyInstance, { db }: OpcionesRutas): void {
  // ---- puntos de ruta ----------------------------------------------
  app.get('/puntos', async () => listarPuntos(db));

  app.post<{ Body: {
    tipo: 'terminal' | 'parada'; nombre?: string; zonaHoraria?: string;
    referencia?: string; municipio?: string; sucursalId?: string;
  } }>(
    '/puntos',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tipo'],
          properties: {
            tipo: { type: 'string', enum: ['terminal', 'parada'] },
            nombre: { type: 'string', minLength: 1 },
            zonaHoraria: { type: 'string', minLength: 1 },
            referencia: { type: 'string' },
            municipio: { type: 'string' },
            sucursalId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await crearPunto(db, req.body);
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'punto_invalido', mensaje: err.message });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/puntos/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          properties: {
            nombre: { type: 'string', minLength: 1 },
            referencia: { type: ['string', 'null'] },
            municipio: { type: ['string', 'null'] },
            zonaHoraria: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        await editarPunto(db, req.params.id, req.body);
        return { ok: true };
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'punto_invalido', mensaje: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/puntos/:id/baja',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      try {
        await darDeBajaPunto(db, req.params.id);
        return { ok: true };
      } catch (err) {
        if (esValidacion(err)) return reply.status(409).send({ error: 'punto_en_uso', mensaje: err.message });
        throw err;
      }
    },
  );

  // ---- rutas ---------------------------------------------------------
  app.get('/rutas-detalle', async () => listarRutasDetalle(db));
  app.get('/conductores', async () => listarConductores(db));
  app.get('/unidades', async () => listarUnidades(db));

  app.post<{ Body:
    | { nombre: string; sucursalIds: string[] }
    | { nombre: string; paradas: { puntoId: string; permiteAscenso: boolean; permiteDescenso: boolean }[] }
  }>(
    '/rutas-detalle',
    {
      schema: {
        body: {
          type: 'object',
          required: ['nombre'],
          oneOf: [
            {
              required: ['sucursalIds'],
              properties: {
                nombre: { type: 'string', minLength: 1 },
                sucursalIds: { type: 'array', minItems: 2, items: { type: 'string', format: 'uuid' } },
              },
            },
            {
              required: ['paradas'],
              properties: {
                nombre: { type: 'string', minLength: 1 },
                paradas: { type: 'array', minItems: 2, items: paradaNueva },
              },
            },
          ],
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await crearRuta(db, req.body);
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'ruta_invalida', mensaje: err.message });
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { desde: string } }>(
    '/rutas-detalle/:id/huerfanos',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        querystring: { type: 'object', required: ['desde'], properties: { desde: { type: 'string' } } },
      },
    },
    async (req) => boletosHuerfanos(db, req.params.id, req.query.desde),
  );

  app.post<{ Params: { id: string }; Body: {
    nombre: string; vigenteDesde: string;
    paradas: { puntoId: string; permiteAscenso: boolean; permiteDescenso: boolean }[];
  } }>(
    '/rutas-detalle/:id/reemplazar',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['nombre', 'vigenteDesde', 'paradas'],
          properties: {
            nombre: { type: 'string', minLength: 1 },
            vigenteDesde: { type: 'string' },
            paradas: { type: 'array', minItems: 2, items: paradaNueva },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await reemplazarRuta(db, { rutaViejaId: req.params.id, ...req.body });
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'reemplazo_invalido', mensaje: err.message });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { nombre: string } }>(
    '/rutas-detalle/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', required: ['nombre'], properties: { nombre: { type: 'string', minLength: 1 } } },
      },
    },
    async (req) => { await editarRuta(db, req.params.id, req.body); return { ok: true }; },
  );

  app.post<{ Params: { id: string } }>(
    '/rutas-detalle/:id/baja',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req) => { await darDeBajaRuta(db, req.params.id); return { ok: true }; },
  );

  // ---- horarios -----------------------------------------------------
  app.get<{ Querystring: { rutaId?: string } }>('/horarios', async (req) =>
    listarHorarios(db, req.query.rutaId));

  app.post<{ Body: {
    rutaId: string; horaSalida: string; diasSemana: number[];
    conductorId?: string; unidadId?: string; vigenteDesde?: string; vigenteHasta?: string;
    pasos: { rutaParadaId: string; orden: number; horaPaso: string }[];
  } }>(
    '/horarios',
    {
      schema: {
        body: {
          type: 'object',
          required: ['rutaId', 'horaSalida', 'diasSemana', 'pasos'],
          properties: {
            rutaId: { type: 'string', format: 'uuid' },
            horaSalida: { type: 'string' },
            diasSemana: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } },
            conductorId: { type: 'string', format: 'uuid' },
            unidadId: { type: 'string', format: 'uuid' },
            vigenteDesde: { type: 'string' },
            vigenteHasta: { type: 'string' },
            pasos: { type: 'array', minItems: 1, items: paso },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await crearHorario(db, req.body);
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'horario_invalido', mensaje: err.message });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/horarios/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          properties: {
            horaSalida: { type: 'string' },
            diasSemana: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } },
            conductorId: { type: ['string', 'null'], format: 'uuid' },
            unidadId: { type: ['string', 'null'], format: 'uuid' },
            vigenteDesde: { type: ['string', 'null'] },
            vigenteHasta: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await editarHorario(db, req.params.id, req.body);
        return { ok: true, ...r };
      } catch (err) {
        if (esValidacion(err)) return reply.status(400).send({ error: 'horario_invalido', mensaje: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/horarios/:id/baja',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req) => ({ ok: true, ...(await darDeBajaHorario(db, req.params.id)) }),
  );
}
