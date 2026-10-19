/**
 * Cortes de caja y movimientos (F6) sobre la API local.
 *
 * Blueprint v0.2 · docs/architecture/02b-modelo-transaccional.md §3
 *
 * `sucursalId`, `usuarioId` y `rol` SIEMPRE salen de la sesión.
 *  - Visibilidad de movimientos INACTIVOS: la decide el rol (gerente/vendedor
 *    ven solo activos, el administrador ve todo — `movimientosDeCorte`).
 *  - Visibilidad de un CORTE y sus movimientos (0045): admin = todos; gerente =
 *    su sucursal; vendedor = los que él abrió (`corteVisiblePor`).
 *
 * El MÓDULO "Historial de Cortes" (0077: `/cortes`, `/cortes/usuarios`,
 * `/cortes/:id`, `/corte/:id/movimientos-detalle`) es aparte de la caja activa
 * y pide el permiso `dashboard.ver` (administrador y gerente) — un vendedor ya
 * no lo ve ni por API, aunque siga pudiendo abrir/cerrar SU corte y ver sus
 * propios movimientos en vivo (`/corte`, `/corte/:id/movimientos`).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  abrirCorte, cerrarCorte, cobradoEnCorresponsal, corteAbiertoDe, corteDetalle,
  corteVisiblePor, cortesUsuariosVisibles, historialCortes, saldoCorte,
  type AlcanceCorte,
} from '../../caja/corte.js';
import {
  anularMovimiento, movimientosDeCorte, movimientosCorteDetalle, registrarEgreso,
  type Rol,
} from '../../caja/movimiento.js';
import { transferenciasPorVerificar } from '../../ventas/venta.js';
import { sucursalesDe } from '../../auth/sesion.js';
import { exige } from '../autenticar.js';
import { entradaInvalida, noEncontrado, prohibido } from '../errores.js';

const verHistorial = { permiso: 'dashboard.ver', conSucursal: false } as const;

const idParam = {
  type: 'object', required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const alcanceDe = (req: FastifyRequest): AlcanceCorte => ({
  rol: req.sesion.rol as Rol,
  usuarioId: req.sesion.usuarioId,
  sucursalId: req.sesion.sucursalId,
});

/**
 * Resuelve con qué sucursal consultar el historial de cortes cuando la
 * sesión no trae una propia (0076, modo consulta): administrador puede
 * pedir una o ninguna (ninguna = todas); gerente SIEMPRE debe indicar una, y
 * solo una de las que tiene asignadas.
 */
async function resolverSucursalCaja(
  req: FastifyRequest, app: FastifyInstance, queryId?: string,
): Promise<string | null> {
  if (req.sesion.rol === 'administrador') return queryId ?? req.sesion.sucursalId;

  const elegida = queryId ?? req.sesion.sucursalId;
  if (!elegida) throw entradaInvalida('Especifica la sucursal a consultar');
  const asignadas = await sucursalesDe(app.db, req.sesion.usuarioId, app.ahora());
  if (!asignadas.some((s) => s.id === elegida)) throw prohibido();
  return elegida;
}

export async function rutasCaja(app: FastifyInstance): Promise<void> {
  // Lenient por defecto (0077): el módulo "Historial de Cortes" (admin/gerente,
  // `dashboard.ver`) se consulta SIN sucursal activa (0076, modo consulta). Las
  // rutas que sí operan el corte activo de la sesión exigen `conSucursal` ellas
  // mismas (`exige()` por defecto ya lo hace).
  app.addHook('preHandler', exige({ conSucursal: false }));

  // El corte abierto de mi sucursal, con su saldo. `null` si no hay ninguno.
  app.get('/corte', { preHandler: exige() }, async (req) => {
    const corteId = await corteAbiertoDe(app.db, req.sesion.sucursalId!);
    if (!corteId) return null;
    const saldo = await saldoCorte(app.db, corteId);
    return { corteId, ...saldo };
  });

  // Historial de cortes visible por rol (0045), paginado (0077): admin = todos;
  // gerente = su sucursal; vendedor = los que él abrió. Pantalla propia
  // "Historial de Cortes" (admin/gerente, `dashboard.ver`) — filtros opcionales
  // por fecha/estado/usuario que abrió, paginado 20/50/100.
  //
  // Sin sucursal activa en la sesión (0076, modo consulta): hay que indicar
  // `?sucursalId=` explícito. Para gerente debe ser una de sus sucursales
  // asignadas (`f_cortes_visibles` igual solo le muestra esa). Para admin la
  // función ignora el parámetro (ve todas) — si no lo manda, se pasa `null`.
  app.get(
    '/cortes',
    {
      preHandler: exige(verHistorial),
      schema: {
        querystring: {
          type: 'object',
          properties: {
            desde: { type: 'string', format: 'date' },
            hasta: { type: 'string', format: 'date' },
            estado: { type: 'string', enum: ['abierto', 'cerrado'] },
            sucursalId: { type: 'string', format: 'uuid' },
            usuarioAperturaId: { type: 'string', format: 'uuid' },
            pagina: { type: 'integer', minimum: 1 },
            porPagina: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as {
        desde?: string; hasta?: string; estado?: 'abierto' | 'cerrado'; sucursalId?: string;
        usuarioAperturaId?: string; pagina?: number; porPagina?: number;
      };
      const sucursalId = await resolverSucursalCaja(req, app, q.sucursalId);
      // La SPA solo ofrece 20/50/100 en su combo; el esquema ya acota 1-100.
      const porPagina = q.porPagina ?? 20;
      const pagina = q.pagina ?? 1;
      const { filas, total } = await historialCortes(app.db, { ...alcanceDe(req), sucursalId }, {
        ...(q.desde ? { desde: q.desde } : {}),
        ...(q.hasta ? { hasta: q.hasta } : {}),
        ...(q.estado ? { estado: q.estado } : {}),
        ...(q.usuarioAperturaId ? { usuarioAperturaId: q.usuarioAperturaId } : {}),
        limite: porPagina, offset: (pagina - 1) * porPagina,
      });
      return { filas, total, pagina, porPagina };
    },
  );

  // Combo de filtro "usuario propietario del corte" (0077): solo quienes de
  // verdad abrieron un corte dentro del historial visible por esta sesión.
  app.get(
    '/cortes/usuarios',
    {
      preHandler: exige(verHistorial),
      schema: {
        querystring: {
          type: 'object',
          properties: {
            desde: { type: 'string', format: 'date' },
            hasta: { type: 'string', format: 'date' },
            estado: { type: 'string', enum: ['abierto', 'cerrado'] },
            sucursalId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as {
        desde?: string; hasta?: string; estado?: 'abierto' | 'cerrado'; sucursalId?: string;
      };
      const sucursalId = await resolverSucursalCaja(req, app, q.sucursalId);
      return cortesUsuariosVisibles(app.db, { ...alcanceDe(req), sucursalId }, q);
    },
  );

  // Resumen de un corte por id (0077): encabezado de /historial/:id/movimientos.
  app.get(
    '/cortes/:id',
    { preHandler: exige(verHistorial), schema: { params: idParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      if (!(await corteVisiblePor(app.db, id, alcanceDe(req)))) throw prohibido();
      const detalle = await corteDetalle(app.db, id);
      if (!detalle) throw noEncontrado('El corte no existe');
      return detalle;
    },
  );

  app.post(
    '/corte',
    {
      preHandler: exige({ permiso: 'corte.abrir' }),
      schema: {
        body: {
          type: 'object', required: ['saldoInicial'],
          properties: { saldoInicial: { type: 'number', minimum: 0 } },
        },
      },
    },
    async (req, reply) => {
      const { saldoInicial } = req.body as { saldoInicial: number };
      const corteId = await abrirCorte(app.db, {
        sucursalId: req.sesion.sucursalId!,
        usuarioId: req.sesion.usuarioId,
        saldoInicial,
        ahora: app.ahora(),
      });
      return reply.status(201).send({ corteId });
    },
  );

  app.post(
    '/corte/:id/cerrar',
    {
      preHandler: exige({ permiso: 'corte.cerrar' }),
      schema: {
        params: idParam,
        body: {
          type: 'object', required: ['saldoDeclarado'],
          properties: { saldoDeclarado: { type: 'number', minimum: 0 } },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { saldoDeclarado } = req.body as { saldoDeclarado: number };
      return cerrarCorte(app.db, {
        corteId: id,
        usuarioCierreId: req.sesion.usuarioId,
        saldoDeclarado,
        ahora: app.ahora(),
      });
    },
  );

  app.get(
    '/corte/:id/movimientos',
    { preHandler: exige(), schema: { params: idParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      if (!(await corteVisiblePor(app.db, id, alcanceDe(req)))) throw prohibido();
      return movimientosDeCorte(app.db, id, req.sesion.rol as Rol);
    },
  );

  // Detalle de movimientos con método de pago y pasajeros (0077), para
  // /historial/:id/movimientos — aparte del `/corte/:id/movimientos` operativo
  // que usa la pantalla Caja sobre el corte activo.
  app.get(
    '/corte/:id/movimientos-detalle',
    { preHandler: exige(verHistorial), schema: { params: idParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      if (!(await corteVisiblePor(app.db, id, alcanceDe(req)))) throw prohibido();
      return movimientosCorteDetalle(app.db, id);
    },
  );

  // Cola del encargado (0065): transferencias registradas en mi sucursal cuyo
  // comprobante aún no se confirma. La confirmación es `POST /ventas/pagos/:id/verificar`
  // (quien vendió o un gerente/admin); suma al corte abierto en ese momento.
  app.get('/transferencias-por-verificar', { preHandler: exige() }, async (req) =>
    transferenciasPorVerificar(app.db, req.sesion.sucursalId!),
  );

  // Apartado "cobrado en corresponsal" del corte (D8): pagos que se cobraron en
  // una sucursal sin sistema y NO entran al efectivo, listados aparte. Su único
  // consumidor es /historial/:id/movimientos (0077) — mismo permiso que el resto
  // del módulo.
  app.get(
    '/corte/:id/corresponsal',
    { preHandler: exige(verHistorial), schema: { params: idParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      if (!(await corteVisiblePor(app.db, id, alcanceDe(req)))) throw prohibido();
      return cobradoEnCorresponsal(app.db, id);
    },
  );

  app.post(
    '/corte/:id/egresos',
    {
      preHandler: exige({ permiso: 'movimiento.egreso.crear' }),
      schema: {
        params: idParam,
        body: {
          type: 'object', required: ['monto', 'descripcion'],
          properties: {
            monto: { type: 'number', exclusiveMinimum: 0 },
            descripcion: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { monto: number; descripcion: string };
      const movimientoId = await registrarEgreso(app.db, {
        corteId: id,
        usuarioId: req.sesion.usuarioId,
        monto: b.monto,
        descripcion: b.descripcion,
        ahora: app.ahora(),
      });
      return reply.status(201).send({ movimientoId });
    },
  );

  app.post(
    '/movimientos/:id/anular',
    {
      preHandler: exige({ permiso: 'movimiento.anular' }),
      schema: {
        params: idParam,
        body: {
          type: 'object', required: ['motivo'],
          properties: { motivo: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { motivo } = req.body as { motivo: string };
      // `false` = ya estaba inactivo (idempotente). El "no existe" y el "corte
      // cerrado" los lanza la función y el handler los mapea a 422.
      const anulado = await anularMovimiento(app.db, {
        movimientoId: id,
        usuarioId: req.sesion.usuarioId,
        motivo,
        ahora: app.ahora(),
      });
      return { anulado };
    },
  );
}
