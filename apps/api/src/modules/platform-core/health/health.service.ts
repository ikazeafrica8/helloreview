import { Inject, Injectable } from '@nestjs/common'
import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { POSTGRES_POOL, REDIS_CLIENT } from '../tokens.js'
import { probePostgres, probeRedis, type DependencyReport } from './dependency-probes.js'
import { HEALTH_STATUS } from './reason-codes.js'

export type HealthReport = Readonly<{
  status: 'ok' | 'degraded'
  dependencies: Readonly<Record<string, DependencyReport>>
}>

@Injectable()
export class HealthService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Probe every dependency concurrently and aggregate.
   *
   * Concurrently, not in sequence: a health endpoint that probes serially takes as long as the sum
   * of its slowest dependencies, and each probe is already bounded on its own.
   *
   * One dependency being down does not stop the others being reported — an operator needs to know
   * which one failed, which is the whole point of the endpoint.
   */
  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([probePostgres(this.pool), probeRedis(this.redis)])
    const dependencies = { postgres, redis }
    const healthy = Object.values(dependencies).every((report) => report.status === HEALTH_STATUS.UP)

    return { status: healthy ? 'ok' : 'degraded', dependencies }
  }
}
