// Ephemeral PostgreSQL and Redis for the integration tier.
//
// These are NOT the containers `pnpm services:up` starts. A test that mutated the developer's dev
// database would make its own result depend on whatever was left behind by the last run, and would
// destroy local state as a side effect. Testcontainers gives each run its own throwaway instance on
// a random high port, so the dev stack is never touched — which is exactly what T7's second
// acceptance criterion asks for.
//
// Images are pinned to the same digests as infra/docker-compose.yml. Testing against a different
// PostgreSQL build than development runs is how a collation or extension difference hides until
// production.
//
// Cleanup is belt and braces: stop() in a finally, plus Ryuk. Testcontainers starts a Ryuk sidecar
// that reaps every labelled container when the owning process dies — measured at roughly five
// seconds here — so even a hard crash cannot leave containers running.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

/** Kept in step with infra/docker-compose.yml on purpose. */
const POSTGRES_IMAGE = 'postgres:16.15-bookworm@sha256:60f4761b9035e0b8d5218f701a8c3382f641bf12b1604822574cf5be3baeb537'
const REDIS_IMAGE = 'redis:7.4.11-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf'

export type EphemeralPostgres = Readonly<{
  url: string
  container: StartedPostgreSqlContainer
  stop: () => Promise<void>
}>

export type EphemeralRedis = Readonly<{
  url: string
  container: StartedRedisContainer
  stop: () => Promise<void>
}>

/**
 * Start a throwaway PostgreSQL.
 *
 * The locale matches docker-compose.yml: this product matches Korean text under the §17.3 unique
 * constraints that are the idempotency mechanism, so a test running under a different collation
 * would be testing different behaviour from the one that ships.
 */
export const startPostgres = async (): Promise<EphemeralPostgres> => {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('helloreview_test')
    .withUsername('helloreview')
    .withPassword('helloreview_test')
    .withEnvironment({ POSTGRES_INITDB_ARGS: '--encoding=UTF8 --locale=C.UTF-8', TZ: 'UTC' })
    .start()

  return {
    url: container.getConnectionUri(),
    container,
    stop: async () => {
      await container.stop()
    },
  }
}

export const startRedis = async (): Promise<EphemeralRedis> => {
  const container = await new RedisContainer(REDIS_IMAGE).start()

  return {
    url: container.getConnectionUrl(),
    container,
    stop: async () => {
      await container.stop()
    },
  }
}

/**
 * Run `body` against a throwaway PostgreSQL, stopping it afterwards whatever happens.
 *
 * Prefer this over calling startPostgres() directly: the finally is the part that gets forgotten,
 * and a leaked container is a slow, confusing failure for whoever runs the suite next.
 */
export const withPostgres = async <T>(body: (postgres: EphemeralPostgres) => Promise<T>): Promise<T> => {
  const postgres = await startPostgres()
  try {
    return await body(postgres)
  } finally {
    await postgres.stop()
  }
}

export const withRedis = async <T>(body: (redis: EphemeralRedis) => Promise<T>): Promise<T> => {
  const redis = await startRedis()
  try {
    return await body(redis)
  } finally {
    await redis.stop()
  }
}
