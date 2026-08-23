// Integration tier: the destructive-tooling guards (Commit A of the least-privilege plan).
//
// `pnpm db:reset` runs `DROP SCHEMA public CASCADE` against whatever DATABASE_URL happens to point
// at, with no environment check and no confirmation. On any realistic timeline that is the single
// most likely destructive event in this project — more likely than the audit-log tampering the
// role split addresses — because it is one tab away from the command a developer runs twenty times
// a day, and because this machine runs several project stacks whose .env files look alike.
//
// These tests spawn the real scripts with a hostile environment and assert they REFUSE. They
// deliberately do not assert on a successful reset: a test that proves the guard lets a real drop
// through would have to perform a real drop, and the happy path is already covered by every other
// integration test needing a migrated database.
//
// The second group covers the DATABASE_MIGRATION_URL split. Today its value is identical to
// DATABASE_URL, so nothing behaves differently — that is the point. It is introduced now, while it
// is a no-op and cannot break anything, so that the later privilege change is one .env line rather
// than a refactor performed under pressure.

import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))

const readText = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8')

const parseEnv = (text) => {
  const out = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return out
}

/**
 * Run a tool with an explicit environment.
 *
 * The parent environment is deliberately NOT inherited: these tests are about what the script does
 * with a specific set of variables, and a stray DATABASE_URL from the developer's shell would make
 * the result depend on who ran it.
 */
const runTool = (tool, env) =>
  spawnSync(process.execPath, [join(ROOT, 'tools', tool)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  })

const EXAMPLE = () => parseEnv(readText('.env.example'))

describe('db:reset refuses to run anywhere but development', () => {
  test('a production NODE_ENV is refused', () => {
    // The failure this prevents: DATABASE_URL pointing at something real, either because .env was
    // copied from a deployment or because a terminal still had production variables exported.
    const result = runTool('db-reset.mjs', {
      NODE_ENV: 'production',
      DATABASE_URL: EXAMPLE().get('DATABASE_URL'),
      DATABASE_MIGRATION_URL: EXAMPLE().get('DATABASE_MIGRATION_URL'),
    })

    assert.notEqual(result.status, 0, `db:reset must refuse to run with NODE_ENV=production:\n${result.stdout}`)
    assert.match(
      `${result.stdout}${result.stderr}`,
      /production/i,
      'the refusal must name the environment, or the reason is guesswork',
    )
  })

  test('staging is refused too — the guard is an allow-list, not a production block', () => {
    // A deny-list that names only "production" is the version of this guard that fails: it passes
    // review, reads correctly, and does nothing at all against NODE_ENV=staging.
    const result = runTool('db-reset.mjs', {
      NODE_ENV: 'staging',
      DATABASE_URL: EXAMPLE().get('DATABASE_URL'),
      DATABASE_MIGRATION_URL: EXAMPLE().get('DATABASE_MIGRATION_URL'),
    })

    assert.notEqual(result.status, 0, `db:reset must refuse any environment it does not recognise:\n${result.stdout}`)
  })

  test('a remote host is refused even when NODE_ENV says development', () => {
    // NODE_ENV is a claim, not a fact. It is trivially wrong when a .env is copied between
    // machines, so the host is checked independently: a loopback address is the thing that
    // actually makes a database disposable.
    const result = runTool('db-reset.mjs', {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://helloreview:pw@db.production.example.com:5432/helloreview',
      DATABASE_MIGRATION_URL: 'postgres://helloreview:pw@db.production.example.com:5432/helloreview',
    })

    assert.notEqual(result.status, 0, `db:reset must refuse a non-local host:\n${result.stdout}${result.stderr}`)
    assert.match(
      `${result.stdout}${result.stderr}`,
      /local|loopback|127\.0\.0\.1/i,
      'the refusal must explain that the host is not local',
    )
  })

  test('the refusal never echoes the password', () => {
    // A guard that prints the connection string to explain itself has turned a safety feature into
    // a credential leak — the same defect the preflight script had (SPEC.md §21.4).
    const secret = 'sup3rsecret_pw'
    const result = runTool('db-reset.mjs', {
      NODE_ENV: 'production',
      DATABASE_URL: `postgres://helloreview:${secret}@db.production.example.com:5432/helloreview`,
      DATABASE_MIGRATION_URL: `postgres://helloreview:${secret}@db.production.example.com:5432/helloreview`,
    })

    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), 'the refusal message leaked the database password')
  })
})

describe('DATABASE_MIGRATION_URL', () => {
  test('.env.example declares it', () => {
    const env = EXAMPLE()
    assert.ok(env.has('DATABASE_MIGRATION_URL'), '.env.example must declare DATABASE_MIGRATION_URL')
    assert.notEqual(env.get('DATABASE_MIGRATION_URL'), '', '.env.example gives no value for DATABASE_MIGRATION_URL')
  })

  test('it is NO LONGER identical to DATABASE_URL — the privilege split has landed', () => {
    // Commit A asserted the opposite, on purpose: introducing DATABASE_MIGRATION_URL as a byte-
    // identical no-op meant nothing could break, and the equality assertion was left as the thing
    // that would fail to announce the split. This is that update. Reverting the two to the same
    // value would put the application back to owning every table it writes to.
    const env = EXAMPLE()
    assert.notEqual(
      env.get('DATABASE_MIGRATION_URL'),
      env.get('DATABASE_URL'),
      'The application must not connect with the owner credential. The owner can always run ' +
        'ALTER TABLE audit_logs DISABLE TRIGGER ALL and then DELETE, whatever migration 0009 revokes.',
    )

    // And specifically: it must carry the role db:provision-role creates, or the app cannot log in.
    const appUrl = new URL(env.get('DATABASE_URL') ?? '')
    assert.equal(
      decodeURIComponent(appUrl.username),
      env.get('APP_DB_USER'),
      'DATABASE_URL must connect as APP_DB_USER — the role tools/db-provision-role.mjs provisions',
    )
    assert.equal(
      decodeURIComponent(appUrl.password),
      env.get('APP_DB_PASSWORD'),
      'DATABASE_URL must carry APP_DB_PASSWORD — the password db:provision-role sets on every run',
    )

    // The owner's username must differ from the app's. Comparing the whole URLs above would pass
    // for two URLs that differ only in password while sharing a username, which is the same role.
    const ownerUrl = new URL(env.get('DATABASE_MIGRATION_URL') ?? '')
    assert.notEqual(
      decodeURIComponent(appUrl.username),
      decodeURIComponent(ownerUrl.username),
      'the application and the schema owner must be different roles, not one role with two passwords',
    )
  })

  test('no schema-changing tool reads the application credential', () => {
    // This is the property that makes the later split a one-line change. If a tool still reads
    // DATABASE_URL, then on the day the app role loses DDL rights that tool breaks, and it breaks
    // as "permission denied" during a migration, which is the worst time to discover it.
    //
    // Asserted as an ABSENCE plus a route, rather than as the presence of a literal string: the
    // tools resolve the URL through tools/db-target.mjs, and an assertion that demanded the literal
    // would be pushing them back towards three copies of the policy.
    // db-provision-role.mjs is in this list because it is the tool that CREATES the application's
    // credential. If it ever connected with that credential it could not create it, and the failure
    // would be a chicken-and-egg that only shows up on a fresh database.
    for (const tool of ['db-migrate.mjs', 'db-reset.mjs', 'db-seed.mjs', 'db-provision-role.mjs']) {
      const source = readText(`tools/${tool}`)
      assert.ok(
        !/process\.env\.DATABASE_URL/.test(source),
        `tools/${tool} performs schema or data changes, so it must not read the application's credential`,
      )
      assert.match(
        source,
        /requireMigrationUrl|DATABASE_MIGRATION_URL/,
        `tools/${tool} must resolve its connection through the migration URL`,
      )
    }

    // db-target.mjs is the one place the variable is actually read.
    const target = readText('tools/db-target.mjs')
    assert.match(target, /DATABASE_MIGRATION_URL/, 'tools/db-target.mjs must read DATABASE_MIGRATION_URL')
    assert.ok(
      !/process\.env\.DATABASE_URL/.test(target),
      'tools/db-target.mjs must not fall back to the application credential — a fallback would make ' +
        'the split silently ineffective on any machine whose .env predates it',
    )

    assert.match(
      readText('packages/db/drizzle.config.ts'),
      /DATABASE_MIGRATION_URL/,
      'drizzle.config.ts drives db:studio and drizzle-kit, which both need owner rights',
    )
  })

  test('the tools fail with a clear message when the migration URL is absent', () => {
    const result = runTool('db-migrate.mjs', { NODE_ENV: 'development' })

    assert.notEqual(result.status, 0, 'db:migrate must fail when it has no connection string')
    assert.match(
      `${result.stdout}${result.stderr}`,
      /DATABASE_MIGRATION_URL/,
      'the error must name the variable that is missing',
    )
  })
})
