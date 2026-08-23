// Turning a Redis URL into connection options, in exactly one place.
//
// WHY THIS EXISTS. Three call sites — the api's outbox queue, the worker's runtime, and the test
// helpers — each decomposed the URL by hand into `{ host, port, username, password, db }`. Three
// copies of the same mapping is drift waiting to happen, and it had already produced a real defect:
//
//   EVERY ONE OF THEM SILENTLY DROPPED TLS. ioredis enables TLS from a `rediss://` STRING, or from
//   an explicit `tls` option — never from a decomposed `{ host, port }`. So a deployment configured
//   with `rediss://` would have connected in PLAINTEXT, sending its Redis password and every job
//   payload unencrypted, while `packages/config`'s schema happily accepted the scheme and the
//   health probe (which passes the URL string, and therefore did use TLS) stayed green.
//
// Latent today, because no TLS Redis is configured. It would not have been latent on the first
// managed Redis, and the symptom — everything works, nothing is encrypted — is invisible.

/**
 * BullMQ/ioredis connection options for `redisUrl`.
 *
 * `blocking` selects the one setting that genuinely differs between a producer and a consumer:
 * a Worker holds blocking commands open for many seconds, and under ioredis's default retry limit
 * those count as failures, so it needs `maxRetriesPerRequest: null`. A Queue does not, and giving
 * it null is what makes a failed enqueue hang instead of erroring.
 */
export const redisConnectionOptions = (
  redisUrl: string,
  { blocking = false }: { blocking?: boolean } = {},
): Record<string, unknown> => {
  const url = new URL(redisUrl)
  const database = url.pathname.replace(/^\//, '')

  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username === '' ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
    ...(database === '' ? {} : { db: Number(database) }),
    // The line the three hand-rolled copies were missing. An empty object is the documented way to
    // ask ioredis for TLS with default settings; without it `rediss://` connects in plaintext.
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: blocking ? null : 1,
  }
}
