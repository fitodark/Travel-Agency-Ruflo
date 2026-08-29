/**
 * Rutas de autenticación. Cero llamadas a la nube — todo contra la base local.
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.3
 */

import type { FastifyInstance } from 'fastify';
import { corteAbiertoDe } from '../../caja/corte.js';
import { login } from '../../auth/login.js';
import { permisosDe } from '../../auth/rbac.js';
import { aplicarCodigoRevocacion } from '../../auth/revocacion.js';
import { cerrarSesion, seleccionarSucursal, sucursalesDe } from '../../auth/sesion.js';
import { conflicto, entradaInvalida, noAutorizado } from '../errores.js';
import { exige } from '../autenticar.js';

const emailPassword = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 320 },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
    sucursalId: { type: 'string', format: 'uuid' },
  },
} as const;

export async function rutasAuth(app: FastifyInstance): Promise<void> {
  app.post('/login', { schema: { body: emailPassword } }, async (req, reply) => {
    const b = req.body as { email: string; password: string; sucursalId?: string };
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ?? req.ip;

    const r = await login({
      node: app.db,
      email: b.email,
      password: b.password,
      ...(b.sucursalId ? { sucursalId: b.sucursalId } : {}),
      ip: ip || null,
      ahora: app.ahora,
    });

    if (!r.ok) {
      const status = r.motivo === 'demasiados_intentos' ? 429 : 401;
      return reply.status(status).send({ error: r.motivo, mensaje: 'Login rechazado' });
    }

    return {
      token: r.token,
      usuarioId: r.usuarioId,
      rol: r.rol,
      debeCambiar: r.debeCambiar,
      sesionCompleta: r.sesionCompleta,
      sucursales: r.sucursales,
    };
  });

  app.post(
    '/sucursal',
    {
      preHandler: exige({ conSucursal: false }),
      schema: {
        body: {
          type: 'object',
          required: ['sucursalId'],
          properties: { sucursalId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) => {
      const { sucursalId } = req.body as { sucursalId: string };
      const r = await seleccionarSucursal(app.db, {
        token: req.sesion.token, sucursalId, ahora: app.ahora,
      });
      if (!r.ok) {
        if (r.motivo === 'sesion_invalida') throw noAutorizado();
        if (r.motivo === 'sucursal_no_asignada') throw entradaInvalida('Sucursal no asignada al usuario');
        throw conflicto('La sesión ya tiene sucursal elegida');
      }
      return { sucursalId: r.sucursalId };
    },
  );

  // Cambiar de sucursal sin cerrar sesión: solo entre las asignadas al usuario, y
  // solo si no queda un corte de caja abierto en la sucursal que se deja.
  app.post(
    '/cambiar-sucursal',
    {
      preHandler: exige({ conSucursal: false }),
      schema: {
        body: {
          type: 'object',
          required: ['sucursalId'],
          properties: { sucursalId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) => {
      const { sucursalId } = req.body as { sucursalId: string };
      const actual = req.sesion.sucursalId;
      if (actual && actual !== sucursalId && (await corteAbiertoDe(app.db, actual))) {
        throw conflicto('Cierra el corte de caja de la sucursal actual antes de cambiar');
      }
      const r = await seleccionarSucursal(app.db, {
        token: req.sesion.token, sucursalId, ahora: app.ahora, permitirCambio: true,
      });
      if (!r.ok) {
        if (r.motivo === 'sesion_invalida') throw noAutorizado();
        if (r.motivo === 'sucursal_no_asignada') throw entradaInvalida('Sucursal no asignada al usuario');
        throw conflicto('No se pudo cambiar de sucursal');
      }
      return { sucursalId: r.sucursalId };
    },
  );

  app.post('/logout', { preHandler: exige({ conSucursal: false }) }, async (req) => {
    await cerrarSesion(app.db, req.sesion.token, 'logout');
    return { ok: true };
  });

  app.get('/me', { preHandler: exige({ conSucursal: false }) }, async (req) => {
    const sucursales = await sucursalesDe(app.db, req.sesion.usuarioId, app.ahora());
    return {
      usuarioId: req.sesion.usuarioId,
      rol: req.sesion.rol,
      sucursalId: req.sesion.sucursalId,
      sucursalNombre: sucursales.find((s) => s.id === req.sesion.sucursalId)?.nombre ?? null,
      sucursales,
      permisos: await permisosDe(app.db, req.sesion.rol),
    };
  });

  // Capa 3 de revocación (§1.5): el gerente captura el código que el
  // administrador le dictó por teléfono. Se aplica a la sucursal de esta terminal.
  app.post(
    '/revocar',
    {
      preHandler: exige({ permiso: 'usuario.revocar' }),
      schema: {
        body: {
          type: 'object',
          required: ['codigo', 'usuarioId'],
          properties: {
            codigo: { type: 'string', minLength: 6, maxLength: 20 },
            usuarioId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req) => {
      const b = req.body as { codigo: string; usuarioId: string };
      const r = await aplicarCodigoRevocacion(app.db, {
        codigo: b.codigo, usuarioId: b.usuarioId, ahora: app.ahora,
      });
      if (!r.ok) {
        if (r.motivo === 'sin_semilla') {
          throw conflicto('Esta terminal no tiene semilla de revocación configurada');
        }
        throw entradaInvalida('Código de revocación inválido o vencido');
      }
      return { ok: true, contador: r.contador, sesionesCerradas: r.sesionesCerradas };
    },
  );
}
