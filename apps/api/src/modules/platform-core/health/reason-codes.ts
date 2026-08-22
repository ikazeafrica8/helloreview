// Why a dependency is considered down.
//
// Codes, never raw driver errors. A pg or ioredis failure message routinely contains the host, port
// and sometimes the user — and this endpoint is unauthenticated by design, so echoing one would put
// connection details in front of anybody who can reach it (SPEC.md §21.4, and T4's own criterion
// that the endpoint expose no environment detail).

export const HEALTH_STATUS = {
  UP: 'up',
  DOWN: 'down',
} as const

export type HealthStatus = (typeof HEALTH_STATUS)[keyof typeof HEALTH_STATUS]

export const DEPENDENCY_DOWN = {
  /** The dependency refused the connection, or none was established before the deadline. */
  UNREACHABLE: 'UNREACHABLE',
  /** Connected, but the credentials were rejected. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Connected and authorized, but the probe did not answer in time. */
  TIMED_OUT: 'TIMED_OUT',
  /** Answered, but not with what the probe expected. */
  UNEXPECTED_RESPONSE: 'UNEXPECTED_RESPONSE',
} as const

export type DependencyDownCode = (typeof DEPENDENCY_DOWN)[keyof typeof DEPENDENCY_DOWN]
