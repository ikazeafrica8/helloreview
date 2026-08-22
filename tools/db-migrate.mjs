// `pnpm db:migrate` — apply every pending migration.
//
// Runs the same programmatic migrator the test harness and a deployed process use, rather than
// drizzle-kit's CLI: one code path means a migration cannot behave differently in development than
// it does in CI or production.

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = dirname(import.meta.dirname)

const url = process.env.DATABASE_URL
if (url === undefined || url === '') {
  process.stderr.write('\n  db:migrate failed\n\n  DATABASE_URL is not set. Run `pnpm services:up` first.\n\n')
  process.exit(1)
}

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
