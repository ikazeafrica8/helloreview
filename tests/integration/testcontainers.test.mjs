// Integration tier: proves the ephemeral-container harness actually works (T7).
//
// This is the criterion that cannot be checked by reading config — "provisions and tears down
// containers without touching local dev services" is only true if you start one and look.

import { test, describe, beforeAll } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))

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

const devEnv = () => parseEnv(readFileSync(join(ROOT, '.env.example'), 'utf8'))

/**
 * Containers Testcontainers is holding open, EXCLUDING Ryuk.
 *
 * Ryuk is the reaper — it carries the same org.testcontainers label and starts on first use, so
 * counting it makes a clean run look like a leak of exactly one. What we care about is whether a
 * database or Redis container outlived its helper.
 */
const runningTestcontainers = () =>
  execFileSync('docker', ['ps', '--filter', 'label=org.testcontainers=true', '--format', '{{.Image}}'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((image) => image !== '' && !image.includes('testcontainers/ryuk')).length

describe('ephemeral container harness', () => {
  beforeAll(() => {
    const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
      cwd: join(ROOT, 'packages', 'testing'),
      encoding: 'utf8',
      timeout: 180_000,
    })
    assert.equal(build.status, 0, `packages/testing must compile:\n${build.stdout}${build.stderr}`)
  })

  test('withPostgres starts a real database, then stops it', async () => {
    const { withPostgres } = await import('../../packages/testing/dist/index.js')
    const before = runningTestcontainers()

    const observed = await withPostgres(async (postgres) => {
      const { Client } = await import('pg')
      const client = new Client({ connectionString: postgres.url })
      await client.connect()
      try {
        const { rows } = await client.query('select current_database() as name, current_setting($1) as tz', [
          'TimeZone',
        ])
        return { ...rows[0], port: postgres.container.getMappedPort(5432) }
      } finally {
        await client.end()
      }
    })

    assert.equal(observed.name, 'helloreview_test')
    assert.equal(observed.tz, 'UTC', 'containers run UTC so naive-Date bugs cannot hide behind a local timezone')

    // The dev stack must be untouched: an ephemeral container gets a random high port, never the
    // one the developer's own Postgres is published on.
    assert.notEqual(
      String(observed.port),
      devEnv().get('POSTGRES_PORT'),
      'the ephemeral database bound the dev stack port — it is not ephemeral',
    )

    assert.equal(runningTestcontainers(), before, 'withPostgres leaked a container')
  })

  test('withRedis starts a real Redis, then stops it', async () => {
    const { withRedis } = await import('../../packages/testing/dist/index.js')
    const before = runningTestcontainers()

    const port = await withRedis(async (redis) => {
      const { Redis } = await import('ioredis')
      const client = new Redis(redis.url, { lazyConnect: true, retryStrategy: () => null })
      try {
        await client.connect()
        assert.equal(await client.ping(), 'PONG')
        return redis.container.getMappedPort(6379)
      } finally {
        client.disconnect()
      }
    })

    assert.notEqual(String(port), devEnv().get('REDIS_PORT'), 'the ephemeral Redis bound the dev stack port')
    assert.equal(runningTestcontainers(), before, 'withRedis leaked a container')
  })

  test('the dev stack is still running and was never disturbed', () => {
    // The strongest form of "without touching local dev services": look at them afterwards.
    const names = execFileSync(
      'docker',
      ['compose', '--project-name', 'helloreview', 'ps', '--format', '{{.Service}}:{{.Health}}'],
      { encoding: 'utf8' },
    ).trim()

    for (const service of ['postgres', 'redis', 'minio']) {
      assert.match(names, new RegExp(`${service}:healthy`), `dev ${service} is not healthy after the run:\n${names}`)
    }
  })
})
