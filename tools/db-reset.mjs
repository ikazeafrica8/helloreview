// `pnpm db:reset` — drop everything, re-migrate, re-seed.
//
// DROPPING THE `drizzle` SCHEMA IS LOAD-BEARING. Drizzle records applied migrations in its own
// schema, separate from public. Drop only public and the ledger survives, so the next migrate sees
// every migration as already applied and reports success against a completely empty database. The
// symptom is a working reset that leaves you with no tables and no error.

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import { requireMigrationUrl, assertDisposable } from './db-target.mjs'

const ROOT = dirname(import.meta.dirname)

// GUARDED, because this is the most destructive command in the repo and the easiest to run by
// reflex. It drops every schema against whatever the environment points at — and this machine runs
// several project stacks whose .env files look alike. Until this guard existed, a test that merely
// CHECKED for the guard performed a real reset of the developer's database as a side effect.
//
// It refuses unless NODE_ENV is disposable AND the host is loopback. See tools/db-target.mjs.
const url = requireMigrationUrl('db:reset')
assertDisposable('db:reset', url)

const log = (message) => {
  process.stdout.write(`  ${message}\n`)
}

// packages/db must be compiled before its migrator can be imported.
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
  process.stderr.write(`\n  db:reset failed\n\n  packages/db does not compile:\n${build.stdout}${build.stderr}\n`)
  process.exit(1)
}

const client = new Client({ connectionString: url })
await client.connect()
try {
  await client.query('drop schema if exists public cascade')
  // The line that makes this a reset rather than a truncate.
  await client.query('drop schema if exists drizzle cascade')
  await client.query('create schema public')
  log('dropped public and drizzle, recreated public')
} finally {
  await client.end()
}

const { applyMigrations } = await import(
  // pathToFileURL, not the bare path: on Windows a dynamic import() of an absolute path fails with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME because the ESM loader reads "D:" as a URL scheme.
  pathToFileURL(join(ROOT, 'packages', 'db', 'dist', 'index.js')).href
)
await applyMigrations(url)
log('migrations applied')

// Seeding is its own script so `pnpm db:seed` and the reset path can never diverge.
const seed = spawnSync(process.execPath, [join(ROOT, 'tools', 'db-seed.mjs')], { encoding: 'utf8' })
process.stdout.write(seed.stdout ?? '')
if (seed.status !== 0) {
  process.stderr.write(seed.stderr ?? '')
  process.exit(1)
}

log('reset complete')
