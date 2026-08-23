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

/** Everything the api reads. */
export const apiConfigSchema = z.object({
  DATABASE_URL: connectableUrl(['postgres:', 'postgresql:']),
  REDIS_URL: connectableUrl(['redis:', 'rediss:']),
  API_PORT: port,
  NODE_ENV: environment,
  MASKING_PEPPER: pepper,
})

/**
 * Everything the worker reads — a strict subset, not a copy.
 *
 * Derived with .pick() so a rule can never drift between the two: changing how REDIS_URL is
 * validated changes it for both deployables in one edit. The worker never reads API_PORT, and a
 * worker that refuses to start over a value it does not use is a confusing failure on call.
 */
export const workerConfigSchema = apiConfigSchema.pick({ REDIS_URL: true, NODE_ENV: true, MASKING_PEPPER: true })

/**
 * Keys whose VALUE must never appear in a log line, an error message, or a diagnostic dump.
 *
 * An explicit set rather than schema metadata: this list is a security control, and it should be
 * readable at a glance by someone auditing what the platform can leak — not reconstructed by
 * walking a schema. Anything carrying credentials belongs here.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set(['DATABASE_URL', 'REDIS_URL', 'MASKING_PEPPER'])

export const isSecret = (key: string): boolean => SECRET_KEYS.has(key)
