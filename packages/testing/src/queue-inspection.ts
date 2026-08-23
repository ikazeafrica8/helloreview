import { Queue, type Job } from 'bullmq'
import { redisConnectionOptions } from '@helloreview/config'

// Looking at what is on a queue, from a test.
//
// WHY THIS LIVES HERE. `bullmq` is a dependency of apps/api and apps/worker, so Node resolves it
// relative to a file inside one of those. A test under tests/ that imports it directly fails with
// ERR_MODULE_NOT_FOUND — the same resolution wall that put createDbClient in packages/db. Putting
// the helper in the shared test package keeps the driver in one place and stops every test file
// re-deriving the connection options from a URL.
//
// These are ASSERTION helpers, deliberately read-mostly. Draining or obliterating a queue belongs
// in the test that owns it, alongside the isolation policy in queue-isolation.ts.

/**
 * BullMQ connection options from a Redis URL.
 *
 * The shared builder, not a fourth hand-rolled copy — the three that existed all dropped TLS. A
 * test helper opening a plaintext connection would not itself be a security problem, but it would
 * be a helper that no longer matches how the application connects, which is how a test stops
 * testing the thing it names.
 */
const connectionFor = (redisUrl: string) => redisConnectionOptions(redisUrl, { blocking: true })

/**
 * Open a queue handle, run `body`, and always close it.
 *
 * The close is what keeps the suite exiting: BullMQ created the connection from these options, so
 * it also owns closing it — but only if `close()` is actually called, and an un-closed connection
 * refs the event loop forever.
 */
export const withQueue = async <T>(redisUrl: string, name: string, body: (queue: Queue) => Promise<T>): Promise<T> => {
  const queue = new Queue(name, { connection: connectionFor(redisUrl) })
  try {
    return await body(queue)
  } finally {
    await queue.close()
  }
}

/** How many jobs are waiting. The usual "did exactly one job get enqueued?" assertion. */
export const countWaitingJobs = async (redisUrl: string, name: string): Promise<number> =>
  withQueue(redisUrl, name, async (queue) => queue.getWaitingCount())

/** Every waiting job, for assertions about what a job actually carries. */
export const waitingJobs = async (redisUrl: string, name: string): Promise<Job[]> =>
  withQueue(redisUrl, name, async (queue) => queue.getWaiting())
