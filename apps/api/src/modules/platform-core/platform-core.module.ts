import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common'
import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { readEnvironment, loadApiConfig, type ApiConfig } from '@helloreview/config'
import { APP_CONFIG, POSTGRES_POOL, REDIS_CLIENT } from './tokens.js'
import { HealthController } from './health/health.controller.js'
import { HealthService } from './health/health.service.js'

const PROBE_TIMEOUT_MS = 2_000

/**
 * Foundations every other module depends on: configuration, the database pool, the Redis client and
 * the health endpoint (SPEC.md §3.1, `platform-core`).
 *
 * @Global because every later module needs configuration, and threading it through twenty imports
 * buys nothing. Nothing else in this codebase should be global.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: APP_CONFIG,
      // The only call to readEnvironment() in the application. loadAppConfig is pure and takes the
      // environment as an argument, so it is testable without process.env.
      useFactory: (): ApiConfig => loadApiConfig(readEnvironment()),
    },
    {
      provide: POSTGRES_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig): Pool => {
        const pool = new Pool({
          connectionString: config.databaseUrl,
          // Bounded so an unreachable database fails the health probe rather than hanging it.
          connectionTimeoutMillis: PROBE_TIMEOUT_MS,
          max: 10,
        })
        // A pool with no error listener terminates the process when an idle client drops — which
        // would turn a transient database blip into a crash loop instead of a 503.
        pool.on('error', (error) => {
          new Logger('PostgresPool').warn(`idle client error: ${error.name}`)
        })
        return pool
      },
    },
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig): Redis => {
        const redis = new Redis(config.redisUrl, {
          connectTimeout: PROBE_TIMEOUT_MS,
          // The offline queue stays ENABLED on purpose. Disabling it makes a command fail the
          // instant the socket is not writeable — including during the initial connect — so a probe
          // arriving in the first moments after boot reports `down` against a perfectly healthy
          // Redis. That is a false alarm on the exact signal an orchestrator routes on, and it
          // showed up here as an intermittently red 503 test.
          //
          // Queueing is safe because the probe is independently bounded at PROBE_TIMEOUT_MS: a
          // genuinely unreachable Redis still reports down, it just does so on the probe's deadline
          // rather than on the socket's writeability.
          maxRetriesPerRequest: 1,
          // Keep trying in the background, with a ceiling, so the app recovers on its own when
          // Redis comes back — but never faster than once a second.
          retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        })
        // ioredis is an EventEmitter: an unhandled 'error' is an uncaught exception, so a Redis
        // outage would take the whole process down rather than showing up as a degraded health
        // report. Verified this is required for the 503 path to work at all.
        redis.on('error', (error: Error) => {
          new Logger('RedisClient').warn(`connection error: ${error.name}`)
        })
        return redis
      },
    },
    HealthService,
  ],
  exports: [APP_CONFIG, POSTGRES_POOL, REDIS_CLIENT],
})
export class PlatformCoreModule implements OnApplicationShutdown {
  private readonly logger = new Logger(PlatformCoreModule.name)

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Release both connections on SIGTERM so the process exits instead of lingering on open handles.
   * Each close is independent: a Redis that is already gone must not stop the pool draining.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`closing dependencies (${signal ?? 'no signal'})`)

    try {
      await this.pool.end()
    } catch (error) {
      this.logger.warn(`postgres pool did not close cleanly: ${error instanceof Error ? error.name : 'unknown'}`)
    }

    try {
      // quit() drains in-flight commands; disconnect() would abandon them.
      await this.redis.quit()
    } catch {
      // Already disconnected — nothing to drain.
      this.redis.disconnect()
    }
  }
}
