// Injection tokens for values that have no class to inject by.
//
// Symbols rather than strings: two modules cannot accidentally collide on the same token, and a
// typo is a compile error rather than a runtime "Nest can't resolve dependencies" at boot.

export const APP_CONFIG = Symbol('APP_CONFIG')
export const APP_LOGGER = Symbol('APP_LOGGER')
// Defined by the DB package so business modules can inject the pool without bypassing the
// capability graph to import platform-core directly.
export { POSTGRES_POOL } from '@helloreview/db'
export const REDIS_CLIENT = Symbol('REDIS_CLIENT')
