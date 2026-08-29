/**
 * Administración de la configuración clase A — desde la MISMA app de la terminal.
 *
 * Blueprint v0.2 · docs/architecture/blueprint.md §4.1
 *                  docs/architecture/03-auth-impresion-config.md §1.1, §3
 *
 * POR QUÉ AQUÍ Y NO EN UNA CONSOLA APARTE:
 * Hay una sola PC por sucursal (D-1). Un administrador llega a esa PC, inicia
 * sesión en la SPA como cualquier otro usuario (contra `auth_local`, offline), y
 * hace su trabajo de administración sin abrir una segunda aplicación. Al terminar
 * cierra sesión y la PC queda libre para un vendedor o gerente.
 *
 * LA REGLA QUE SE MANTIENE: la terminal NUNCA escribe configuración clase A en su
 * base LOCAL. Estas rutas escriben en la NUBE (`dbNube`), que la replica de vuelta
 * a las cuatro sucursales con `effective_from`. Por eso editar configuración
 * EXIGE conexión: sin `dbNube` disponible, todo `/admin/*` responde 503 y la SPA
 * muestra la sección en solo-lectura desde `/catalogos/*`.
 *
 * AUTORIZACIÓN: la sesión local del administrador. Su `rol='administrador'` es un
 * hecho replicado desde la nube (`core.usuario` + `auth_local.credencial` clase A,
 * 0034). No hace falta un segundo login (Supabase Auth) como en la consola de F2b.
 */

import type { FastifyInstance } from 'fastify';
import type { Consultable } from '../../db/consulta.js';
import type { AdminAutenticado } from '../../admin/servidor.js';
import { escribirConfig, TABLAS_ADMINISTRABLES } from '../../admin/escribir-config.js';
import { rutasConfig } from '../../admin/rutas-config.js';
import { rutasSucursales } from '../../admin/rutas-sucursales.js';
import { rutasUsuarios } from '../../admin/rutas-usuarios.js';
import { exige } from '../autenticar.js';
import { entradaInvalida, prohibido } from '../errores.js';

export interface OpcionesAdmin {
  /** Conexión a la NUBE (rol `donaji_consola` / `DATABASE_URL`), o `null` si no hay. */
  dbNube: Consultable | null;
  ahora: () => Date;
}

interface CuerpoConfigGenerico {
  fila?: Record<string, unknown>;
  modo?: 'ventana' | 'inmediato' | 'programado';
  vigenciaEn?: 'effective_from' | 'effective_until';
  zonaHoraria?: string;
  fechaProgramada?: string;
  confirmarInmediato?: boolean;
}

export async function rutasAdmin(app: FastifyInstance, opts: OpcionesAdmin): Promise<void> {
  const { dbNube, ahora } = opts;

  // Sondeo para la SPA: ¿está disponible la administración (hay nube)? Fuera del
  // sub-plugin de abajo, así que sin autenticación ni bloqueo.
  app.get('/salud', async () => ({ disponible: dbNube !== null }));

  // Todo lo demás en un contexto encapsulado con sus hooks.
  await app.register(async (prot) => {
    if (!dbNube) {
      prot.addHook('preHandler', async (_req, reply) =>
        reply.status(503).send({
          error: 'sin_conexion',
          mensaje: 'La administración de la configuración necesita conexión a la nube.',
        }),
      );
      // Una ruta comodín para que el 503 (y no un 404) sea la respuesta.
      prot.route({ method: ['GET', 'POST', 'PATCH', 'DELETE'], url: '/*', handler: async () => undefined });
      return;
    }

    // Sesión local válida + rol administrador. El `req.admin` se sintetiza a
    // partir de la sesión local para que los handlers reutilizados de
    // `src/admin/` (que solo leen `req.admin.email` para `escritoPor`) funcionen.
    prot.addHook('preHandler', exige({ conSucursal: false }));
    prot.addHook('preHandler', async (req) => {
      if (req.sesion.rol !== 'administrador') throw prohibido();
      const { rows } = await app.db.query<{ email: string }>(
        `SELECT email FROM core.usuario WHERE id = $1`, [req.sesion.usuarioId],
      );
      req.admin = {
        sub: req.sesion.usuarioId,
        email: rows[0]?.email ?? req.sesion.usuarioId,
        rol: 'administrador',
        exp: 0,
        usuarioId: req.sesion.usuarioId,
      } satisfies AdminAutenticado;
    });

    prot.get('/yo', async (req) => ({
      email: req.admin.email,
      usuarioId: req.admin.usuarioId,
      nube: true,
    }));

    rutasSucursales(prot, { db: dbNube, ahora });
    rutasUsuarios(prot, { db: dbNube, ahora });
    rutasConfig(prot, { db: dbNube, ahora });

    // Endpoint genérico para las tablas sin ruta dedicada (parámetros, permisos).
    // Sin schema sobre `fila`: lleva columnas arbitrarias y `escribirConfig` ya
    // valida (clase A + columnas reales).
    prot.post<{ Params: { tabla: string }; Body: CuerpoConfigGenerico }>(
      '/config/:tabla',
      {
        schema: {
          params: { type: 'object', required: ['tabla'], properties: { tabla: { type: 'string' } } },
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
        const b = (req.body ?? {}) as CuerpoConfigGenerico;
        if (!b.fila || typeof b.fila !== 'object') throw entradaInvalida('falta "fila"');
        try {
          const r = await escribirConfig(dbNube, {
            tabla,
            fila: b.fila,
            modo: b.modo ?? 'ventana',
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
          if (err instanceof Error && !(err as { code?: string }).code) {
            return reply.status(400).send({ error: 'escritura_invalida', mensaje: err.message });
          }
          throw err;
        }
      },
    );
  });
}
