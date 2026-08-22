// Pure: the environment arrives as an argument (SPEC.md §6). The impure read is in env-source.ts.
//
// SCOPE — the minimum the worker needs to connect. T8 replaces the validation with a Zod schema over
// the full environment surface and merges this with the api's loader.

import type { EnvironmentSource } from './env-source.js'

export type WorkerConfig = Readonly<{
  redisUrl: string
}>

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError'

  constructor(readonly problems: readonly string[]) {
    super(`Configuration is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
  }
}

export const loadWorkerConfig = (source: EnvironmentSource): WorkerConfig => {
  const problems: string[] = []
  const redisUrl = source.REDIS_URL

  if (redisUrl === undefined || redisUrl.trim() === '') {
    problems.push('REDIS_URL is not set. Copy .env.example to .env')
  } else {
    // Nothing below echoes the value: a malformed REDIS_URL still carries a password.
    let parsed: URL | undefined
    try {
      parsed = new URL(redisUrl)
    } catch {
      problems.push('REDIS_URL is not a valid URL')
    }
    if (parsed !== undefined) {
      // `new URL('nonsense://')` parses — WHATWG allows a non-special scheme with an empty host —
      // so a bare try/catch accepts a value that can never connect.
      if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
        problems.push('REDIS_URL must use redis: or rediss:')
      } else if (parsed.hostname === '') {
        problems.push('REDIS_URL has no host')
      }
    }
  }

  if (problems.length > 0) throw new ConfigurationError(problems)

  return Object.freeze({ redisUrl: redisUrl ?? '' })
}
