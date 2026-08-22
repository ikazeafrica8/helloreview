import { Redis } from 'ioredis'
import { ALL_QUEUE_NAMES } from '@helloreview/contracts'
import { readEnvironment } from './config/env-source.js'
import { ConfigurationError, loadWorkerConfig } from './config/load-worker-config.js'
import { HANDLERS } from './processors/index.js'
import { createWorkerRuntime } from './runtime.js'

/**
 * Boot-time logging.
 *
 * process.stdout.write rather than console.log, which `no-console` forbids — but be honest about
 * what that is: the rule exists because console output bypasses the structured logger and T12's PII
 * matcher, and writing to stdout directly bypasses them just the same. It is acceptable only
 * because these lines carry no participant data and the structured logger does not exist yet.
 * T11 replaces this helper; nothing here should grow until it does.
 */
const log = (message: string): void => {
  process.stdout.write(`[worker] ${message}\n`)
}

/**
 * Prove the connection before binding anything.
 *
 * Without this, a worker pointed at an unreachable Redis sits in ioredis's reconnect loop looking
 * perfectly alive, and the only symptom is that no job is ever processed. Failing at boot is the
 * behaviour an operator can actually diagnose.
 */
const verifyRedis = async (redisUrl: string): Promise<void> => {
  const probe = new Redis(redisUrl, {
    // lazyConnect + an explicit connect() is what makes this a real check. Without it the ping is
    // issued before the socket is up and fails instantly with "Stream isn't writeable" — against a
    // perfectly healthy Redis.
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    // Reject instead of reconnecting forever: the point of a boot probe is to fail fast.
    retryStrategy: () => null,
  })
  probe.on('error', () => undefined)
  try {
    await probe.connect()
    await probe.ping()
  } finally {
    probe.disconnect()
  }
}

const bootstrap = async (): Promise<void> => {
  const config = loadWorkerConfig(readEnvironment())

  await verifyRedis(config.redisUrl)
  log('connected to redis')

  // Derived by filtering the registry rather than casting Object.keys(): the cast would be a lie
  // the type checker cannot verify, and it is exactly what @typescript-eslint/no-unsafe-type-assertion
  // exists to catch. ALL_QUEUE_NAMES is already typed, so filtering it needs no assertion at all.
  const queues = ALL_QUEUE_NAMES.filter((name) => HANDLERS[name] !== undefined)
  const runtime = createWorkerRuntime({ redisUrl: config.redisUrl, queues, handlers: HANDLERS })
  await runtime.start()

  log(
    queues.length === 0
      ? 'ready — 0 processors registered (T27, T45 and T55 add them; see src/processors/index.ts)'
      : `ready — ${String(queues.length)} processor(s): ${queues.join(', ')}`,
  )

  let stopping = false
  const shutdown = (signal: string): void => {
    // A second signal while draining must not start a second shutdown; BullMQ's close() is not
    // re-entrant and the first drain is already doing the right thing.
    if (stopping) {
      log(`already draining, ignoring ${signal}`)
      return
    }
    stopping = true
    log(`${signal} received — draining in-flight jobs`)

    runtime.stop().then(
      () => {
        log('drained cleanly')
        process.exit(0)
      },
      (error: unknown) => {
        log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      },
    )
  }

  // SIGTERM is what a container runtime sends. SIGINT is Ctrl+C. Note that on Windows neither is
  // deliverable from another process — measured — so this path is exercised on POSIX and by the
  // drain test calling runtime.stop() directly.
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
}

try {
  await bootstrap()
} catch (error) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`[worker] ${error.message}\n`)
  } else {
    process.stderr.write(`[worker] failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.exit(1)
}
