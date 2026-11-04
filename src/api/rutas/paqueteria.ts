/**
 * Paquetería sobre la API local (Fase C: registro, consulta, confirmación de
 * transferencias). Recepción y entrega en destino llegan en la Fase E.
 *
 * docs/architecture/06-lugar-paso-paqueteria.md §1.2
 *
 * `sucursalOrigenId` y `usuarioId` SIEMPRE salen de la sesión, nunca del body.
 */

import type { FastifyInstance } from 'fastify';
import {
  buscarEnvioPorFolio, despacharEnvios, entregarEnvio, enviosDeSalida, enviosParaMiSucursal,
  cancelarEnvio, moverEnvio, salidasParaEnvio, transferenciasEnvioPorVerificar,
  recibirEnvio, registrarEnvio, reimprimirEnvio, verificarTransferenciaEnvio, type EstadoEnvio,
  type RegistrarEnvioArgs,
} from '../../paqueteria/envio.js';
import { noEncontrado } from '../errores.js';
import { exige } from '../autenticar.js';

const texto = (max: number) => ({ type: 'string', minLength: 1, maxLength: max }) as const;

const envioSchema = {
  type: 'object',
  required: ['salidaId', 'sucursalDestinoId', 'remitenteNombre', 'remitenteTelefono',
             'destinatarioNombre', 'destinatarioTelefono', 'descripcion', 'bultos',
             'importe', 'modalidad'],
  additionalProperties: false,
  properties: {
    salidaId: { type: 'string', format: 'uuid' },
    sucursalDestinoId: { type: 'string', format: 'uuid' },
    remitenteNombre: texto(120),
    remitenteTelefono: texto(40),
    destinatarioNombre: texto(120),
    destinatarioTelefono: texto(40),
    descripcion: texto(200),
    bultos: { type: 'integer', minimum: 1, maximum: 99 },
    importe: { type: 'number', exclusiveMinimum: 0 },
    modalidad: { type: 'string', enum: ['pagado', 'por_cobrar'] },
    pago: {
      type: 'object',
      required: ['metodo'],
      additionalProperties: false,
      properties: {
        metodo: { type: 'string', enum: ['efectivo', 'transferencia'] },
        efectivoRecibido: { type: 'number', exclusiveMinimum: 0 },
        referencia: { type: 'string', maxLength: 120 },
        corteCajaId: { type: 'string', format: 'uuid' },
      },
    },
  },
} as const;

export async function rutasPaqueteria(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', exige());

  // Registrar un envío (P1..P6). Mismo permiso que vender un boleto.
  app.post(
    '/',
    { schema: { body: envioSchema }, preHandler: exige({ permiso: 'venta.crear' }) },
    async (req, reply) => {
      const b = req.body as Omit<RegistrarEnvioArgs, 'sucursalOrigenId' | 'usuarioId' | 'ahora'>;
      const r = await registrarEnvio(app.db, {
        ...b,
        sucursalOrigenId: req.sesion.sucursalId!,
        usuarioId: req.sesion.usuarioId,
        ahora: app.ahora(),
      });
      return reply.status(201).send(r);
    },
  );

  // Salidas candidatas de un día hacia un destino (registrar / mover).
  app.get(
    '/salidas',
    {
      schema: {
        querystring: {
          type: 'object', required: ['fecha', 'destinoId'],
          properties: {
            fecha: { type: 'string', format: 'date' },
            destinoId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req) => {
      const { fecha, destinoId } = req.query as { fecha: string; destinoId: string };
      return salidasParaEnvio(app.db, {
        fecha, destinoId, sucursalId: req.sesion.sucursalId!, ahora: app.ahora(),
      });
    },
  );

  // Cola del encargado: transferencias de paquetería por confirmar en mi sucursal.
  app.get('/transferencias-por-verificar', async (req) =>
    transferenciasEnvioPorVerificar(app.db, req.sesion.sucursalId!));

  // Consulta por folio (P10, auditoría).
  app.get(
    '/folio',
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
      const e = await buscarEnvioPorFolio(app.db, folio);
      if (!e) throw noEncontrado('No hay ningún envío con ese folio.');
      return e;
    },
  );

  // Envíos de una salida que tocan mi sucursal.
  app.get(
    '/salida/:salidaId',
    {
      schema: {
        params: {
          type: 'object', required: ['salidaId'],
          properties: { salidaId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) => {
      const { salidaId } = req.params as { salidaId: string };
      return enviosDeSalida(app.db, salidaId, req.sesion.sucursalId!);
    },
  );

  // Reimprimir recibo / etiquetas (P7).
  app.post(
    '/:envioId/reimprimir',
    {
      schema: {
        params: {
          type: 'object', required: ['envioId'],
          properties: { envioId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object', required: ['que', 'motivo'], additionalProperties: false,
          properties: {
            que: { type: 'string', enum: ['recibo', 'etiquetas', 'todo'] },
            motivo: { type: 'string', minLength: 1, maxLength: 200 },
            bulto: { type: 'integer', minimum: 1, maximum: 99 },
          },
        },
      },
    },
    async (req, reply) => {
      const { envioId } = req.params as { envioId: string };
      const b = req.body as { que: 'recibo' | 'etiquetas' | 'todo'; motivo: string; bulto?: number };
      const r = await reimprimirEnvio(app.db, {
        envioId, sucursalId: req.sesion.sucursalId!, que: b.que, motivo: b.motivo,
        ...(b.bulto ? { bulto: b.bulto } : {}),
      });
      return reply.status(201).send(r);
    },
  );

  // --- Fase E (0086) ------------------------------------------------------

  const envioParam = {
    type: 'object', required: ['envioId'],
    properties: { envioId: { type: 'string', format: 'uuid' } },
  } as const;

  // Lo que llega a mi sucursal: por recibir (registrado/en_ruta) o por entregar (en_sucursal).
  app.get(
    '/destino',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { estado: { type: 'string', enum: ['por_recibir', 'por_entregar'] } },
        },
      },
    },
    async (req) => {
      const { estado } = req.query as { estado?: 'por_recibir' | 'por_entregar' };
      const estados: EstadoEnvio[] = estado === 'por_entregar' ? ['en_sucursal']
        : estado === 'por_recibir' ? ['registrado', 'en_ruta']
          : ['registrado', 'en_ruta', 'en_sucursal'];
      return enviosParaMiSucursal(app.db, req.sesion.sucursalId!, estados);
    },
  );

  // Una terminal intermedia despacha sus envíos (el origen lo hace al marcar en ruta).
  app.post(
    '/salida/:salidaId/despachar',
    {
      preHandler: exige({ permiso: 'venta.crear' }),
      schema: {
        params: {
          type: 'object', required: ['salidaId'],
          properties: { salidaId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) => {
      const { salidaId } = req.params as { salidaId: string };
      return despacharEnvios(app.db, {
        salidaId, sucursalId: req.sesion.sucursalId!, usuarioId: req.sesion.usuarioId, ahora: app.ahora(),
      });
    },
  );

  app.post(
    '/:envioId/recibir',
    { preHandler: exige({ permiso: 'venta.crear' }), schema: { params: envioParam } },
    async (req) => {
      const { envioId } = req.params as { envioId: string };
      return recibirEnvio(app.db, {
        envioId, sucursalId: req.sesion.sucursalId!, usuarioId: req.sesion.usuarioId, ahora: app.ahora(),
      });
    },
  );

  app.post(
    '/:envioId/entregar',
    {
      preHandler: exige({ permiso: 'venta.crear' }),
      schema: {
        params: envioParam,
        body: {
          type: 'object', required: ['nombreVerificado'], additionalProperties: false,
          properties: {
            nombreVerificado: { type: 'boolean' },
            pago: envioSchema.properties.pago,
          },
        },
      },
    },
    async (req) => {
      const { envioId } = req.params as { envioId: string };
      const b = req.body as { nombreVerificado: boolean; pago?: RegistrarEnvioArgs['pago'] };
      return entregarEnvio(app.db, {
        envioId, sucursalId: req.sesion.sucursalId!, usuarioId: req.sesion.usuarioId,
        nombreVerificado: b.nombreVerificado, ...(b.pago ? { pago: b.pago } : {}), ahora: app.ahora(),
      });
    },
  );

  // --- Fase F (0087) ------------------------------------------------------

  app.post(
    '/:envioId/mover',
    {
      preHandler: exige({ permiso: 'venta.crear' }),
      schema: {
        params: envioParam,
        body: {
          type: 'object', required: ['salidaId'], additionalProperties: false,
          properties: { salidaId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) => {
      const { envioId } = req.params as { envioId: string };
      const { salidaId } = req.body as { salidaId: string };
      return moverEnvio(app.db, {
        envioId, salidaNuevaId: salidaId, sucursalId: req.sesion.sucursalId!,
        usuarioId: req.sesion.usuarioId, ahora: app.ahora(),
      });
    },
  );

  app.post(
    '/:envioId/cancelar',
    {
      preHandler: exige({ permiso: 'venta.crear' }),
      schema: {
        params: envioParam,
        body: {
          type: 'object', required: ['motivo'], additionalProperties: false,
          properties: { motivo: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req) => {
      const { envioId } = req.params as { envioId: string };
      const { motivo } = req.body as { motivo: string };
      return cancelarEnvio(app.db, {
        envioId, sucursalId: req.sesion.sucursalId!, usuarioId: req.sesion.usuarioId,
        motivo, ahora: app.ahora(),
      });
    },
  );

  // Confirmar una transferencia de paquetería (P4).
  app.post(
    '/pagos/:pagoEnvioId/verificar',
    {
      schema: {
        params: {
          type: 'object', required: ['pagoEnvioId'],
          properties: { pagoEnvioId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) => {
      const { pagoEnvioId } = req.params as { pagoEnvioId: string };
      return verificarTransferenciaEnvio(app.db, pagoEnvioId, req.sesion.usuarioId, app.ahora());
    },
  );
}
