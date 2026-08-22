// `pnpm db:generate -- <name>` — generate a migration, and actually fail when it fails.
//
// WHY THIS WRAPPER EXISTS. `drizzle-kit generate` EXITS 0 on failure: a schema file that will not
// compile, or an ambiguous rename that needs a TTY prompt it cannot show, both end with a zero exit
// and no migration written. An unguarded script therefore cannot fail a build, and the missing
// migration is discovered later by whoever runs migrate against a database that does not match.
//
// The wrapper asserts on what actually happened: no known failure marker in the output, and either
// a new migration file or an explicit "no changes".

import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = dirname(import.meta.dirname)
const DB = join(ROOT, 'packages', 'db')
const MIGRATIONS = join(DB, 'migrations')

const fail = (message) => {
  process.stderr.write(`\n  db:generate failed\n\n  ${message}\n\n`)
  process.exit(1)
}

const name = process.argv[2]
if (name === undefined || name.trim() === '' || name.startsWith('-')) {
  // Without --name drizzle-kit invents a tag like 0000_aspiring_angel, and a migration nobody can
  // identify from its filename is a migration nobody reviews.
  fail('A name is required:  pnpm db:generate <name>\n  e.g. pnpm db:generate add_campaigns')
}

const before = existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')) : []

const result = spawnSync(
  process.execPath,
  [join(DB, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'generate', '--name', name],
  { cwd: DB, encoding: 'utf8', env: process.env, timeout: 300_000 },
)

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
process.stdout.write(output)

if (result.status !== 0) fail(`drizzle-kit exited ${String(result.status)}`)

// The markers drizzle-kit prints while still exiting 0.
for (const marker of ['Interactive prompts require a TTY', 'Transform failed', 'error:', 'Error:']) {
  if (output.includes(marker)) {
    fail(
      `drizzle-kit reported "${marker}" but exited 0.\n` +
        '  A rename prompt needs a real terminal; express it as drop+add in a hand-written\n' +
        '  migration if you are not on one.',
    )
  }
}

const after = existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')) : []
const added = after.filter((f) => !before.includes(f))

if (added.length === 0) {
  // "No schema changes" is a legitimate outcome; silence is not.
  if (!/No schema changes/i.test(output)) {
    fail('drizzle-kit wrote no migration and did not report "No schema changes".')
  }
  process.stdout.write('\n  no schema changes — nothing to generate\n')
} else {
  process.stdout.write(`\n  wrote ${added.join(', ')}\n  Review the SQL before committing it.\n`)
}
