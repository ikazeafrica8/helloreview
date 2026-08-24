// PostgreSQL schema, migrations and connection helpers.
//
// SPEC.md §17.1 makes PostgreSQL the authoritative operational state store, and §17.3's unique
// constraints are the idempotency mechanism rather than a tidiness measure — which is why
// migrations are checked-in, reviewable SQL and there is no `db:push` anywhere in this repo.

export { tstz } from './columns.js'
export { applyMigrations, MIGRATIONS_FOLDER } from './migrate.js'
export { createDbClient } from './client.js'
export type { DbClient } from './client.js'
export { runInTransaction } from './transaction.js'
export type { DbTransaction } from './transaction.js'
export { POSTGRES_POOL } from './tokens.js'
export {
  isUniqueViolation,
  isRetryableDatabaseFailure,
  sqlStateOf,
  violatedConstraint,
  describeDatabaseFailure,
} from './errors.js'
export * from './schema/index.js'

// Re-exported so callers can build predicates without declaring their own drizzle-orm dependency.
// Two workspaces on different drizzle versions against one schema is a subtle, miserable failure.
export { eq, and, or, sql, desc, asc, inArray, isNull, lt, gt, gte, lte } from 'drizzle-orm'
