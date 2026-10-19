/**
 * Reportes del dashboard (F8) sobre la API local.
 *
 * Blueprint v0.2 · docs/architecture/04-riesgos-roadmap.md §3 (F8)
 *
 * SOLO LECTURA. Corren contra la base LOCAL, así que muestran los números de
 * ESTA terminal; el consolidado de las 4 sucursales es el dashboard en nube
 * (fuera de este alcance). Operación pide `dashboard.ver` (administrador y,
 * desde 0076, gerente); auditoría, salud, gastos y excepciones piden
 * `auditoria.ver` (exclusivo de administrador).
 *
 * Ninguna ruta exige sucursal activa (0076: modo consulta) — administrador ve
 * todas por defecto; gerente debe indicar una de las suyas (`?sucursalId=`),
 * ver `resolverSucursalReporte`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  reporteCortes, reporteIngresosCaja, reporteVentas, ventasVsCaja,
} from '../../dashboard/operacion.js';
import {
  auditoriaInactivos, excepcionesAbiertas, excepcionesResumen, gastos, saludSucursales,
} from '../../dashboard/auditoria.js';
import { sucursalesDe } from '../../auth/sesion.js';
import { entradaInvalida, prohibido } from '../errores.js';
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

/**
 * Resuelve CON qué sucursal filtrar un reporte (0076): administrador puede
 * pedir una o ninguna (ninguna = todas, como siempre); gerente SIEMPRE debe
 * indicar una, y solo una de las que tiene asignadas — nunca "todas". Cubre
 * tanto la sesión operando una sucursal como el modo consulta sin sucursal.
 */
async function resolverSucursalReporte(
  req: FastifyRequest, app: FastifyInstance,
): Promise<string | null> {
  const { sucursalId } = req.query as Rango;
  if (req.sesion.rol === 'administrador') return sucursalId ?? null;

  const elegida = sucursalId ?? req.sesion.sucursalId ?? null;
  if (!elegida) throw entradaInvalida('Especifica la sucursal a consultar');
  const asignadas = await sucursalesDe(app.db, req.sesion.usuarioId, app.ahora());
  if (!asignadas.some((s) => s.id === elegida)) throw prohibido();
  return elegida;
}

export async function rutasReportes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', exige({ conSucursal: false }));

  app.get('/ventas', { preHandler: exige({ ...verDashboard, conSucursal: false }), schema: { querystring: rangoQuery } },
    async (req) => {
      const { desde, hasta } = req.query as Rango;
      const sucursalId = await resolverSucursalReporte(req, app);
      return reporteVentas(app.db, { desde, hasta, ...(sucursalId ? { sucursalId } : {}) });
    });

  app.get('/ingresos-caja', { preHandler: exige({ ...verDashboard, conSucursal: false }), schema: { querystring: rangoQuery } },
    async (req) => {
      const { desde, hasta } = req.query as Rango;
      const sucursalId = await resolverSucursalReporte(req, app);
      return reporteIngresosCaja(app.db, { desde, hasta, ...(sucursalId ? { sucursalId } : {}) });
    });

  app.get('/ventas-vs-caja', { preHandler: exige({ ...verDashboard, conSucursal: false }), schema: { querystring: rangoQuery } },
    async (req) => {
      const { desde, hasta } = req.query as Rango;
      return ventasVsCaja(app.db, desde, hasta);
    });

  app.get('/cortes', { preHandler: exige({ ...verDashboard, conSucursal: false }), schema: { querystring: rangoQuery } },
    async (req) => {
      const { desde, hasta } = req.query as Rango;
      const sucursalId = await resolverSucursalReporte(req, app);
      return reporteCortes(app.db, { desde, hasta, ...(sucursalId ? { sucursalId } : {}) });
    });

  app.get('/gastos', { preHandler: exige({ ...verAuditoria, conSucursal: false }), schema: { querystring: rangoQuery } },
    async (req) => {
      const { desde, hasta } = req.query as Rango;
      return gastos(app.db, desde, hasta);
    });

  app.get('/salud', { preHandler: exige({ ...verAuditoria, conSucursal: false }) },
    async () => saludSucursales(app.db));

  app.get('/excepciones', { preHandler: exige({ ...verAuditoria, conSucursal: false }) }, async () => ({
    resumen: await excepcionesResumen(app.db),
    abiertas: await excepcionesAbiertas(app.db),
  }));

  app.get(
    '/inactivos',
    {
      preHandler: exige({ ...verAuditoria, conSucursal: false }),
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
