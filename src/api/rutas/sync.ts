/**
 * Estado del motor de sincronización — SOLO LECTURA, más un disparador manual.
 *
 * Blueprint v0.2 · docs/architecture/blueprint.md §4.1
 *                  docs/architecture/01-sincronizacion.md §3.3
 *
 * El motor de sync es un contenedor APARTE de la API (blueprint §4.1). Estos
 * endpoints existen para que la SPA muestre su estado en vivo y para que QA
 * pueda disparar un ciclo a mano — nunca se llama a la nube en el camino
 * crítico de una venta.
 */

import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { resolveConnection } from '../../db/connection.js';
import { push } from '../../sync/push.js';
import { pull } from '../../sync/pull.js';
import { exige } from '../autenticar.js';

const UMBRAL_DEFECTO_HORAS = 72;
const OUTBOX_ATASCADO_INTENTOS = 5;

export async function rutasSync(app: FastifyInstance): Promise<void> {
  app.get('/estado', { preHandler: exige() }, async () => {
    const nodo = await app.db.query<{
      sucursal_id: string | null; version_esquema: string | null; version_binario: string | null;
    }>(
      `SELECT n.sucursal_id,
              coalesce(n.version_esquema,
                (SELECT max(version) FROM public.schema_migration)) AS version_esquema,
              n.version_binario
         FROM sync.nodo n WHERE n.singleton`,
    );

    const salud = await app.db.query<{ ultima: Date | null; deriva: number | null }>(
      `SELECT ultima_sync_exitosa AS ultima, deriva_reloj_seg AS deriva
         FROM sync.salud WHERE sucursal_id = sync.sucursal_local()`,
    );

    const outbox = await app.db.query<{
      pendiente: string; atascado: string; mas_antiguo: Date | null;
    }>(
      `SELECT count(*) FILTER (WHERE estado NOT IN ('confirmado','rechazado') AND intentos < $1) AS pendiente,
              count(*) FILTER (WHERE estado = 'rechazado' OR intentos >= $1)                     AS atascado,
              min(creado_en) FILTER (WHERE estado <> 'confirmado')                               AS mas_antiguo
         FROM sync.outbox`,
      [OUTBOX_ATASCADO_INTENTOS],
    );

    const exc = await app.db.query<{ severidad: string; n: string }>(
      `SELECT severidad, count(*) AS n FROM sync.excepcion
        WHERE estado IN ('abierta','en_proceso') GROUP BY severidad`,
    );
    const excepciones = { critica: 0, alta: 0, media: 0, baja: 0 };
    for (const r of exc.rows) excepciones[r.severidad as keyof typeof excepciones] = Number(r.n);

    const aplicador = await app.db.query<{ ultima_pasada: Date | null }>(
      `SELECT ultima_pasada FROM sync.config_aplicado WHERE singleton`,
    );

    const umbral = await app.db.query<{ horas: number }>(
      `SELECT coalesce((valor)::text::int, $1) AS horas FROM core.parametro
        WHERE clave = 'umbral_sync_degradado_horas' AND effective_from <= now()
        ORDER BY effective_from DESC LIMIT 1`,
      [UMBRAL_DEFECTO_HORAS],
    );
    const horas = umbral.rows[0]?.horas ?? UMBRAL_DEFECTO_HORAS;
    const ultima = salud.rows[0]?.ultima ?? null;
    const ahora = app.ahora();
    const degradado = ultima !== null
      && ahora.getTime() - ultima.getTime() > horas * 3_600_000;

    return {
      sucursalId: nodo.rows[0]?.sucursal_id ?? null,
      versionEsquema: nodo.rows[0]?.version_esquema ?? null,
      versionBinario: nodo.rows[0]?.version_binario ?? null,
      ultimaSyncExitosa: ultima,
      derivaRelojSeg: salud.rows[0]?.deriva ?? null,
      outboxPendiente: Number(outbox.rows[0]!.pendiente),
      outboxAtascado: Number(outbox.rows[0]!.atascado),
      outboxMasAntiguoEn: outbox.rows[0]!.mas_antiguo,
      excepcionesAbiertas: excepciones,
      ultimaPasadaAplicador: aplicador.rows[0]?.ultima_pasada ?? null,
      degradado,
    };
  });

  app.get('/excepciones', { preHandler: exige() }, async () => {
    const { rows } = await app.db.query(
      `SELECT e.id, e.tipo, e.severidad, e.entidad, e.detalle,
              e.estado, e.creado_en AS "creadoEn",
              su.nombre AS sucursal
         FROM sync.excepcion e
         LEFT JOIN core.sucursal su ON su.id = e.sucursal_id
        WHERE e.estado IN ('abierta','en_proceso')
        ORDER BY array_position(ARRAY['critica','alta','media','baja'], e.severidad), e.creado_en`,
    );
    return rows;
  });

  // Disparo manual de un ciclo, SOLO para pruebas en vivo. En operación normal
  // el motor (`npm run sync`, servicio aparte) empuja el outbox solo; el FE no
  // dispara nada. Abre conexiones frescas a local y nube, hace push + pull, y
  // las cierra. Si la nube no responde, lo reporta sin tumbar nada.
  app.post('/ciclo', { preHandler: exige() }, async (req, reply) => {
    let node: Client | null = null;
    let cloud: Client | null = null;
    try {
      node = new Client({ ...resolveConnection('local').config, connectionTimeoutMillis: 5_000 });
      cloud = new Client({ ...resolveConnection('nube').config, connectionTimeoutMillis: 8_000 });
      await node.connect();
      await cloud.connect();

      const resPush = await push(node, cloud);
      const resPull = await pull(node, cloud);
      return { ok: true, push: resPush, pull: resPull };
    } catch (err) {
      req.log.error({ err }, 'ciclo de sync manual falló');
      return reply.status(200).send({
        ok: false,
        error: err instanceof Error ? `${err.message}` : String(err),
      });
    } finally {
      await node?.end().catch(() => { /* ya cerrado */ });
      await cloud?.end().catch(() => { /* ya cerrado */ });
    }
  });
}
