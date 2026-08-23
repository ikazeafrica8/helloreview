import { Redis } from 'ioredis'
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from '@helloreview/contracts'
import { readEnvironment, loadWorkerConfig, ConfigurationError } from '@helloreview/config'
import { createLogger } from '@helloreview/observability'
import { HANDLERS } from './processors/index.js'
import { createWorkerRuntime, createQueue } from './runtime.js'
import { createDbClient } from '@helloreview/db'
import { startInboxRelay } from './relay/inbox-relay.js'

// T11 replaced the temporary process.stdout.write helper this file used to carry: every line now
// goes through the shared structured logger and carries the §23.1 fields. The logger is created
// after configuration loads, since it needs the environment name.

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
  const logger = createLogger({ module: 'worker', environment: config.environment })

  await verifyRedis(config.redisUrl)
  logger.info('connected to redis', { operation: 'worker.boot', result: 'ok' })

  // Derived by filtering the registry rather than casting Object.keys(): the cast would be a lie
  // the type checker cannot verify, and it is exactly what @typescript-eslint/no-unsafe-type-assertion
  // exists to catch. ALL_QUEUE_NAMES is already typed, so filtering it needs no assertion at all.
  const queues = ALL_QUEUE_NAMES.filter((name) => HANDLERS[name] !== undefined)
  const runtime = createWorkerRuntime({ redisUrl: config.redisUrl, queues, handlers: HANDLERS })
  await runtime.start()

  // THE INBOX RELAY. The accept path's inline enqueue is a latency optimisation; this is the
  // correctness guarantee — see relay/inbox-relay.ts. It runs whether or not any processor is
  // registered, because a stranded row must be re-queued now even if nothing consumes the queue
  // until T27: the job waiting is the difference between a recoverable backlog and a silent loss.
  const db = createDbClient(config.databaseUrl, 2)
  const relayQueue = createQueue(config.redisUrl, QUEUE_NAMES.PROCESS_INBOUND_EVENT)
  const relay = startInboxRelay({ db, queue: relayQueue, logger })
  logger.info('inbox relay started', { operation: 'inbox_relay.start', result: 'ok' })

  logger.info(
    queues.length === 0
      ? 'ready — 0 processors registered (T27, T45 and T55 add them; see src/processors/index.ts)'
      : `ready — ${String(queues.length)} processor(s): ${queues.join(', ')}`,
    { operation: 'worker.ready', result: 'ok', count: queues.length },
  )

  /**
   * Hold the event loop open.
   *
   * A BullMQ Worker refs the loop, so with processors registered the process stays up on its own.
   * With NONE registered — which is the shipped state until T27 — nothing refs it: the Redis probe
   * already disconnected, and Node does not count signal handlers. The process therefore printed
   * "ready" and exited 0 about half a second later, which meant `pnpm dev:worker` handed the
   * developer a worker that was already gone AND made T5's SIGTERM drain path unreachable, because
   * there was no process left to signal.
   *
   * Cleared in the shutdown path so a drained worker exits promptly instead of hanging on this.
   */
  const keepAlive = setInterval(() => undefined, 1 << 30)

  let stopping = false
  const shutdown = (signal: string): void => {
    // A second signal while draining must not start a second shutdown; BullMQ's close() is not
    // re-entrant and the first drain is already doing the right thing.
    if (stopping) {
      logger.warn(`already draining, ignoring ${signal}`, { operation: 'worker.shutdown', result: 'ignored' })
      return
    }
    stopping = true
    // Released here, not after stop() resolves: the drain must not be the only thing keeping the
    // process alive, or a failed drain would hang forever instead of exiting non-zero.
    clearInterval(keepAlive)
    relay.stop()
    logger.info(`${signal} received — draining in-flight jobs`, { operation: 'worker.shutdown', result: 'started' })

    runtime.stop().then(
      () => {
        logger.info('drained cleanly', { operation: 'worker.shutdown', result: 'ok' })
        // Close what this process opened. An un-closed pool or queue connection refs the event
        // loop and would keep a "cleanly drained" worker alive indefinitely.
        void Promise.allSettled([relayQueue.close(), db.close()]).then(() => {
          process.exit(0)
        })
      },
      (error: unknown) => {
        logger.error('shutdown failed', {
          operation: 'worker.shutdown',
          result: 'error',
          errorCategory: error instanceof Error ? error.name : 'unknown',
        })
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
