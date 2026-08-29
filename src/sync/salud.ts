/**
 * Tablero de diagnóstico remoto de una terminal.
 *
 * Blueprint v0.2 · docs/architecture/01-sincronizacion.md §3.3
 *                  docs/architecture/01b-consistencia-asientos.md §4
 *                  docs/architecture/04-riesgos-roadmap.md §2 (R2, R5)
 *
 * POR QUÉ ESTO EXISTE:
 * Las sucursales están a 3-6 horas y solo se llega a ellas por TeamViewer en la
 * madrugada. Sin un reporte que suba solo, que una terminal lleve 40 h sin subir
 * ventas —o sin respaldar, o con el reloj media hora corrido— se descubre en el
 * corte de mes, cuando ya no hay tickets en papel para reconstruir nada.
 *
 * `medirSalud` arma la foto local; `reportarSalud` la sube a la nube. La medición
 * local NUNCA depende de que la nube responda: una terminal sin internet es
 * exactamente la que más necesita el diagnóstico.
 */

import type { Client } from 'pg';

export type Severidad = 'critica' | 'alta' | 'media' | 'baja';

/**
 * Clasificación de la deriva de reloj contra la nube (01b §4).
 *
 * La "zona muerta" es el margen dentro del cual el modelo de cupos disjuntos
 * tolera relojes desalineados sin que dos sucursales puedan vender el mismo
 * asiento. Fuera de ella, la garantía deja de sostenerse.
 */
export type ClaseDeriva = 'ok' | 'alerta' | 'degradado' | 'fuera_de_zona_muerta';

export interface Salud {
  sucursalId: string | null;
  /** Última subida Y bajada exitosas. `null` si nunca hubo. Alimenta el stale-guard. */
  ultimaSyncExitosa: Date | null;
  /** Lo que todavía puede subir solo. */
  outboxPendiente: number;
  /**
   * Lo que YA NO va a subir sin intervención: filas rechazadas o con demasiados
   * intentos. Para el operador, "1 pendiente" durante tres días es idéntico a
   * "todavía subiendo" — separarlo es el punto 3 de la mitigación de R2.
   */
  outboxAtascado: number;
  /** Antigüedad de lo más viejo sin subir. Es la medida real de exposición. */
  outboxMasAntiguoEn: Date | null;
  /** Diferencia de reloj de pared contra la nube, en segundos. Positivo = nodo adelantado. */
  derivaRelojSeg: number | null;
  claseDeriva: ClaseDeriva;
  versionEsquema: string | null;
  versionBinario: string | null;
  ultimoRespaldoEn: Date | null;
  excepcionesAbiertas: Record<Severidad, number>;
  ultimoChecksum: { dia: string; coincide: boolean } | null;
  /**
   * Última pasada del aplicador de configuración (03 §3.3). Un aplicador detenido
   * es tan grave como un sync detenido: una baja de usuario programada nunca
   * surtiría efecto.
   */
  ultimaPasadaAplicador: Date | null;
  /** >72 h sin sync: banner de degradación y bloqueo de primer login (03 §1.5). */
  degradado: boolean;
}

export interface SaludOptions {
  /** Reloj inyectable: probar "72 h sin sync" no puede exigir esperar tres días. */
  ahora?: () => Date;
}

/** 72 h — SUPUESTO S9. Igual que el stale-guard del motor. */
const DEGRADADO_TRAS_MS = 72 * 60 * 60 * 1000;

/**
 * Umbral de "atascado" del outbox. Una fila que lleva 5 intentos ya no está
 * "subiendo": algo la rechaza y va a seguir rechazándola.
 */
const OUTBOX_ATASCADO_INTENTOS = 5;

const SEVERIDADES: readonly Severidad[] = ['critica', 'alta', 'media', 'baja'];

/**
 * Umbrales de deriva de 01b §4. Puro, para poder probarlo sin red:
 *   |d| <=  2 min -> 'ok'
 *   |d| <=  5 min -> 'alerta'
 *   |d| <= 15 min -> 'degradado'             (exige conexión cerca de expirar el cupo)
 *   |d| >  15 min -> 'fuera_de_zona_muerta'  (la zona muerta ya no protege)
 */
export function clasificarDeriva(segundos: number): ClaseDeriva {
  const d = Math.abs(segundos);
  if (d <= 2 * 60) return 'ok';
  if (d <= 5 * 60) return 'alerta';
  if (d <= 15 * 60) return 'degradado';
  return 'fuera_de_zona_muerta';
}

/**
 * Diferencia de reloj de pared entre el nodo y la nube, en segundos.
 *
 * Se pide la hora a las DOS bases y se descuenta la latencia de ida y vuelta a
 * la mitad: sin eso, un enlace lento se leería como deriva y dispararía falsas
 * alarmas justo cuando la conexión ya es mala.
 */
export async function medirDeriva(node: Client, cloud: Client): Promise<number> {
  const t0 = Date.now();
  const { rows: nodoRows } = await node.query<{ ahora: Date }>('SELECT clock_timestamp() AS ahora');
  const { rows: nubeRows } = await cloud.query<{ ahora: Date }>('SELECT clock_timestamp() AS ahora');
  const t1 = Date.now();

  const mitadLatenciaMs = (t1 - t0) / 2;
  const nodoMs = nodoRows[0]!.ahora.getTime();
  const nubeMs = nubeRows[0]!.ahora.getTime() + mitadLatenciaMs;
  return Math.round((nodoMs - nubeMs) / 1000);
}

/**
 * Deja registrada la deriva medida y, si se salió de la zona muerta, abre una
 * excepción `deriva_reloj`.
 *
 * NTP corrige el reloj del sistema operativo, no el HLC ni el juicio del
 * operador: una terminal con la BIOS corrida una hora hay que verla en el
 * tablero, no descubrirla arbitrando un conflicto de asiento a ciegas (R5).
 *
 * Deduplica contra excepciones abiertas del mismo tipo: un ciclo cada pocos
 * minutos contra un reloj que no se ha tocado ahogaría la cola.
 */
export async function registrarDeriva(node: Client, derivaSeg: number): Promise<void> {
  await node.query(
    `INSERT INTO sync.salud (sucursal_id, deriva_reloj_seg, reportado_en)
     VALUES (sync.sucursal_local(), $1, now())
     ON CONFLICT (sucursal_id) DO UPDATE
        SET deriva_reloj_seg = EXCLUDED.deriva_reloj_seg, reportado_en = now()`,
    [derivaSeg],
  );

  if (clasificarDeriva(derivaSeg) !== 'fuera_de_zona_muerta') return;

  const { rows } = await node.query<{ n: string }>(
    `SELECT count(*) AS n FROM sync.excepcion
      WHERE tipo = 'deriva_reloj' AND estado = 'abierta'
        AND sucursal_id = sync.sucursal_local()`,
  );
  if (Number(rows[0]!.n) > 0) return;

  await node.query(
    `INSERT INTO sync.excepcion (tipo, severidad, sucursal_id, detalle)
     VALUES ('deriva_reloj', 'alta', sync.sucursal_local(), $1::jsonb)`,
    [JSON.stringify({ deriva_seg: derivaSeg, clase: 'fuera_de_zona_muerta' })],
  );
}

/**
 * Foto de salud del nodo, calculada SOLO con datos locales.
 *
 * Nada de esto toca la nube: una terminal sin internet debe poder reportar su
 * estado en cuanto se reconecte, no quedarse muda porque la medición fallaba.
 */
export async function medirSalud(node: Client, opts: SaludOptions = {}): Promise<Salud> {
  const ahora = opts.ahora?.() ?? new Date();

  const { rows: nodoRows } = await node.query<{
    sucursal_id: string | null; version_esquema: string | null; version_binario: string | null;
  }>(
    `SELECT n.sucursal_id,
            coalesce(n.version_esquema,
              (SELECT max(version) FROM public.schema_migration)) AS version_esquema,
            n.version_binario
       FROM sync.nodo n WHERE n.singleton`,
  );
  const nodo = nodoRows[0] ?? { sucursal_id: null, version_esquema: null, version_binario: null };

  const { rows: saludRows } = await node.query<{ ultima: Date | null; deriva: number | null }>(
    `SELECT ultima_sync_exitosa AS ultima, deriva_reloj_seg AS deriva
       FROM sync.salud WHERE sucursal_id = sync.sucursal_local()`,
  );
  const ultimaSyncExitosa = saludRows[0]?.ultima ?? null;
  const derivaRelojSeg = saludRows[0]?.deriva ?? null;

  const { rows: outboxRows } = await node.query<{
    pendiente: string; atascado: string; mas_antiguo: Date | null;
  }>(
    `SELECT count(*) FILTER (
              WHERE estado <> 'confirmado'
                AND estado <> 'rechazado'
                AND intentos < $1)                                  AS pendiente,
            count(*) FILTER (
              WHERE estado <> 'confirmado'
                AND (estado = 'rechazado' OR intentos >= $1))       AS atascado,
            min(creado_en) FILTER (WHERE estado <> 'confirmado')    AS mas_antiguo
       FROM sync.outbox`,
    [OUTBOX_ATASCADO_INTENTOS],
  );
  const ob = outboxRows[0]!;

  const { rows: excRows } = await node.query<{ severidad: Severidad; n: string }>(
    `SELECT severidad, count(*) AS n FROM sync.excepcion
      WHERE estado = 'abierta' GROUP BY severidad`,
  );
  const excepcionesAbiertas = Object.fromEntries(
    SEVERIDADES.map((s) => [s, 0]),
  ) as Record<Severidad, number>;
  for (const r of excRows) excepcionesAbiertas[r.severidad] = Number(r.n);

  const { rows: respRows } = await node.query<{ creado_en: Date }>(
    `SELECT creado_en FROM sync.respaldo ORDER BY creado_en DESC LIMIT 1`,
  );
  const ultimoRespaldoEn = respRows[0]?.creado_en ?? null;

  const { rows: chkRows } = await node.query<{ dia: string; coincide: boolean }>(
    `SELECT to_char(dia, 'YYYY-MM-DD') AS dia, coincide
       FROM sync.checksum_bloque
      WHERE sucursal_id = sync.sucursal_local()
      ORDER BY dia DESC, calculado_en DESC LIMIT 1`,
  );
  const ultimoChecksum = chkRows[0]
    ? { dia: chkRows[0].dia, coincide: chkRows[0].coincide }
    : null;

  const { rows: aplRows } = await node.query<{ ultima: Date | null }>(
    `SELECT ultima_pasada AS ultima FROM sync.config_aplicado WHERE singleton`,
  );
  const ultimaPasadaAplicador = aplRows[0]?.ultima ?? null;

  // Un nodo que NUNCA sincronizó (recién instalado) no está degradado: está
  // empezando, no atrasado.
  const degradado =
    ultimaSyncExitosa !== null &&
    ahora.getTime() - ultimaSyncExitosa.getTime() > DEGRADADO_TRAS_MS;

  return {
    sucursalId: nodo.sucursal_id,
    ultimaSyncExitosa,
    outboxPendiente: Number(ob.pendiente),
    outboxAtascado: Number(ob.atascado),
    outboxMasAntiguoEn: ob.mas_antiguo ?? null,
    derivaRelojSeg,
    claseDeriva: derivaRelojSeg === null ? 'ok' : clasificarDeriva(derivaRelojSeg),
    versionEsquema: nodo.version_esquema,
    versionBinario: nodo.version_binario,
    ultimoRespaldoEn,
    excepcionesAbiertas,
    ultimoChecksum,
    ultimaPasadaAplicador,
    degradado,
  };
}

/**
 * Registra un respaldo local recién hecho. Lo llama `src/backup/run.ts`.
 */
export async function registrarRespaldo(
  node: Client,
  r: { archivo: string; bytes: number; versionEsquema?: string | null },
): Promise<void> {
  await node.query(
    `INSERT INTO sync.respaldo (sucursal_id, archivo, bytes, version_esquema)
     VALUES (sync.sucursal_local(), $1, $2, $3)`,
    [r.archivo, r.bytes, r.versionEsquema ?? null],
  );
}

/**
 * Mide la salud local y la sube a `sync.salud` de la nube.
 *
 * El orden importa: primero se mide la deriva y se persiste LOCALMENTE (incluida
 * la excepción si se salió de la zona muerta), y solo después se intenta subir.
 * Si la nube está caída, la medición local ya quedó guardada y el reporte se
 * completará en el siguiente ciclo — nunca se pierde por un fallo de red.
 */
export async function reportarSalud(node: Client, cloud: Client): Promise<void> {
  try {
    const deriva = await medirDeriva(node, cloud);
    await registrarDeriva(node, deriva);
  } catch {
    // La nube no respondió para medir la deriva: se sigue con lo demás.
  }

  const salud = await medirSalud(node);

  try {
    await cloud.query(
      `INSERT INTO sync.salud (sucursal_id, ultima_sync_exitosa, outbox_pendiente,
                               deriva_reloj_seg, version_esquema, version_binario,
                               ultimo_respaldo_en, excepciones_criticas, reportado_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (sucursal_id) DO UPDATE
          SET ultima_sync_exitosa = EXCLUDED.ultima_sync_exitosa,
              outbox_pendiente    = EXCLUDED.outbox_pendiente,
              deriva_reloj_seg    = EXCLUDED.deriva_reloj_seg,
              version_esquema     = EXCLUDED.version_esquema,
              version_binario     = EXCLUDED.version_binario,
              ultimo_respaldo_en  = EXCLUDED.ultimo_respaldo_en,
              excepciones_criticas = EXCLUDED.excepciones_criticas,
              reportado_en        = now()`,
      [
        salud.sucursalId,
        salud.ultimaSyncExitosa,
        salud.outboxPendiente + salud.outboxAtascado,
        salud.derivaRelojSeg,
        salud.versionEsquema,
        salud.versionBinario,
        salud.ultimoRespaldoEn,
        salud.excepcionesAbiertas.critica,
      ],
    );
  } catch {
    // La salud es observabilidad, no operación: un fallo al subirla no puede
    // tumbar nada. El siguiente ciclo lo reintenta.
  }
}
