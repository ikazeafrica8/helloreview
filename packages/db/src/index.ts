// PostgreSQL schema, migrations and connection helpers.
//
// SPEC.md §17.1 makes PostgreSQL the authoritative operational state store, and §17.3's unique
// constraints are the idempotency mechanism rather than a tidiness measure — which is why
// migrations are checked-in, reviewable SQL and there is no `db:push` anywhere in this repo.

export { tstz } from './columns.js'
export { applyMigrations, MIGRATIONS_FOLDER } from './migrate.js'
export * from './schema/index.js'
