// `pnpm db:backup` — take a restorable backup.
//
// TWO artifacts, always together. pg_dump captures a database — schema, data, ACLs and default
// privileges — but NOT roles, which live at the cluster level. Once the application has its own
// role, restoring from pg_dump alone into a fresh cluster fails on every GRANT because the grantee
// does not exist, and the reflex fix (`--no-owner --no-acl`) succeeds while silently discarding the
// entire permission model. You would have a working system with none of the protection and nothing
// on screen would say so.
//
// See docs/backup-and-restore.md.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { requireMigrationUrl } from './db-target.mjs'

const ROOT = dirname(import.meta.dirname)

const url = new URL(requireMigrationUrl('db:backup'))
const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
const user = decodeURIComponent(url.username)

/**
 * The container publishing this database, so the dump runs with the server's own tooling.
 *
 * Using `docker exec` rather than a host pg_dump avoids the version-skew failure — pg_dump refuses
 * to dump a server newer than itself, and a developer machine's client is routinely older than the
 * pinned server image.
 */
const CONTAINER = process.env.POSTGRES_CONTAINER ?? 'helloreview-postgres-1'

const fail = (message) => {
  process.stderr.write(`\n  db:backup failed\n\n  ${message}\n\n`)
  process.exit(1)
}

// A timestamp is passed in rather than derived where possible, but a backup genuinely is "now".
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(ROOT, 'backups', stamp)
mkdirSync(outDir, { recursive: true })

/** Run a dump inside the container and capture stdout as a Buffer (pg_dump -Fc is binary). */
const dump = (label, args) => {
  const result = spawnSync('docker', ['exec', CONTAINER, ...args], {
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 600_000,
  })
  if (result.error !== undefined) fail(`could not run docker: ${result.error.message}`)
  if (result.status !== 0) {
    // stderr may name the database and user but never the password — the URL is not passed to the
    // container, PGPASSWORD is not set, and the connection is local peer/trust inside the image.
    fail(`${label} exited ${String(result.status)}:\n\n${String(result.stderr)}`)
  }
  return result.stdout
}

const globals = dump('pg_dumpall --globals-only', ['pg_dumpall', '-U', user, '--globals-only'])
writeFileSync(join(outDir, 'globals.sql'), globals)

const data = dump('pg_dump -Fc', ['pg_dump', '-U', user, '-Fc', database])
writeFileSync(join(outDir, 'helloreview.dump'), data)

const size = (name) => {
  const bytes = statSync(join(outDir, name)).size
  return bytes < 1024 * 1024 ? `${String(Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

process.stdout.write(
  `  backup written to backups/${stamp}/\n` +
    `    globals.sql        ${size('globals.sql')}  (roles — restore FIRST)\n` +
    `    helloreview.dump   ${size('helloreview.dump')}  (schema, data, grants)\n\n` +
    '  These contain participant data. backups/ is gitignored; keep copies off this machine.\n' +
    '  Restore procedure: docs/backup-and-restore.md\n',
)
