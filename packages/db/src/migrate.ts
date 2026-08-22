import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

/**
 * Where the checked-in SQL migrations live.
 *
 * Resolved from import.meta.url rather than process.cwd(), so it points at packages/db/migrations
 * identically whether this module is running from src/ under Vitest or from dist/ in a deployed
 * process. A cwd-relative path would work in exactly one of those.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

/**
 * Apply every pending migration to the database at `url`.
 *
 * Takes a URL rather than a shared pool: this runs at startup and in test setup, both of which want
 * a connection that is opened, used and closed rather than borrowed from a long-lived pool.
 *
 * T7's harness uses it as `const { url } = await startPostgres(); await applyMigrations(url)`, which
 * is why the migrations path is resolved here and not passed in — a test should not have to know
 * where this package keeps its SQL.
 */
export const applyMigrations = async (url: string): Promise<void> => {
  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await pool.end()
  }
}
