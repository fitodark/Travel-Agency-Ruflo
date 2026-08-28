/**
 * Reportes del dashboard (F8) sobre la API local.
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
 *
 * SOLO LECTURA. Corren contra la base LOCAL, así que muestran los números de
 * ESTA terminal; el consolidado de las 4 sucursales es el dashboard en nube
 * (fuera de este alcance). Operación pide `dashboard.ver`; auditoría, salud,
 * gastos y excepciones piden `auditoria.ver`. Ambos permisos son de administrador.
 */

import type { FastifyInstance } from 'fastify';
import {
  reporteCortes, reporteIngresosCaja, reporteVentas, ventasVsCaja,
} from '../../dashboard/operacion.js';
import {
  auditoriaInactivos, excepcionesAbiertas, excepcionesResumen, gastos, saludSucursales,
} from '../../dashboard/auditoria.js';
import { exige } from '../autenticar.js';

const rangoQuery = {
  type: 'object', required: ['desde', 'hasta'],
  properties: {
    desde: { type: 'string', format: 'date' },
    hasta: { type: 'string', format: 'date' },
    sucursalId: { type: 'string', format: 'uuid' },
  },
} as const;

interface Rango { desde: string; hasta: string; sucursalId?: string }

const verDashboard = { permiso: 'dashboard.ver' } as const;
const verAuditoria = { permiso: 'auditoria.ver' } as const;

export async function rutasReportes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', exige());

  app.get('/ventas', { preHandler: exige(verDashboard), schema: { querystring: rangoQuery } },
    async (req) => reporteVentas(app.db, req.query as Rango));

  app.get('/ingresos-caja', { preHandler: exige(verDashboard), schema: { querystring: rangoQuery } },
    async (req) => reporteIngresosCaja(app.db, req.query as Rango));

  app.get('/ventas-vs-caja', { preHandler: exige(verDashboard), schema: { querystring: rangoQuery } },
    async (req) => {
      const { desde, hasta } = req.query as Rango;
      return ventasVsCaja(app.db, desde, hasta);
    });

  app.get('/cortes', { preHandler: exige(verDashboard), schema: { querystring: rangoQuery } },
    async (req) => reporteCortes(app.db, req.query as Rango));

  app.get('/gastos', { preHandler: exige(verAuditoria), schema: { querystring: rangoQuery } },
    async (req) => {
      const { desde, hasta } = req.query as Rango;
      return gastos(app.db, desde, hasta);
    });

  app.get('/salud', { preHandler: exige(verAuditoria) },
    async () => saludSucursales(app.db));

  app.get('/excepciones', { preHandler: exige(verAuditoria) }, async () => ({
    resumen: await excepcionesResumen(app.db),
    abiertas: await excepcionesAbiertas(app.db),
  }));

  app.get(
    '/inactivos',
    {
      preHandler: exige(verAuditoria),
      schema: {
        querystring: {
          type: 'object',
          properties: { tabla: { type: 'string', maxLength: 60 } },
        },
      },
    },
    async (req) => {
      const { tabla } = req.query as { tabla?: string };
      return auditoriaInactivos(app.db, tabla ? { tabla } : {});
    },
  );
}
