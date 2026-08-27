/**
 * Catálogos de configuración — SOLO LECTURA.
 *
 * Blueprint v0.2 · docs/architecture/blueprint.md §4.1
 *                  docs/architecture/03-auth-impresion-config.md §1.4, §3
 *
 * La configuración (sucursales, usuarios, tarifas, impresora, ticket) es clase A:
 * "la nube gana siempre; el nodo NUNCA escribe estas tablas". El administrador la
 * edita en el dashboard en nube y baja replicada con `effective_from`. La API de
 * la terminal solo la EXPONE para que la SPA la muestre; todo se lee de las
 * vistas `v_*_vigente`, que resuelven la vigencia con el reloj local.
 */

import type { FastifyInstance } from 'fastify';
import { noEncontrado } from '../errores.js';
import { exige } from '../autenticar.js';

export async function rutasCatalogos(app: FastifyInstance): Promise<void> {
  app.get('/sucursales', { preHandler: exige() }, async () => {
    const { rows } = await app.db.query(
      `SELECT id, nombre, codigo, telefono_principal AS "telefonoPrincipal",
              direccion_completa AS "direccionCompleta", zona_horaria AS "zonaHoraria"
         FROM core.v_sucursal_vigente
        ORDER BY nombre`,
    );
    return rows;
  });

  // Solo el administrador (03 §1.4). El dashboard en nube es quien da de alta y
  // baja; aquí se listan para inspección desde la terminal.
  app.get('/usuarios', { preHandler: exige({ permiso: 'config.usuarios' }) }, async () => {
    const { rows } = await app.db.query(
      `SELECT id, nombre, email, rol, telefono, activo,
              effective_from AS "effectiveFrom", effective_until AS "effectiveUntil"
         FROM core.usuario
        ORDER BY nombre`,
    );
    return rows;
  });

  app.get('/config-impresora', { preHandler: exige() }, async (req) => {
    const { rows } = await app.db.query(
      `SELECT id, sucursal_id AS "sucursalId", nombre, transporte, host(ip) AS ip, puerto,
              usb_nombre_cola AS "usbNombreCola", ancho_mm AS "anchoMm",
              ancho_cols AS "anchoCols", code_page AS "codePage",
              soporta_qr_nativo AS "soportaQrNativo"
         FROM core.v_config_impresora_vigente
        WHERE sucursal_id = $1::uuid`,
      [req.sesion.sucursalId],
    );
    // Una terminal sin impresora configurada NO es un error: opera sin ella
    // hasta que llega el equipo (ver src/printing/config.ts).
    return rows[0] ?? null;
  });

  app.get('/config-ticket', { preHandler: exige() }, async (req) => {
    const { rows } = await app.db.query(
      `SELECT ct.logo_url AS "logoUrl", ct.telefono_atencion AS "telefonoAtencion",
              ct.leyenda_pie AS "leyendaPie", ct.credenciales_proveedor AS "credencialesProveedor"
         FROM core.sucursal s
         JOIN core.v_config_ticket_vigente ct ON ct.agencia_id = s.agencia_id
        WHERE s.id = $1::uuid`,
      [req.sesion.sucursalId],
    );
    return rows[0] ?? null;
  });

  app.get('/parametros', { preHandler: exige() }, async () => {
    const { rows } = await app.db.query<{ clave: string; valor: unknown }>(
      `SELECT DISTINCT ON (clave) clave, valor
         FROM core.parametro
        WHERE activo AND effective_from <= now()
        ORDER BY clave, effective_from DESC`,
    );
    return Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
  });

  app.get(
    '/parametros/:clave',
    { preHandler: exige(), schema: { params: { type: 'object', required: ['clave'], properties: { clave: { type: 'string' } } } } },
    async (req) => {
      const { clave } = req.params as { clave: string };
      const { rows } = await app.db.query<{ valor: unknown }>(
        `SELECT valor FROM core.parametro
          WHERE clave = $1 AND activo AND effective_from <= now()
          ORDER BY effective_from DESC LIMIT 1`,
        [clave],
      );
      if (!rows[0]) throw noEncontrado(`Parámetro "${clave}" no existe`);
      return { clave, valor: rows[0].valor };
    },
  );
}
