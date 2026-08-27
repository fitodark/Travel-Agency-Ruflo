/**
 * CRUD de clientes.
 *
 * `core.cliente` es clase B (transaccional local): la sucursal que lo registra
 * es su única escritora, y la fila sube a la nube por el outbox como cualquier
 * venta. No se fusionan duplicados automáticamente (migración 0005): dos
 * sucursales pueden tener al mismo cliente y fusionar mal es peor que duplicar.
 *
 * Cualquier sesión con sucursal elegida puede gestionar clientes: registrarlos
 * es parte del flujo de venta del vendedor.
 */

import type { FastifyInstance } from 'fastify';
import { noEncontrado } from '../errores.js';
import { exige } from '../autenticar.js';

interface FilaCliente {
  id: string;
  nombre: string;
  telefono: string | null;
  email: string | null;
  sucursal_registro_id: string | null;
  creado_en: Date;
  modificado_en: Date;
}

const SELECT = `
  SELECT id, nombre, telefono, email, sucursal_registro_id, creado_en, modificado_en
    FROM core.cliente`;

const mapear = (f: FilaCliente): Record<string, unknown> => ({
  id: f.id,
  nombre: f.nombre,
  telefono: f.telefono,
  email: f.email,
  sucursalRegistroId: f.sucursal_registro_id,
  creadoEn: f.creado_en,
  modificadoEn: f.modificado_en,
});

const cuerpoCliente = {
  type: 'object',
  properties: {
    nombre: { type: 'string', minLength: 1, maxLength: 200 },
    telefono: { type: ['string', 'null'], maxLength: 40 },
    email: { type: ['string', 'null'], maxLength: 320 },
  },
} as const;

export async function rutasClientes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', exige());

  // Búsqueda por nombre o por teléfono (normalizado a dígitos, como la columna).
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 200 },
            telefono: { type: 'string', maxLength: 40 },
            limite: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req) => {
      const { q, telefono, limite = 20 } = req.query as {
        q?: string; telefono?: string; limite?: number;
      };
      const soloDigitos = telefono ? telefono.replace(/\D/g, '') : null;

      const { rows } = await app.db.query<FilaCliente>(
        `${SELECT}
          WHERE activo
            AND ($1::text IS NULL OR nombre ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR telefono_normalizado LIKE '%' || $2 || '%')
          ORDER BY modificado_en DESC
          LIMIT $3::int`,
        [q ?? null, soloDigitos, limite],
      );
      return rows.map(mapear);
    },
  );

  app.get(
    '/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req) => {
      const { id } = req.params as { id: string };
      const { rows } = await app.db.query<FilaCliente>(`${SELECT} WHERE id = $1::uuid AND activo`, [id]);
      if (!rows[0]) throw noEncontrado('Cliente no encontrado');
      return mapear(rows[0]);
    },
  );

  app.post(
    '/',
    { schema: { body: { ...cuerpoCliente, required: ['nombre'] } } },
    async (req, reply) => {
      const b = req.body as { nombre: string; telefono?: string | null; email?: string | null };
      const { rows } = await app.db.query<FilaCliente>(
        `INSERT INTO core.cliente (nombre, telefono, email, sucursal_registro_id)
         VALUES ($1::text, $2::text, $3::citext, $4::uuid)
         RETURNING id, nombre, telefono, email, sucursal_registro_id, creado_en, modificado_en`,
        [b.nombre.trim(), b.telefono ?? null, b.email ?? null, req.sesion.sucursalId],
      );
      return reply.status(201).send(mapear(rows[0]!));
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: cuerpoCliente,
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as { nombre?: string; telefono?: string | null; email?: string | null };

      const sets: string[] = [];
      const params: unknown[] = [id];
      if (b.nombre !== undefined) { params.push(b.nombre.trim()); sets.push(`nombre = $${params.length}::text`); }
      if (b.telefono !== undefined) { params.push(b.telefono); sets.push(`telefono = $${params.length}::text`); }
      if (b.email !== undefined) { params.push(b.email); sets.push(`email = $${params.length}::citext`); }
      if (sets.length === 0) {
        const { rows } = await app.db.query<FilaCliente>(`${SELECT} WHERE id = $1::uuid AND activo`, [id]);
        if (!rows[0]) throw noEncontrado('Cliente no encontrado');
        return mapear(rows[0]);
      }

      const { rows } = await app.db.query<FilaCliente>(
        `UPDATE core.cliente SET ${sets.join(', ')}
          WHERE id = $1::uuid AND activo
          RETURNING id, nombre, telefono, email, sucursal_registro_id, creado_en, modificado_en`,
        params,
      );
      if (!rows[0]) throw noEncontrado('Cliente no encontrado');
      return mapear(rows[0]);
    },
  );

  app.delete(
    '/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { rowCount } = await app.db.query(
        `UPDATE core.cliente SET activo = false WHERE id = $1::uuid AND activo`, [id],
      );
      if (!rowCount) throw noEncontrado('Cliente no encontrado');
      return reply.status(204).send();
    },
  );
}
