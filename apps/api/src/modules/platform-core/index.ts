// The ONLY public surface of platform-core (SPEC.md §5).
//
// Everything else in this folder is internal. T6's module-boundary rule will enforce that other
// modules import from here and never reach past it — which is what lets the internals be
// reorganized (T8's Zod config, T9's Drizzle connection) without touching a single consumer.

export { PlatformCoreModule } from './platform-core.module.js'
export { APP_CONFIG, APP_LOGGER, POSTGRES_POOL, REDIS_CLIENT } from './tokens.js'
export { CORRELATION_HEADER } from './correlation/correlation.middleware.js'
export type { ApiConfig } from '@helloreview/config'
export { ConfigurationError } from '@helloreview/config'
export type { HealthReport } from './health/health.service.js'
