import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq'
import type { QueueName } from '@helloreview/contracts'

export type JobHandler = (job: Job) => Promise<void>

export type WorkerRuntimeOptions = Readonly<{
  redisUrl: string
  queues: readonly QueueName[]
  handlers: Readonly<Partial<Record<QueueName, JobHandler>>>
  /** Bounded so a wedged job cannot block shutdown forever. */
  drainTimeoutMs?: number
}>

export type WorkerRuntime = Readonly<{
  start: () => Promise<void>
  stop: () => Promise<void>
  isReady: () => boolean
}>

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000

/**
 * Connection settings for BullMQ, derived from a Redis URL.
 *
 * OPTIONS, deliberately, not a constructed ioredis instance. BullMQ closes connections it created
 * itself but never one it was handed, so passing an instance leaks an open socket on every
 * queue.close() — which keeps the Node event loop alive and hangs the process at exit. Measured.
 *
 * maxRetriesPerRequest MUST be null for a Worker. BullMQ uses blocking commands that legitimately
 * sit open for many seconds; under ioredis's default retry limit those count as failures and the
 * worker dies with "Connection is closed" under no load at all.
 */
const redisConnectionOptions = (redisUrl: string): ConnectionOptions => {
  const url = new URL(redisUrl)
  const database = url.pathname.replace(/^\//, '')

  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username === '' ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
    ...(database === '' ? {} : { db: Number(database) }),
    maxRetriesPerRequest: null,
    // BullMQ issues its own readiness handshake; ioredis's duplicates it and delays startup.
    enableReadyCheck: false,
  }
}

/**
 * Bind one BullMQ Worker per queue and manage their lifecycle together.
 *
 * The queues are passed in rather than read from the registry directly, so a test can run a single
 * queue in isolation without spinning up every processor the platform will eventually have.
 */
export const createWorkerRuntime = (options: WorkerRuntimeOptions): WorkerRuntime => {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const workers: Worker[] = []
  let ready = false

  const start = async (): Promise<void> => {
    await Promise.all(
      options.queues.map(async (name) => {
        const handler = options.handlers[name]
        // Binding a queue with no handler would consume jobs and silently discard them, which is a
        // far worse failure than refusing to start.
        if (handler === undefined) throw new Error(`no handler registered for queue "${name}"`)

        // Each Worker gets its own connection — they hold a blocking command open, so sharing one
        // would serialize every queue behind whichever worker is currently blocked. Passing options
        // rather than an instance means BullMQ creates it and therefore also closes it.
        const worker = new Worker(name, handler, {
          connection: redisConnectionOptions(options.redisUrl),
          autorun: true,
        })
        // An unhandled 'error' on a Worker is an uncaught exception, which would take the process
        // down on a transient Redis blip instead of letting it reconnect.
        worker.on('error', () => undefined)
        workers.push(worker)

        await worker.waitUntilReady()
      }),
    )
    ready = true
  }

  /**
   * Graceful shutdown. This is the function the SIGTERM handler calls.
   *
   * `worker.close()` without an argument waits for in-flight jobs to finish before resolving —
   * `close(true)` would abandon them. That distinction IS T5's third acceptance criterion, so it is
   * deliberately not parameterized: there is no call site here that can accidentally force it.
   */
  const stop = async (): Promise<void> => {
    ready = false

    await Promise.race([
      Promise.all(workers.map(async (worker) => worker.close())),
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`workers did not drain within ${String(drainTimeoutMs)}ms`))
        }, drainTimeoutMs).unref()
      }),
    ])

    // No connections to close by hand: BullMQ created them from the options above, so
    // worker.close() has already released them.
    workers.length = 0
  }

  return { start, stop, isReady: () => ready }
}

/**
 * A producer handle. The api uses this for the T43 outbox; tests use it to enqueue.
 *
 * The caller owns the returned Queue and must close() it — that also releases the connection,
 * because BullMQ created it.
 */
export const createQueue = (redisUrl: string, name: QueueName): Queue =>
  new Queue(name, { connection: redisConnectionOptions(redisUrl) })
