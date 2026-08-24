import { z } from 'zod'
import type { EnvironmentSource } from './env-source.js'
import { applicationImportConfigSchema, apiConfigSchema, isSecret, workerConfigSchema } from './schema.js'

/**
 * Configuration in the shape application code wants.
 *
 * Deliberately not the raw SCREAMING_SNAKE keys: application code should not care that a value
 * arrived from an environment variable, and renaming a variable should not ripple through consumers.
 */
export type Environment = 'development' | 'test' | 'staging' | 'production'

export type ApiConfig = Readonly<{
  databaseUrl: string
  redisUrl: string
  apiPort: number
  environment: Environment
  /** Secret. Keys maskIdentifier(); never logged (see SECRET_KEYS). */
  maskingPepper: string
  /** Per-provider webhook signing secrets, keyed by the §18.1 `source` value. */
  webhookSecrets: Readonly<Record<string, string>>
  webhookReplayWindowSeconds: number
  applicationReconciliationWindowSeconds: number
  applicationReconciliationRetrySeconds: number
  applicationFreshnessThresholdSeconds: number
}>

export type WorkerConfig = Readonly<{
  redisUrl: string
  environment: Environment
  /** Secret. Keys maskIdentifier(); never logged (see SECRET_KEYS). */
  maskingPepper: string
  /**
   * Added when the inbox relay landed. The worker was Redis-only before that.
   *
   * A genuine widening, not a value that was always present: a deployed worker now refuses to start
   * without DATABASE_URL. That is the correct behaviour — the relay is a correctness guarantee, and
   * a worker that silently ran without it would leave stranded events unrepaired — but it is a
   * change in deployment requirements and is called out here rather than discovered on a rollout.
   */
  databaseUrl: string
  applicationReconciliationWindowSeconds: number
  applicationReconciliationRetrySeconds: number
  applicationFreshnessThresholdSeconds: number
}>

export type ApplicationImportConfig = Readonly<{
  databaseUrl: string
  /** Secret. Keys both batch digests and source-event identities; never logged. */
  maskingPepper: string
}>

/** Thrown at startup and never caught: a misconfigured process must not begin serving. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError'

  constructor(readonly problems: readonly string[]) {
    super(`Configuration is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
  }
}

/**
 * Turn Zod issues into problem strings.
 *
 * No message ever contains a VALUE. Zod's defaults helpfully quote the input, which for DATABASE_URL
 * means printing a password into the startup log of a process that has not started yet — so problems
 * are assembled from the key and the rule only (SPEC.md §21.4).
 */
const describe = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const key = issue.path.join('.')
    // A missing key and a present-but-empty key are the same mistake to whoever has to fix it.
    if (issue.code === 'invalid_type') return `${key} is not set. Copy .env.example to .env`
    return `${key} ${issue.message}`
  })

/**
 * Validate against a schema and project into the application shape.
 *
 * Reports EVERY problem rather than throwing on the first: fixing configuration one error per
 * restart is the small friction that makes people copy values around until something works.
 */
const load = <Schema extends z.ZodType, Shaped>(
  schema: Schema,
  source: EnvironmentSource,
  project: (parsed: z.infer<Schema>) => Shaped,
): Shaped => {
  const result = schema.safeParse(source)
  if (!result.success) throw new ConfigurationError(describe(result.error))
  return Object.freeze(project(result.data))
}

/**
 * The api reads all three values.
 *
 * The worker deliberately gets its own loader rather than sharing this one: it never reads
 * API_PORT, and a worker that refuses to start over a value it does not use is a confusing failure
 * for whoever is on call.
 */
export const loadApiConfig = (source: EnvironmentSource): ApiConfig =>
  load(apiConfigSchema, source, (parsed) => ({
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    apiPort: parsed.API_PORT,
    environment: parsed.NODE_ENV,
    maskingPepper: parsed.MASKING_PEPPER,
    // Keyed by the PRD §18.1 `source` value, so the gateway looks a verifier up by the same string
    // the envelope carries rather than by a second name that has to be kept in step.
    webhookSecrets: Object.freeze({ helloreview_website: parsed.WEBHOOK_SECRET_WEBSITE }),
    webhookReplayWindowSeconds: parsed.WEBHOOK_REPLAY_WINDOW_SECONDS,
    applicationReconciliationWindowSeconds: parsed.APPLICATION_RECONCILIATION_WINDOW_SECONDS,
    applicationReconciliationRetrySeconds: parsed.APPLICATION_RECONCILIATION_RETRY_SECONDS,
    applicationFreshnessThresholdSeconds: parsed.APPLICATION_FRESHNESS_THRESHOLD_SECONDS,
  }))

export const loadWorkerConfig = (source: EnvironmentSource): WorkerConfig =>
  load(workerConfigSchema, source, (parsed) => ({
    redisUrl: parsed.REDIS_URL,
    environment: parsed.NODE_ENV,
    maskingPepper: parsed.MASKING_PEPPER,
    databaseUrl: parsed.DATABASE_URL,
    applicationReconciliationWindowSeconds: parsed.APPLICATION_RECONCILIATION_WINDOW_SECONDS,
    applicationReconciliationRetrySeconds: parsed.APPLICATION_RECONCILIATION_RETRY_SECONDS,
    applicationFreshnessThresholdSeconds: parsed.APPLICATION_FRESHNESS_THRESHOLD_SECONDS,
  }))

export const loadApplicationImportConfig = (source: EnvironmentSource): ApplicationImportConfig =>
  load(applicationImportConfigSchema, source, (parsed) => ({
    databaseUrl: parsed.DATABASE_URL,
    maskingPepper: parsed.MASKING_PEPPER,
  }))

/**
 * A representation of the environment that is safe to log.
 *
 * Every secret becomes a fixed marker rather than a truncated prefix: a prefix still leaks the
 * scheme, host and usually the username, and "it is only the first few characters" is how
 * credentials reach a log aggregator.
 */
export const redactEnvironment = (source: EnvironmentSource): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const key of Object.keys(apiConfigSchema.shape)) {
    const value = source[key]
    if (value === undefined) continue
    out[key] = isSecret(key) ? '[redacted]' : value
  }
  return out
}
