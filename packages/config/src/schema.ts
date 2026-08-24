import { z } from 'zod'

// The environment contract, as a Zod schema.
//
// SCOPE: exactly what apps/api and apps/worker read today. Variables are NOT added here in advance
// of the task that consumes them — an unread variable in the schema is a required value nobody can
// explain, and it fails startup for a feature that does not exist yet.

/**
 * A URL that not only parses but could actually connect.
 *
 * `new URL('nonsense://')` succeeds — WHATWG permits a non-special scheme with an empty host — so a
 * bare url() check accepts values that fail only at connect time, far from the cause. This was a
 * real bug in the loaders T8 replaced, caught by the first unit test written against them.
 */
const connectableUrl = (protocols: readonly string[]) =>
  z
    .string()
    .min(1)
    .refine(
      (raw) => {
        try {
          const parsed = new URL(raw)
          return protocols.includes(parsed.protocol) && parsed.hostname !== ''
        } catch {
          return false
        }
      },
      // The message never interpolates the value: a malformed DATABASE_URL still carries a password.
      { message: `must be a URL using ${protocols.join(' or ')} with a host` },
    )

const port = z
  .string()
  .regex(/^\d+$/, { message: 'must be a whole number' })
  .transform(Number)
  .refine((value) => value >= 1 && value <= 65_535, { message: 'must be between 1 and 65535' })

/**
 * Which deployment this process belongs to.
 *
 * Every log line carries it (§23.1), and SPEC.md's non-functional requirements call for development,
 * test, staging and production to be separated. Defaulted rather than required so a fresh clone
 * runs without ceremony; anything other than development must be set deliberately.
 */
const environment = z.enum(['development', 'test', 'staging', 'production']).default('development')

/**
 * The key that makes a masked identifier unlinkable.
 *
 * maskIdentifier() HMACs with this rather than hashing plainly, because an unsalted digest of a
 * low-entropy identifier — a phone number, a provider id following a guessable scheme — is
 * reversible by brute force. A minimum length is enforced so a placeholder cannot quietly weaken it.
 */
const pepper = z.string().min(16, { message: 'must be at least 16 characters' })

/**
 * The shared secret a provider signs its webhooks with (PRD §18.3, T16).
 *
 * A minimum length is enforced because this secret is the ONLY thing standing between the internet
 * and the ability to write business state — a short one is brute-forceable offline, since an
 * attacker who captures one signed request can grind candidates against it without touching us.
 */
const webhookSecret = z.string().min(32, { message: 'must be at least 32 characters' })

/**
 * How old a signed webhook may be, in seconds.
 *
 * Bounded at both ends deliberately. Too tight and a provider's legitimate retry is refused; too
 * loose and a captured request stays replayable for that long. Five minutes is the industry
 * convention and the default here.
 */
const replayWindowSeconds = z
  .string()
  .optional()
  // The default is applied to the INPUT, then piped through the same validation a supplied value
  // gets. Chaining `.default('300')` after `.transform(Number)` does not type-check in Zod 4 — the
  // default must match the OUTPUT of the chain by then — and the version that does compile,
  // `.default(300)`, would skip the range check for the default value. This shape means the default
  // is validated by exactly the rules a real value is.
  .transform((value) => value ?? '300')
  .pipe(
    z
      .string()
      .regex(/^\d+$/, { message: 'must be a whole number of seconds' })
      .transform(Number)
      .refine((value) => value >= 30 && value <= 3_600, { message: 'must be between 30 and 3600 seconds' }),
  )

const boundedSeconds = (fallback: string, minimum: number, maximum: number) =>
  z
    .string()
    .optional()
    .transform((value) => value ?? fallback)
    .pipe(
      z
        .string()
        .regex(/^\d+$/, { message: 'must be a whole number of seconds' })
        .transform(Number)
        .refine((value) => value >= minimum && value <= maximum, {
          message: `must be between ${String(minimum)} and ${String(maximum)} seconds`,
        }),
    )

const reconciliationWindowSeconds = boundedSeconds('300', 30, 86_400)
const reconciliationRetrySeconds = boundedSeconds('30', 1, 3_600)
const applicationFreshnessSeconds = boundedSeconds('900', 30, 86_400)

/** Everything the api reads. */
export const apiConfigSchema = z.object({
  DATABASE_URL: connectableUrl(['postgres:', 'postgresql:']),
  REDIS_URL: connectableUrl(['redis:', 'rediss:']),
  API_PORT: port,
  NODE_ENV: environment,
  MASKING_PEPPER: pepper,
  WEBHOOK_SECRET_WEBSITE: webhookSecret,
  WEBHOOK_REPLAY_WINDOW_SECONDS: replayWindowSeconds,
  APPLICATION_RECONCILIATION_WINDOW_SECONDS: reconciliationWindowSeconds,
  APPLICATION_RECONCILIATION_RETRY_SECONDS: reconciliationRetrySeconds,
  APPLICATION_FRESHNESS_THRESHOLD_SECONDS: applicationFreshnessSeconds,
})

/**
 * Everything the worker reads — a strict subset, not a copy.
 *
 * Derived with .pick() so a rule can never drift between the two: changing how REDIS_URL is
 * validated changes it for both deployables in one edit. The worker never reads API_PORT, and a
 * worker that refuses to start over a value it does not use is a confusing failure on call.
 */
export const workerConfigSchema = apiConfigSchema.pick({
  DATABASE_URL: true,
  REDIS_URL: true,
  NODE_ENV: true,
  MASKING_PEPPER: true,
  APPLICATION_RECONCILIATION_WINDOW_SECONDS: true,
  APPLICATION_RECONCILIATION_RETRY_SECONDS: true,
  APPLICATION_FRESHNESS_THRESHOLD_SECONDS: true,
})

/** The operator CSV command needs database DML and keyed digests, but no HTTP or Redis config. */
export const applicationImportConfigSchema = apiConfigSchema.pick({
  DATABASE_URL: true,
  MASKING_PEPPER: true,
})

/**
 * Keys whose VALUE must never appear in a log line, an error message, or a diagnostic dump.
 *
 * An explicit set rather than schema metadata: this list is a security control, and it should be
 * readable at a glance by someone auditing what the platform can leak — not reconstructed by
 * walking a schema. Anything carrying credentials belongs here.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'REDIS_URL',
  'MASKING_PEPPER',
  'WEBHOOK_SECRET_WEBSITE',
])

export const isSecret = (key: string): boolean => SECRET_KEYS.has(key)
