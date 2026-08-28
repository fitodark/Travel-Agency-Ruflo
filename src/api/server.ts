/**
 * Capa HTTP de la terminal — la única autoridad de escritura del dominio.
 *
 * Blueprint v0.2 · docs/architecture/blueprint.md §4.1
 *
 * La SPA en Chrome habla con esto por `localhost`; nunca con Supabase ni con la
 * impresora directamente. Este servidor valida los invariantes contra la base
 * LOCAL y nunca consulta la nube en el camino crítico de una venta.
 *
 * `construirApp` recibe la conexión por parámetro (un `Pool` en producción, un
 * `Client` en transacción para las pruebas), así que toda la capa se prueba con
 * `app.inject()` sin levantar un puerto ni una base dedicada.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ErrorHttp } from './errores.js';
import type { ContextoSesion } from './tipos.js';
import { rutasAuth } from './rutas/auth.js';
import { rutasCatalogos } from './rutas/catalogos.js';
import { rutasClientes } from './rutas/clientes.js';
import { rutasSync } from './rutas/sync.js';
import { rutasVentas } from './rutas/ventas.js';
import { rutasCaja } from './rutas/caja.js';
import { rutasViajes } from './rutas/viajes.js';
import { rutasReportes } from './rutas/reportes.js';
import type { BaseDeDatos } from './tipos.js';

export interface OpcionesApp {
  db: BaseDeDatos;
  /** Reloj inyectable, para las pruebas de vigencia y stale-guard. */
  ahora?: () => Date;
  logger?: boolean;
}

export async function construirApp(opts: OpcionesApp): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Quita del body cualquier propiedad no declarada en el schema: la API no
    // acepta campos sorpresa.
    ajv: { customOptions: { removeAdditional: 'all', coerceTypes: true } },
  });

  app.decorate('db', opts.db);
  app.decorate('ahora', opts.ahora ?? ((): Date => new Date()));
  app.decorateRequest('sesion', null as unknown as ContextoSesion);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ErrorHttp) {
      return reply.status(err.status).send({ error: err.codigo, mensaje: err.message });
    }
    if (err.validation) {
      return reply.status(400).send({ error: 'entrada_invalida', mensaje: err.message });
    }
    // `RAISE EXCEPTION` de una función de dominio (SQLSTATE P0001): es una regla
    // de negocio con un mensaje escrito a mano, seguro de exponer.
    if (err.code === 'P0001') {
      req.log.info({ err }, 'regla de negocio');
      return reply.status(422).send({ error: 'regla_negocio', mensaje: err.message });
    }
    // Otro código SQLSTATE de PostgreSQL (empieza por dígito): restricción
    // violada, tipo inválido... No se filtra el detalle.
    if (typeof err.code === 'string' && /^[0-9]/.test(err.code)) {
      req.log.warn({ err }, 'error de base de datos');
      return reply.status(409).send({
        error: 'conflicto_datos', mensaje: 'La operación viola una restricción de datos',
      });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'error_interno', mensaje: 'Error interno' });
  });

  app.get('/salud', async () => ({ ok: true, ahora: app.ahora().toISOString() }));

  await app.register(rutasAuth, { prefix: '/auth' });
  await app.register(rutasClientes, { prefix: '/clientes' });
  await app.register(rutasCatalogos, { prefix: '/catalogos' });
  await app.register(rutasSync, { prefix: '/sync' });
  await app.register(rutasVentas, { prefix: '/ventas' });
  await app.register(rutasCaja, { prefix: '/caja' });
  await app.register(rutasViajes, { prefix: '/viajes' });
  await app.register(rutasReportes, { prefix: '/reportes' });

  return app;
}
