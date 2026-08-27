/**
 * CLI de migraciones.
 *
 *   npm run db:migrate                     aplica lo pendiente en LOCAL
 *   npm run db:migrate -- --target nube    aplica en Supabase
 *   npm run db:migrate -- --target ambos   aplica en las dos, local primero
 *   npm run db:migrate -- --dry            muestra el plan sin tocar nada
 *   npm run db:status -- --target nube     qué versión tiene esa base
 *
 * El destino SIEMPRE se imprime antes de actuar y nunca se infiere. Las mismas
 * migraciones van a las dos bases —esa es la razón de usar PostgreSQL local y no
 * SQLite— pero el orden importa: D-8 exige desplegar la nube antes que los nodos.
 *
 * La lógica reutilizable vive en `schema.ts`; aquí solo está la envoltura de línea
 * de comandos.
 */

import 'dotenv/config';
import { Client } from 'pg';
import { resolveConnection, targetFromArgs, type Target } from './connection.js';
import { applyAll, loadDir, LEDGER, MIGRATIONS_DIR, SEED_DIR } from './schema.js';

interface RunOptions {
  dryRun: boolean;
  statusOnly: boolean;
  withSeeds: boolean;
}

async function runOn(target: Target, opts: RunOptions): Promise<void> {
  const conn = resolveConnection(target);
  console.log(`\n=== ${target.toUpperCase()} · ${conn.describe} ===`);

  const client = new Client(conn.config);
  await client.connect();

  try {
    const v = await client.query<{ sv: string }>("SELECT current_setting('server_version') AS sv");
    console.log(`PostgreSQL ${v.rows[0]!.sv}`);

    await client.query(LEDGER);

    if (opts.statusOnly) {
      const { rows } = await client.query<{ version: string; applied_at: Date }>(
        'SELECT version, applied_at FROM public.schema_migration ORDER BY version',
      );
      console.log(`Versión de esquema: ${rows.at(-1)?.version ?? '(ninguna)'}`);
      for (const r of rows) console.log(`   ${r.version}  ${r.applied_at.toISOString()}`);
      return;
    }

    console.log('Migraciones:');
    const n = await applyAll(client, await loadDir(MIGRATIONS_DIR), { dryRun: opts.dryRun });

    if (opts.withSeeds) {
      console.log('Seeds:');
      await applyAll(client, await loadDir(SEED_DIR), { dryRun: opts.dryRun });
    }

    if (!opts.dryRun) console.log(`Listo. ${n} migración(es) aplicada(s) en ${target}.`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts: RunOptions = {
    dryRun: args.includes('--dry'),
    statusOnly: args.includes('--status'),
    withSeeds: !args.includes('--no-seed'),
  };

  const i = args.indexOf('--target');
  const raw = i >= 0 ? args[i + 1] : undefined;

  // `ambos` aplica local primero para que un error de SQL reviente contra la base
  // desechable de desarrollo y no contra la nube, que es compartida.
  const targets: Target[] = raw === 'ambos' ? ['local', 'nube'] : [targetFromArgs(args, 'local')];

  for (const t of targets) await runOn(t, opts);
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
