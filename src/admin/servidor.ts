/**
 * Consola de administración en la nube (F2b, slice 1).
 *
 * Blueprint v0.2 · docs/architecture/03-auth-impresion-config.md §1.1, §3
 *                  docs/architecture/04-riesgos-roadmap.md §F2b
 *
 * Un proceso Node aparte, desplegado JUNTO a la nube (NO en la terminal). Es la
 * única superficie de escritura de la configuración clase A: el nodo nunca la
 * escribe, la autoriza el administrador aquí y baja replicada con `effective_from`.
 *
 * ACCESO: `Authorization: Bearer <jwt>` de Supabase Auth (§1.1). El JWT se
 * verifica offline contra `SUPABASE_JWT_SECRET`. Autorización: el email del token
 * debe ser un `core.usuario` con `rol='administrador'` vigente, o estar en la
 * lista de arranque (`ADMIN_EMAILS`) para el primer alta.
 *
 * Este slice deja los cimientos: el servidor, la auth y el endpoint genérico de
 * escritura sobre `escribirConfig`. Los CRUD por tabla (sucursales, usuarios,
 * tarifas) son los slices 2–4.
 */

import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Consultable } from '../db/consulta.js';
import {
  escribirConfig, type ModoPropagacion,
} from './escribir-config.js';
import { rutasSucursales } from './rutas-sucursales.js';
import { rutasUsuarios } from './rutas-usuarios.js';
import { TokenInvalido, verificarTokenSupabase, type IdentidadSupabase } from './auth-supabase.js';

/** Tablas de configuración que la consola puede escribir. Allowlist explícita. */
export const TABLAS_ADMINISTRABLES: readonly string[] = [
  'core.agencia',
  'core.sucursal',
  'core.usuario',
  'core.usuario_sucursal',
  'core.rol_permiso',
  'core.config_impresora',
  'core.config_ticket',
  'core.tarifa',
  'core.parametro',
  'auth_local.credencial',
  'auth_local.revocacion_hotp',
];

export interface AdminAutenticado extends IdentidadSupabase {
  /** `core.usuario.id` si el email corresponde a un usuario; `null` si entró por la lista de arranque. */
  usuarioId: string | null;
}

export interface OpcionesServidorAdmin {
  db: Consultable;
  /** Secreto JWT del proyecto Supabase (Settings → API → JWT). */
  jwtSecret: string;
  /** Emails admitidos aunque no exista aún su `core.usuario`. Para el primer alta. */
  adminsIniciales?: readonly string[];
  ahora?: () => Date;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminAutenticado;
  }
}

const cuerpoConfig = {
  type: 'object',
  required: ['fila', 'modo'],
  properties: {
    fila: { type: 'object', additionalProperties: true },
    modo: { type: 'string', enum: ['ventana', 'inmediato', 'programado'] },
    vigenciaEn: { type: 'string', enum: ['effective_from', 'effective_until'] },
    zonaHoraria: { type: 'string' },
    fechaProgramada: { type: 'string', format: 'date-time' },
    confirmarInmediato: { type: 'boolean' },
  },
} as const;

interface CuerpoConfig {
  fila: Record<string, unknown>;
  modo: ModoPropagacion;
  vigenciaEn?: 'effective_from' | 'effective_until';
  zonaHoraria?: string;
  fechaProgramada?: string;
  confirmarInmediato?: boolean;
}

export function construirServidorAdmin(opts: OpcionesServidorAdmin): FastifyInstance {
  if (!opts.jwtSecret || opts.jwtSecret.length < 20) {
    throw new Error('SUPABASE_JWT_SECRET ausente o demasiado corto (mínimo 20 caracteres).');
  }
  const db = opts.db;
  const ahora = opts.ahora ?? ((): Date => new Date());
  const iniciales = new Set((opts.adminsIniciales ?? []).map((e) => e.toLowerCase()));

  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) {
      return reply.status(400).send({ error: 'entrada_invalida', mensaje: err.message });
    }
    if (err.code === 'P0001') {
      return reply.status(422).send({ error: 'regla_negocio', mensaje: err.message });
    }
    if (typeof err.code === 'string' && /^[0-9]/.test(err.code)) {
      req.log.warn({ err }, 'error de base de datos');
      return reply.status(409).send({
        error: 'conflicto_datos', mensaje: 'La operación viola una restricción de datos',
      });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'error_interno', mensaje: 'Error interno' });
  });

  app.get('/salud', async () => ({ ok: true }));

  async function autenticar(req: FastifyRequest): Promise<AdminAutenticado> {
    const cabecera = req.headers.authorization ?? '';
    const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';
    if (!token) throw new TokenInvalido('falta el encabezado Authorization: Bearer');

    const id = verificarTokenSupabase(token, opts.jwtSecret, ahora);

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM core.usuario
        WHERE lower(email) = $1 AND rol = 'administrador' AND activo
          AND effective_from <= now()
          AND (effective_until IS NULL OR effective_until > now())`,
      [id.email],
    );
    const usuarioId = rows[0]?.id ?? null;
    if (!usuarioId && !iniciales.has(id.email)) {
      const e = new Error('no autorizado como administrador') as Error & { estado?: number };
      e.estado = 403;
      throw e;
    }
    return { ...id, usuarioId };
  }

  app.register(async (api) => {
    api.addHook('preHandler', async (req, reply) => {
      try {
        req.admin = await autenticar(req);
      } catch (err) {
        if (err instanceof TokenInvalido) {
          return reply.status(401).send({ error: 'no_autorizado', mensaje: err.message });
        }
        const estado = (err as { estado?: number }).estado ?? 401;
        return reply.status(estado).send({
          error: estado === 403 ? 'prohibido' : 'no_autorizado',
          mensaje: err instanceof Error ? err.message : 'no autorizado',
        });
      }
    });

    api.get('/yo', async (req) => ({
      email: req.admin.email,
      rol: req.admin.rol,
      usuarioId: req.admin.usuarioId,
      viaListaDeArranque: req.admin.usuarioId === null,
    }));

    rutasSucursales(api, { db, ahora });
    rutasUsuarios(api, { db, ahora });

    api.post<{ Params: { tabla: string }; Body: CuerpoConfig }>(
      '/config/:tabla',
      {
        schema: {
          params: {
            type: 'object', required: ['tabla'],
            properties: { tabla: { type: 'string' } },
          },
          body: cuerpoConfig,
        },
      },
      async (req, reply) => {
        const { tabla } = req.params;
        if (!TABLAS_ADMINISTRABLES.includes(tabla)) {
          return reply.status(400).send({
            error: 'tabla_no_administrable',
            mensaje: `"${tabla}" no está en la lista de tablas administrables.`,
          });
        }
        const b = req.body;
        try {
          const r = await escribirConfig(db, {
            tabla,
            fila: b.fila,
            modo: b.modo,
            ...(b.vigenciaEn ? { vigenciaEn: b.vigenciaEn } : {}),
            ...(b.zonaHoraria ? { zonaHoraria: b.zonaHoraria } : {}),
            ...(b.fechaProgramada ? { fechaProgramada: new Date(b.fechaProgramada) } : {}),
            ...(b.confirmarInmediato ? { confirmarInmediato: true } : {}),
            ahora,
          });
          return reply.status(r.creada ? 201 : 200).send({
            id: r.id,
            creada: r.creada,
            vigenciaEn: r.vigenciaEn,
            vigenciaDesde: r.vigenciaDesde.toISOString(),
            escritoPor: req.admin.email,
          });
        } catch (err) {
          // Errores de guarda de `escribirConfig` (clase A, es_nube, columnas):
          // son entrada inválida del administrador, no fallos internos.
          if (err instanceof Error && !(err as FastifyError).code) {
            return reply.status(400).send({ error: 'escritura_invalida', mensaje: err.message });
          }
          throw err;
        }
      },
    );
  }, { prefix: '/api' });

  return app;
}
