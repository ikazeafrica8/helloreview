// `pnpm db:migrate` — apply every pending migration.
//
// Runs the same programmatic migrator the test harness and a deployed process use, rather than
// drizzle-kit's CLI: one code path means a migration cannot behave differently in development than
// it does in CI or production.

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requireMigrationUrl } from './db-target.mjs'

const ROOT = dirname(import.meta.dirname)

// DATABASE_MIGRATION_URL, not DATABASE_URL: applying a migration is schema ownership work, and it
// is deliberately kept on a different variable from the one the api and worker connect with. There
// is NO disposable-environment guard here — unlike db:reset, migrating production is the whole
// point of the command.
const url = requireMigrationUrl('db:migrate')

const build = spawnSync(
  process.execPath,
  [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
  {
    cwd: join(ROOT, 'packages', 'db'),
    encoding: 'utf8',
    timeout: 300_000,
  },
)
if (build.status !== 0) {
  process.stderr.write(`\n  db:migrate failed\n\n  packages/db does not compile:\n${build.stdout}${build.stderr}\n`)
  process.exit(1)
}

const { applyMigrations } = await import(
  // pathToFileURL, not the bare path: on Windows a dynamic import() of an absolute path fails with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME because the ESM loader reads "D:" as a URL scheme.
  pathToFileURL(join(ROOT, 'packages', 'db', 'dist', 'index.js')).href
)
await applyMigrations(url)
process.stdout.write('  migrations applied\n')
