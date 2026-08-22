// Configuration loading and validation.
//
// Pure: the environment arrives as an argument, so this is testable without touching process.env
// (SPEC.md §6, "Purity is the boundary"). The impure read lives in env-source.ts.
//
// SCOPE — this is deliberately the minimum T4 and T5 need to boot, not the full configuration
// surface. T8 owns:
//   - a Zod schema covering every variable the platform reads, not just these three
//   - marking secret-valued keys so they are redacted from diagnostics
//   - consolidating this loader and the worker's into one shared implementation
// The shape below (validate everything, report every problem at once, return a frozen typed object)
// is the contract T8 should preserve.

import type { EnvironmentSource } from './env-source.js'

export type AppConfig = Readonly<{
  databaseUrl: string
  redisUrl: string
  apiPort: number
}>

/** Thrown at startup. Never caught — a misconfigured process must not begin serving. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError'

  constructor(readonly problems: readonly string[]) {
    super(`Configuration is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
  }
}

/**
 * Each required URL and the schemes it may use.
 *
 * The scheme and host checks are not decoration. `new URL('nonsense://')` parses successfully —
 * WHATWG allows a non-special scheme with an empty host — so a bare `new URL()` in a try/catch
 * accepts a value that cannot possibly connect, and the failure surfaces later and further away.
 */
const REQUIRED_URLS = [
  { key: 'DATABASE_URL', protocols: ['postgres:', 'postgresql:'] },
  { key: 'REDIS_URL', protocols: ['redis:', 'rediss:'] },
] as const

/**
 * Validate the environment and return the typed configuration.
 *
 * Reports EVERY problem rather than throwing on the first. Fixing configuration one error per
 * restart is the kind of small friction that makes people copy values around until it works.
 */
export const loadAppConfig = (source: EnvironmentSource): AppConfig => {
  const problems: string[] = []

  const requireUrl = ({ key, protocols }: { key: string; protocols: readonly string[] }): string => {
    const raw = source[key]
    if (raw === undefined || raw.trim() === '') {
      problems.push(`${key} is not set. Copy .env.example to .env`)
      return ''
    }
    // No value from here on is ever echoed: a malformed DATABASE_URL still carries a password.
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      problems.push(`${key} is not a valid URL`)
      return raw
    }
    if (!protocols.includes(parsed.protocol)) {
      problems.push(`${key} must use one of ${protocols.join(', ')}`)
    } else if (parsed.hostname === '') {
      problems.push(`${key} has no host`)
    }
    return raw
  }

  const [databaseUrl, redisUrl] = REQUIRED_URLS.map(requireUrl)

  const rawPort = source.API_PORT
  let apiPort = 0
  if (rawPort === undefined || rawPort.trim() === '') {
    problems.push('API_PORT is not set. Copy .env.example to .env')
  } else if (!/^\d+$/.test(rawPort.trim())) {
    problems.push(`API_PORT must be a whole number, got "${rawPort}"`)
  } else {
    apiPort = Number(rawPort)
    if (apiPort < 1 || apiPort > 65_535) problems.push(`API_PORT must be between 1 and 65535, got ${String(apiPort)}`)
  }

  if (problems.length > 0) throw new ConfigurationError(problems)

  return Object.freeze({
    databaseUrl: databaseUrl ?? '',
    redisUrl: redisUrl ?? '',
    apiPort,
  })
}
