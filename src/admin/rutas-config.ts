/**
 * Rutas de impresora, ticket y tarifas de la consola (F2b, slice 4).
 *
 * Se registran dentro del bloque `/api` de `servidor.ts` — heredan la auth.
 *
 * `core.parametro` y `core.rol_permiso` NO tienen rutas dedicadas: se escriben
 * por el endpoint genérico `POST /api/config/:tabla`. (Revocar un permiso además
 * exige que `rbac.puede()` filtre por `activo` — pendiente.)
 */

import type { FastifyInstance } from 'fastify';
import type { Consultable } from '../db/consulta.js';
import {
  configurarImpresora, configurarTicket, listarImpresoras, ticketVigente,
  type Transporte,
} from './impresion.js';
import { resolverAgencia } from './lookups.js';
import { crearTarifa, darDeBajaTarifa, listarRutas, listarTarifas } from './tarifas.js';

interface OpcionesRutas {
  db: Consultable;
  ahora: () => Date;
}

function esValidacion(err: unknown): err is Error {
  return err instanceof Error && !(err as { code?: string }).code;
}

const modoTarifa = {
  modo: { type: 'string', enum: ['ventana', 'programado'] },
  fechaProgramada: { type: 'string', format: 'date-time' },
} as const;

export function rutasConfig(app: FastifyInstance, { db, ahora }: OpcionesRutas): void {
  // ---- impresoras -------------------------------------------------------
  app.get<{ Querystring: { sucursalId?: string } }>('/impresoras', async (req) =>
    listarImpresoras(db, req.query.sucursalId));

  app.post<{ Body: {
    sucursalId: string; nombre: string; transporte: Transporte; ip?: string; puerto?: number;
    usbNombreCola?: string; anchoMm?: number; anchoCols?: number; codePage?: string;
    soportaQrNativo?: boolean; esPredeterminada?: boolean;
  } }>(
    '/impresoras',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sucursalId', 'nombre', 'transporte'],
          properties: {
            sucursalId: { type: 'string', format: 'uuid' },
            nombre: { type: 'string', minLength: 1 },
            transporte: { type: 'string', enum: ['tcp', 'usb'] },
            ip: { type: 'string' },
            puerto: { type: 'integer', minimum: 1, maximum: 65535 },
            usbNombreCola: { type: 'string' },
            anchoMm: { type: 'integer' },
            anchoCols: { type: 'integer' },
            codePage: { type: 'string' },
            soportaQrNativo: { type: 'boolean' },
            esPredeterminada: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await configurarImpresora(db, req.body, { ahora });
        return reply.status(r.creada ? 201 : 200).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'impresora_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  // ---- ticket ----------------------------------------------------------
  app.get<{ Querystring: { agenciaId?: string } }>(
    '/ticket',
    { schema: { querystring: { type: 'object', properties: { agenciaId: { type: 'string', format: 'uuid' } } } } },
    async (req) => (await ticketVigente(db, await resolverAgencia(db, req.query.agenciaId), ahora())) ?? {},
  );

  app.post<{ Body: {
    agenciaId?: string; logoUrl?: string | null; telefonoAtencion?: string | null;
    leyendaPie?: string | null; credencialesProveedor?: string | null; hmacQrSecreto?: string | null;
    modo?: 'ventana' | 'inmediato' | 'programado'; fechaProgramada?: string; confirmarInmediato?: boolean;
  } }>(
    '/ticket',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            agenciaId: { type: 'string', format: 'uuid' },
            logoUrl: { type: ['string', 'null'] },
            telefonoAtencion: { type: ['string', 'null'] },
            leyendaPie: { type: ['string', 'null'] },
            credencialesProveedor: { type: ['string', 'null'] },
            hmacQrSecreto: { type: ['string', 'null'] },
            modo: { type: 'string', enum: ['ventana', 'inmediato', 'programado'] },
            fechaProgramada: { type: 'string', format: 'date-time' },
            confirmarInmediato: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const r = await configurarTicket(db, {
        agenciaId: await resolverAgencia(db, b.agenciaId),
        ...(b.logoUrl !== undefined ? { logoUrl: b.logoUrl } : {}),
        ...(b.telefonoAtencion !== undefined ? { telefonoAtencion: b.telefonoAtencion } : {}),
        ...(b.leyendaPie !== undefined ? { leyendaPie: b.leyendaPie } : {}),
        ...(b.credencialesProveedor !== undefined ? { credencialesProveedor: b.credencialesProveedor } : {}),
        ...(b.hmacQrSecreto !== undefined ? { hmacQrSecreto: b.hmacQrSecreto } : {}),
      }, {
        ...(b.modo ? { modo: b.modo } : {}),
        ...(b.fechaProgramada ? { fechaProgramada: new Date(b.fechaProgramada) } : {}),
        ...(b.confirmarInmediato ? { confirmarInmediato: true } : {}),
        ahora,
      });
      return reply.status(201).send({ ...r, escritoPor: req.admin.email });
    },
  );

  // ---- tarifas -------------------------------------------------------
  app.get('/rutas', async () => listarRutas(db));

  app.get<{ Querystring: { rutaId?: string } }>('/tarifas', async (req) =>
    listarTarifas(db, req.query.rutaId));

  app.post<{ Body: {
    rutaId: string; paradaOrigenOrden: number; paradaDestinoOrden: number; importe: number;
    modo?: 'ventana' | 'programado'; fechaProgramada?: string;
  } }>(
    '/tarifas',
    {
      schema: {
        body: {
          type: 'object',
          required: ['rutaId', 'paradaOrigenOrden', 'paradaDestinoOrden', 'importe'],
          properties: {
            rutaId: { type: 'string', format: 'uuid' },
            paradaOrigenOrden: { type: 'integer', minimum: 0 },
            paradaDestinoOrden: { type: 'integer', minimum: 1 },
            importe: { type: 'number', minimum: 0 },
            ...modoTarifa,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      try {
        const r = await crearTarifa(db, b, {
          ...(b.modo ? { modo: b.modo } : {}),
          ...(b.fechaProgramada ? { fechaProgramada: new Date(b.fechaProgramada) } : {}),
          ahora,
        });
        return reply.status(201).send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'tarifa_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { modo?: 'ventana' | 'programado'; fechaProgramada?: string } }>(
    '/tarifas/:id/baja',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', properties: { ...modoTarifa } },
      },
    },
    async (req, reply) => {
      const b = req.body ?? {};
      try {
        const r = await darDeBajaTarifa(db, req.params.id, {
          ...(b.modo ? { modo: b.modo } : {}),
          ...(b.fechaProgramada ? { fechaProgramada: new Date(b.fechaProgramada) } : {}),
          ahora,
        });
        return reply.send({ ...r, escritoPor: req.admin.email });
      } catch (err) {
        if (esValidacion(err)) {
          return reply.status(400).send({ error: 'tarifa_invalida', mensaje: err.message });
        }
        throw err;
      }
    },
  );
}
