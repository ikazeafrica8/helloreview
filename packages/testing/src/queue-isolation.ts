// Keeping the queue integration tests off the developer's real work.
//
// Two tests exercise the worker runtime against the LOCAL dev Redis rather than a container, because
// they measure process behaviour — a boot, a graceful drain, a correlation hop across the enqueue
// boundary — and a Testcontainers Redis costs several seconds per test without changing what is
// being proved.
//
// The hazard is the cleanup, not the test. Both call `queue.obliterate({ force: true })` in a
// `finally`, and obliterate deletes EVERY key belonging to that queue — waiting jobs, delayed jobs,
// the completed set. Today the queues are empty so it is harmless. Once T27/T43/T45 give
// SEND_OUTBOUND and RECONCILE_APPLICATIONS real work, running the integration suite while the
// worker is up would silently destroy queued outbound messages. That is a `pnpm test` that eats
// data, which is exactly the kind of thing nobody suspects until it has already happened.
//
// So the isolation is applied at both levels, because either alone leaves a hole:
//
//   - a different DATABASE, so nothing this suite writes shares a keyspace with db 0 at all;
//   - a different QUEUE NAME, so even if someone later points the suite at db 0, obliterate can
//     only reach keys this process created.
//
// The name is DERIVED from the registry entry rather than invented, so the test still breaks if the
// registry entry is renamed or removed — the provenance is what makes it a contract test.

/**
 * Redis logical database reserved for integration tests.
 *
 * Stock Redis ships `databases 16`, so 15 is the highest index that always exists. If an operator
 * has narrowed that, SELECT fails loudly with "DB index is out of range" — an honest error, which
 * is the right failure mode for a guard.
 */
export const TEST_DATABASE_INDEX = 15

/**
 * Point a Redis URL at the test database, preserving credentials, host and port.
 *
 * Rewriting the URL rather than taking a separate connection object keeps the call sites honest:
 * they still connect to the same server the application uses, so a broken password or a wrong port
 * still fails the test.
 */
export const isolatedRedisUrl = (redisUrl: string): string => {
  const url = new URL(redisUrl)
  url.pathname = `/${String(TEST_DATABASE_INDEX)}`
  return url.toString()
}

/**
 * Derive a per-process queue name from a registered one.
 *
 * `label` distinguishes concurrent tests inside one process; the pid distinguishes concurrent
 * runs. Together they guarantee obliterate() can only ever delete keys this test itself created.
 */
export const isolatedQueueName = (registeredName: string, label: string): string =>
  `${registeredName}-test-${label}-${String(process.pid)}`
