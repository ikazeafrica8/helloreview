// Shared test infrastructure: fixtures, builders, container helpers and custom matchers.
//
// Builders arrive with the modules they build for.

export { startPostgres, startRedis, withPostgres, withRedis } from './containers.js'
export type { EphemeralPostgres, EphemeralRedis } from './containers.js'

export { isolatedRedisUrl, isolatedQueueName, TEST_DATABASE_INDEX } from './queue-isolation.js'
export { withQueue, countWaitingJobs, waitingJobs } from './queue-inspection.js'

export { detectPii, describeFindings } from './matchers/no-pii.js'
export type { PiiFinding } from './matchers/no-pii.js'
export { captureOutput } from './matchers/register.js'
