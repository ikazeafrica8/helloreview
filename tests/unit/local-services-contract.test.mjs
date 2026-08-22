// Local service stack contract for T3.
//
// Deliberately runs WITHOUT Docker: it asserts properties of the compose file and the environment
// template, so it stays fast and works in CI without a daemon. That the stack actually comes up
// healthy is a separate manual verification recorded in tasks/todo.md.
//
// The properties below are the ones whose absence is silent. A missing healthcheck, a 0.0.0.0
// port binding, or a bucket left publicly readable all produce a stack that looks fine.

import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = dirname(dirname(import.meta.dirname))
const COMPOSE_PATH = join(ROOT, 'infra', 'docker-compose.yml')

const readText = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8')
const readJson = (relativePath) => JSON.parse(readText(relativePath))

const compose = () => readFileSync(COMPOSE_PATH, 'utf8')

/**
 * The compose file with comment lines removed. Several assertions below look for the absence of a
 * string, and the comments deliberately name the wrong approaches in order to warn against them —
 * so an assertion run over the raw text matches the documentation rather than the configuration.
 */
const composeWithoutComments = () =>
  compose()
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

/** KEY=VALUE reader. No export, no interpolation — .env.example is deliberately that simple. */
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

describe('local service stack', () => {
  test('the compose file exists', () => {
    assert.ok(existsSync(COMPOSE_PATH), 'infra/docker-compose.yml is missing')
  })

  test('the project is named, so it cannot collide with another stack on this machine', () => {
    const text = compose()
    // Without an explicit name Compose derives the project from the directory — "infra" — which
    // is both meaningless and a collision risk on a machine running several stacks.
    assert.match(text, /^name:\s*helloreview\s*$/m, 'compose must declare `name: helloreview`')
    // The top-level version key has been obsolete for years and current Compose warns about it.
    assert.ok(!/^version:/m.test(text), 'the top-level `version:` key is obsolete; remove it')
  })

  test('every service is present', () => {
    const text = compose()
    for (const service of ['postgres:', 'redis:', 'minio:', 'minio-init:']) {
      assert.match(text, new RegExp(`^\\s{2}${service}`, 'm'), `service ${service} is missing`)
    }
  })

  test('every image is pinned by digest, not just by tag', () => {
    const images = [...compose().matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1])
    assert.ok(images.length >= 3, `expected at least 3 images, found ${images.length}`)
    for (const image of images) {
      // A tag is mutable. The digest is what makes a run reproducible, and it is what T7's
      // Testcontainers helper should reuse verbatim.
      assert.match(image, /@sha256:[0-9a-f]{64}$/, `image "${image}" is not pinned by digest`)
    }
  })

  test('every long-running service has a healthcheck', () => {
    const text = compose()
    // `services:up` asserts health via `--wait`, and --wait can only wait on services that
    // actually declare a healthcheck. None of these three images ships one by default.
    const healthchecks = text.match(/^\s*healthcheck:/gm) ?? []
    assert.equal(healthchecks.length, 3, 'postgres, redis and minio must each declare a healthcheck')
  })

  test('the MinIO healthcheck does not use a binary the image lacks', () => {
    // Verified against the pinned image: it ships curl and mc, but no wget, nc, grep, sed or awk.
    // The near-universal `wget --spider /minio/health/live` snippet therefore leaves the container
    // permanently unhealthy.
    const text = composeWithoutComments()
    const minioBlock = text.slice(text.indexOf('  minio:'), text.indexOf('  minio-init:'))
    assert.ok(!/wget|nc /.test(minioBlock), 'the MinIO image has no wget and no nc; use `mc ready local`')
    assert.match(minioBlock, /mc["',\s]+ready/, 'expected the `mc ready local` healthcheck')
  })

  test('every published port binds to loopback only', () => {
    // Either quote style — YAML accepts both and Prettier normalizes to single.
    const ports = [...compose().matchAll(/^\s*-\s*["']([^"']*:\d+)["']/gm)].map((m) => m[1])
    assert.ok(ports.length >= 4, `expected at least 4 published ports, found ${ports.length}`)
    for (const port of ports) {
      // The bare "5432:5432" shorthand binds 0.0.0.0, and Docker Desktop opens the Windows
      // firewall for it — which would put a PII-bearing dev database on whatever network the
      // laptop joins (PRD §21.3).
      assert.match(port, /^127\.0\.0\.1:/, `port mapping "${port}" must bind 127.0.0.1 explicitly`)
    }
  })

  test('data lives in named volumes, never a bind mount into the repo', () => {
    const text = compose()
    assert.match(text, /^volumes:/m, 'named volumes must be declared')
    // A bind mount under the repo is slow on Windows, exposed to antivirus, and one
    // `git clean -xfd` away from deletion.
    assert.ok(!/\.\/(infra\/)?data/.test(text), 'no bind mount into the repo; use named volumes')
  })

  test('the bucket is made private AND proven private', () => {
    const text = compose()
    // PRD §21.3: no publicly readable file buckets.
    assert.match(text, /mc anonymous set none/, 'the init service must set the bucket policy to none')
    // Setting a policy is not evidence. The init must verify and fail the container, which is
    // what makes `pnpm services:up` go red rather than silently serving a public bucket.
    assert.match(text, /mc anonymous get/, 'the init service must read the policy back')
    assert.match(text, /exit 1/, 'a non-private bucket must fail the init container')
  })

  test('bucket creation is idempotent across restarts', () => {
    const text = compose()
    // A bare `mc mb` exits 1 on an existing bucket and would break `set -eu` on every re-run.
    assert.match(text, /mc mb --ignore-existing/, 'use `mc mb --ignore-existing`')
  })

  test('.env.example declares every variable the stack needs', () => {
    assert.ok(existsSync(join(ROOT, '.env.example')), '.env.example is missing')
    const env = parseEnv(readText('.env.example'))
    const required = [
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'POSTGRES_DB',
      'POSTGRES_PORT',
      'REDIS_PASSWORD',
      'REDIS_PORT',
      'MINIO_ROOT_USER',
      'MINIO_ROOT_PASSWORD',
      'MINIO_PORT',
      'MINIO_CONSOLE_PORT',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_ENDPOINT',
      'DATABASE_URL',
      'REDIS_URL',
    ]
    for (const key of required) {
      assert.ok(env.has(key), `.env.example is missing ${key}`)
      assert.notEqual(env.get(key), '', `.env.example gives no value for ${key}`)
    }
  })

  test('.env.example ports avoid the defaults, which collide on a multi-project machine', () => {
    const env = parseEnv(readText('.env.example'))
    const defaults = { POSTGRES_PORT: '5432', REDIS_PORT: '6379', MINIO_PORT: '9000', MINIO_CONSOLE_PORT: '9001' }
    for (const [key, standard] of Object.entries(defaults)) {
      assert.notEqual(
        env.get(key),
        standard,
        `${key} must not default to ${standard}: two containers cannot bind one host port, and ` +
          'this machine already runs another stack on the standard ports',
      )
    }
  })

  test('S3_ACCESS_KEY_ID respects the length MinIO enforces', () => {
    // MinIO rejects an access key outside 3–20 characters, and it does so only when the init
    // container calls `mc admin user svcacct add` — so an over-long key passes every static check
    // and then fails `pnpm services:up`. Regression test for exactly that.
    const key = parseEnv(readText('.env.example')).get('S3_ACCESS_KEY_ID') ?? ''
    assert.ok(key.length >= 3 && key.length <= 20, `S3_ACCESS_KEY_ID is ${key.length} characters; MinIO requires 3–20`)
  })

  test('the committed environment template carries no real secret', () => {
    const env = parseEnv(readText('.env.example'))
    // SPEC.md §8 Never: commit secrets. Placeholder values must be obviously local-only.
    for (const key of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'S3_SECRET_ACCESS_KEY']) {
      const value = env.get(key) ?? ''
      assert.match(
        value,
        /local|dev|example|placeholder|changeme/i,
        `${key} must be an obvious local-only placeholder, not a credential that could be mistaken for real`,
      )
    }
  })

  test('.env is ignored but .env.example is committed', () => {
    const gitignore = readText('.gitignore')
    assert.match(gitignore, /^\.env$/m, '.env must be ignored')
    assert.match(gitignore, /^!\.env\.example$/m, '.env.example must be re-included')
  })

  test('the service commands exist and behave as SPEC.md §4 describes', () => {
    const { scripts = {} } = readJson('package.json')
    for (const script of ['services:up', 'services:down']) {
      assert.ok(scripts[script], `package.json is missing the "${script}" script`)
    }
    // T3's criterion says services:up "reports healthy" — only --wait turns that into an exit code.
    assert.match(scripts['services:up'], /--wait/, 'services:up must use --wait so health is an exit code')
    // Compose resolves .env next to the compose file unless told otherwise; without this every
    // credential silently falls back to empty and Postgres refuses to initialize.
    assert.match(scripts['services:up'], /--project-directory/, 'services:up must point Compose at the root .env')
  })

  test('services:down preserves data; destroying it is a separate, explicit command', () => {
    const { scripts = {} } = readJson('package.json')
    assert.ok(
      !/\s-v\b|--volumes/.test(scripts['services:down']),
      'services:down must not delete volumes — data loss should never be a side effect of stopping',
    )
    assert.ok(scripts['services:reset'], 'a separate services:reset must exist for deliberate data destruction')
    assert.match(scripts['services:reset'], /\s-v\b|--volumes/, 'services:reset is the command that removes volumes')
  })
})
