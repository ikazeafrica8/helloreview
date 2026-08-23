// Liveness probes for the platform's two hard dependencies.
//
// Every probe is bounded by PROBE_TIMEOUT_MS. An unbounded probe turns a slow dependency into a slow
// health endpoint, which is how a load balancer ends up waiting on the thing it is trying to route
// around.
//
// pg and ioredis are used directly rather than through Drizzle or BullMQ, which do not exist until
// T9 and T5. pg is what Drizzle will sit on, so this is not throwaway.

import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { DEPENDENCY_DOWN, HEALTH_STATUS, type DependencyDownCode, type HealthStatus } from './reason-codes.js'

const PROBE_TIMEOUT_MS = 2_000

export type DependencyReport =
  | Readonly<{ status: typeof HEALTH_STATUS.UP; latencyMs: number }>
  | Readonly<{ status: typeof HEALTH_STATUS.DOWN; reason: DependencyDownCode }>

export type ProbeResult = Readonly<{ name: string; report: DependencyReport }>

/**
 * Map an unknown driver error to a code. Deliberately narrow: anything unrecognized becomes
 * UNREACHABLE rather than leaking the original message into the response.
 */
const classify = (error: unknown): DependencyDownCode => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message.toLowerCase() : ''

  if (code === 'ETIMEDOUT' || message.includes('timeout')) return DEPENDENCY_DOWN.TIMED_OUT
  if (code === '28P01' || code === '28000' || message.includes('auth') || message.includes('password')) {
    return DEPENDENCY_DOWN.UNAUTHORIZED
  }
  return DEPENDENCY_DOWN.UNREACHABLE
}

const withTimeout = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('probe timeout'), { code: 'ETIMEDOUT' }))
        }, PROBE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Run a probe, converting any failure into a report rather than letting it escape. */
const report = async (probe: () => Promise<HealthStatus>, startedAt: number): Promise<DependencyReport> => {
  try {
    await withTimeout(probe())
    return { status: HEALTH_STATUS.UP, latencyMs: Math.round(performance.now() - startedAt) }
  } catch (error) {
    return { status: HEALTH_STATUS.DOWN, reason: classify(error) }
  }
}

export const probePostgres = async (pool: Pool): Promise<DependencyReport> => {
  const startedAt = performance.now()
  return report(async () => {
    await pool.query('select 1')
    return HEALTH_STATUS.UP
  }, startedAt)
}

export const probeRedis = async (redis: Redis): Promise<DependencyReport> => {
  const startedAt = performance.now()
  return report(async () => {
    // No need to check the reply: ioredis types ping() as returning the literal 'PONG', and it
    // surfaces an auth failure by REJECTING rather than by returning a different string — so a
    // NOAUTH lands in the catch and is classified as UNAUTHORIZED. (A reply check here is provably
    // dead code, which is how the type checker found it.)
    await redis.ping()
    return HEALTH_STATUS.UP
  }, startedAt)
}
