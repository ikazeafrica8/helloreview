// Which database the tooling talks to, and whether it is safe to destroy.
//
// Shared by db-migrate, db-reset and db-seed so the policy is written once. Three separate copies
// of "is this production?" is how one of them ends up subtly different from the others.
//
// WHY A SEPARATE VARIABLE FROM DATABASE_URL
//
// DATABASE_URL means "what the application connects as". DATABASE_MIGRATION_URL means "what owns
// the schema". They now hold DIFFERENT credentials: migration 0009 gave the api and worker a
// restricted role that cannot rewrite audit_logs, cannot create a table, and owns nothing, while
// this variable keeps the owner.
//
// The distinction was introduced earlier, deliberately, while the two values were still identical
// and the split was a no-op that could not break anything. That is why landing it was a one-line
// change to .env rather than a refactor of every tool under whatever pressure prompted it — and why
// the failure mode it would otherwise have had (a tool still reading DATABASE_URL, surfacing as
// "permission denied" halfway through a migration) never happened. A test asserts no
// schema-changing tool reads DATABASE_URL, and that this module has no fallback to it.

/**
 * Environments in which destroying the database is a normal thing to do.
 *
 * An ALLOW-LIST, not a check for "production". A deny-list that names only production reads
 * correctly, passes review, and does nothing whatsoever against NODE_ENV=staging — which is a real
 * database with real data in it. Anything not named here is treated as precious.
 */
const DISPOSABLE_ENVIRONMENTS = new Set(['development', 'test'])

/** Hosts that can only be this machine. A database reachable only over loopback is disposable. */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const fail = (command, message) => {
  process.stderr.write(`\n  ${command} refused\n\n  ${message}\n\n`)
  process.exit(1)
}

/**
 * The connection string for schema-changing work, or exit with a message naming the variable.
 *
 * Never echoes the value: a connection string carries a password, and a tool that prints one to
 * explain itself has turned a safety message into a credential leak (SPEC.md §21.4).
 */
export const requireMigrationUrl = (command) => {
  const url = process.env.DATABASE_MIGRATION_URL
  if (url === undefined || url === '') {
    fail(
      command,
      'DATABASE_MIGRATION_URL is not set.\n\n' +
        '  It is the credential that OWNS the schema, kept separate from DATABASE_URL, which is\n' +
        '  what the api and worker connect as. Run `pnpm services:up` to create .env from\n' +
        '  .env.example, or copy the key across if your .env predates it.',
    )
  }
  return url
}

/**
 * Refuse unless this database is one we are allowed to destroy.
 *
 * Two INDEPENDENT checks, because each catches what the other misses:
 *
 *   NODE_ENV is a claim. It is trivially wrong when a .env is copied between machines, or when a
 *   terminal still has variables exported from an earlier session — which is exactly the situation
 *   in which someone runs a reset by reflex.
 *
 *   The HOST is a fact. A database reachable only over loopback cannot be shared infrastructure.
 *
 * Requiring both means a mistake has to be made twice before anything is dropped.
 */
export const assertDisposable = (command, url) => {
  const environment = process.env.NODE_ENV ?? 'development'

  if (!DISPOSABLE_ENVIRONMENTS.has(environment)) {
    fail(
      command,
      `NODE_ENV is "${environment}", which is not a disposable environment.\n\n` +
        `  ${command} drops every schema and recreates them empty. It is permitted only when\n` +
        `  NODE_ENV is one of: ${[...DISPOSABLE_ENVIRONMENTS].join(', ')}.\n\n` +
        '  If this really is a throwaway database, set NODE_ENV=development for the command.',
    )
  }

  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    // Deliberately does not include the value: it carries a password.
    fail(command, 'DATABASE_MIGRATION_URL is not a valid URL.')
  }

  if (!LOCAL_HOSTNAMES.has(hostname)) {
    fail(
      command,
      `the database host "${hostname}" is not local.\n\n` +
        `  ${command} drops every schema and recreates them empty, so it is permitted only\n` +
        `  against a loopback address (${[...LOCAL_HOSTNAMES].join(', ')}).\n\n` +
        '  NODE_ENV says this is a development environment, but the host says otherwise — and a\n' +
        '  copied .env is the usual reason those two disagree. The host is believed.',
    )
  }
}
