import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq'
import type { QueueName } from '@helloreview/contracts'
import { adoptCorrelationId, currentCorrelationId, runWithCorrelation } from '@helloreview/observability'

/**
 * The key a job carries its originating correlation id under.
 *
 * Prefixed and documented rather than blended into the payload: a job's data is business content,
 * and a reader should be able to tell at a glance which field is transport metadata.
 */
export const CORRELATION_FIELD = '__correlationId'

/**
 * Read the correlation field off a job payload without asserting anything about it.
 *
 * BullMQ types `job.data` as `any`, so a cast here would be exactly the lie
 * @typescript-eslint/no-unsafe-type-assertion exists to catch — and the value genuinely is
 * untrusted: it was serialized into Redis by another process. A predicate narrows honestly, and
 * adoptCorrelationId validates whatever comes back.
 */
const readCorrelationField = (data: unknown): unknown => {
  if (typeof data !== 'object' || data === null) return undefined
  if (!(CORRELATION_FIELD in data)) return undefined
  const carrier: Record<string, unknown> = { ...data }
  return carrier[CORRELATION_FIELD]
}

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
        // Restore the correlation id the producer was running under, so one participant
        // interaction stays a single trace across the enqueue boundary (T10). A job with no id —
        // a scheduled reconciliation, say — gets a fresh one rather than none, because the work
        // still needs to be traceable.
        const traced = async (job: Job): Promise<void> => {
          const data: unknown = job.data
          await runWithCorrelation(adoptCorrelationId(readCorrelationField(data)), async () => handler(job))
        }

        const worker = new Worker(name, traced, {
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

/**
 * Enqueue a job, stamping the current correlation id onto it.
 *
 * Prefer this over queue.add() directly: the stamp is what lets the worker continue the producer's
 * trace, and a bare add() silently starts a new one. Outside a correlation scope it mints an id
 * rather than omitting the field, so the job is still traceable on its own.
 */
export const enqueueJob = async (queue: Queue, jobName: string, data: Record<string, unknown>): Promise<void> => {
  await queue.add(jobName, { ...data, [CORRELATION_FIELD]: currentCorrelationId() ?? adoptCorrelationId(undefined) })
}
