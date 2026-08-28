/**
 * Tablero consolidado en nube (F8).
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
 *                  docs/architecture/api-contrato.md
 *
 * Un proceso Node aparte, desplegado junto a la nube (NO en la terminal). Lee
 * `reporte.*` de Supabase —los mismos módulos que el tablero local, pero SIN
 * filtro de sucursal: aquí se ven las 4 juntas— y sirve una página estática que
 * las muestra.
 *
 * ACCESO (P7, decisión provisional): bearer compartido en `DASHBOARD_TOKEN`. No
 * hay sesiones ni RBAC: quien tiene el token ve todos los reportes, de solo
 * lectura. Cuando P7 se cierre formalmente (rol de Postgres dedicado / PostgREST)
 * esto se revisa.
 */

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Consultable } from '../db/consulta.js';
import {
  reporteCortes, reporteIngresosCaja, reporteVentas, ventasVsCaja,
} from './operacion.js';
import { excepcionesAbiertas, excepcionesResumen, gastos, saludSucursales } from './auditoria.js';

const PAGINA = readFileSync(fileURLToPath(new URL('./tablero.html', import.meta.url)), 'utf8');

export interface OpcionesTablero {
  db: Consultable;
  /** Token que exige `Authorization: Bearer`. */
  token: string;
  logger?: boolean;
  /** Sobrescribe la página servida en `/` (para pruebas). */
  pagina?: string;
}

/** Comparación en tiempo constante; `false` si difieren en longitud. */
function tokenValido(recibido: string, esperado: string): boolean {
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const rangoQuery = {
  type: 'object', required: ['desde', 'hasta'],
  properties: {
    desde: { type: 'string', format: 'date' },
    hasta: { type: 'string', format: 'date' },
  },
} as const;

interface Rango { desde: string; hasta: string }

export function construirServidorTablero(opts: OpcionesTablero): FastifyInstance {
  if (!opts.token || opts.token.length < 16) {
    throw new Error('DASHBOARD_TOKEN ausente o demasiado corto (mínimo 16 caracteres).');
  }

  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: { customOptions: { removeAdditional: 'all', coerceTypes: true } },
  });
  const db = opts.db;
  const pagina = opts.pagina ?? PAGINA;

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) {
      return reply.status(400).send({ error: 'entrada_invalida', mensaje: err.message });
    }
    if (typeof err.code === 'string' && /^[0-9]/.test(err.code)) {
      req.log.warn({ err }, 'error de base de datos');
      return reply.status(400).send({ error: 'consulta_invalida', mensaje: 'Rango o parámetro inválido' });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'error_interno', mensaje: 'Error interno' });
  });

  // Healthcheck: SIN auth, para el balanceador / la tarea programada.
  app.get('/salud', async () => ({ ok: true }));

  // La página del tablero: pública (solo HTML/JS; los datos siguen tras el token).
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(pagina));

  app.register(async (api) => {
    api.addHook('preHandler', async (req, reply) => {
      const cabecera = req.headers.authorization ?? '';
      const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';
      if (!token || !tokenValido(token, opts.token)) {
        return reply.status(401).send({ error: 'no_autorizado', mensaje: 'Token ausente o inválido' });
      }
    });

    api.get('/ventas', { schema: { querystring: rangoQuery } },
      async (req) => reporteVentas(db, req.query as Rango));

    api.get('/ingresos-caja', { schema: { querystring: rangoQuery } },
      async (req) => reporteIngresosCaja(db, req.query as Rango));

    api.get('/ventas-vs-caja', { schema: { querystring: rangoQuery } }, async (req) => {
      const { desde, hasta } = req.query as Rango;
      return ventasVsCaja(db, desde, hasta);
    });

    api.get('/cortes', { schema: { querystring: rangoQuery } },
      async (req) => reporteCortes(db, req.query as Rango));

    api.get('/gastos', { schema: { querystring: rangoQuery } }, async (req) => {
      const { desde, hasta } = req.query as Rango;
      return gastos(db, desde, hasta);
    });

    api.get('/salud', async () => saludSucursales(db));

    api.get('/excepciones', async () => ({
      resumen: await excepcionesResumen(db),
      abiertas: await excepcionesAbiertas(db),
    }));
  }, { prefix: '/reportes' });

  return app;
}
