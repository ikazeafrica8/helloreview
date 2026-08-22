import { z } from 'zod'
import type { EnvironmentSource } from './env-source.js'
import { apiConfigSchema, isSecret, workerConfigSchema } from './schema.js'

/**
 * Configuration in the shape application code wants.
 *
 * Deliberately not the raw SCREAMING_SNAKE keys: application code should not care that a value
 * arrived from an environment variable, and renaming a variable should not ripple through consumers.
 */
export type ApiConfig = Readonly<{
  databaseUrl: string
  redisUrl: string
  apiPort: number
}>

export type WorkerConfig = Readonly<{
  redisUrl: string
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
  }))

export const loadWorkerConfig = (source: EnvironmentSource): WorkerConfig =>
  load(workerConfigSchema, source, (parsed) => ({ redisUrl: parsed.REDIS_URL }))

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
