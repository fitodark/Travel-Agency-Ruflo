/**
 * Resolución de conexiones por destino.
 *
 * Blueprint v0.2 · docs/architecture/blueprint.md §6
 *
 * El sistema tiene DOS bases con roles distintos y no intercambiables:
 *
 *   local  — PostgreSQL en la PC de la terminal. Es donde se vende, incluso sin
 *            internet, y es lo único que hay que respaldar (D-2).
 *   nube   — Supabase. Es el maestro replicado y el contrato para el sistema externo.
 *
 * Antes de este módulo todo leía `DATABASE_URL` a ciegas. Cuando esa variable pasó a
 * apuntar a Supabase, el respaldo habría empezado a respaldar la nube en silencio —
 * dejando el disco de la sucursal, que es exactamente el riesgo R2, sin ninguna copia.
 * Por eso el destino se declara explícitamente y nunca se infiere.
 */

import type { ClientConfig } from 'pg';

export type Target = 'local' | 'nube';

export const TARGETS: readonly Target[] = ['local', 'nube'];

const ENV_VAR: Record<Target, string> = {
  local: 'LOCAL_DATABASE_URL',
  nube: 'DATABASE_URL',
};

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

/**
 * ¿Este host necesita TLS?
 *
 * Los proveedores gestionados lo exigen; un PostgreSQL en `localhost` normalmente no lo
 * tiene configurado y forzarlo rompería la conexión de la terminal.
 */
export function needsSsl(url: string): boolean {
  const u = new URL(url);
  if (u.searchParams.get('sslmode') === 'disable') return false;
  if (u.searchParams.get('sslmode') === 'require') return true;
  return /supabase|neon|render|amazonaws|azure|googleapis/i.test(u.hostname);
}

/** ¿La URL apunta al pooler de transacciones de Supabase (pgbouncer)? */
export function isTransactionPooler(url: string): boolean {
  const u = new URL(url);
  return u.searchParams.get('pgbouncer') === 'true' || u.port === '6543';
}

export interface Connection {
  target: Target;
  url: string;
  config: ClientConfig;
  /** Host y base, sin credenciales. Para imprimir en logs. */
  describe: string;
}

export function resolveConnection(target: Target, env: NodeJS.ProcessEnv = process.env): Connection {
  const name = ENV_VAR[target];
  const url = env[name];
  if (!url) {
    throw new Error(
      `Falta ${name} para el destino "${target}". ` +
        `Revisa el archivo .env: local usa ${ENV_VAR.local} y nube usa ${ENV_VAR.nube}.`,
    );
  }

  return { target, url, ...conexionDesdeUrl(url) };
}

/**
 * El `ClientConfig` (SSL, pooler) y el `describe` para una URL cualquiera.
 *
 * Lo usa `resolveConnection` y también la consola de administración, que se
 * conecta a la nube con un rol acotado (`ADMIN_DATABASE_URL` → `donaji_consola`)
 * en vez del rol de `DATABASE_URL`.
 */
export function conexionDesdeUrl(url: string): { config: ClientConfig; describe: string } {
  const u = new URL(url);
  const config: ClientConfig = { connectionString: url };

  if (needsSsl(url)) {
    config.ssl = { rejectUnauthorized: false };
  }
  if (isTransactionPooler(url)) {
    config.statement_timeout = undefined;
    config.query_timeout = undefined;
  }

  return { config, describe: `${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}` };
}

/**
 * Lee `--target` de los argumentos.
 *
 * Sin valor por defecto implícito para operaciones destructivas: cada CLI declara el
 * suyo y lo imprime, para que nunca haya duda de contra qué base se está actuando.
 */
export function targetFromArgs(args: string[], fallback: Target): Target {
  const i = args.indexOf('--target');
  const raw = i >= 0 ? args[i + 1] : undefined;
  if (!raw) return fallback;
  if (!isTarget(raw)) {
    throw new Error(`Destino inválido: "${raw}". Usa ${TARGETS.join(' o ')}.`);
  }
  return raw;
}
