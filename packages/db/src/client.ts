import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.js'
import { runInTransaction, type DbTransaction } from './transaction.js'

/**
 * A connected database handle, plus the escape hatch and the way to close it.
 *
 * WHY THIS EXISTS RATHER THAN EACH CALLER BUILDING ITS OWN. `drizzle-orm` and `pg` are dependencies
 * of THIS package, so Node resolves them relative to a file inside it. A test or an app module that
 * imports `drizzle-orm/node-postgres` directly fails with ERR_MODULE_NOT_FOUND unless every
 * workspace redeclares the dependency — which would then let two workspaces drift onto different
 * drizzle versions against one schema. One factory here keeps the driver in one place.
 *
 * It also gives T18's inbox repository and the integration tests the same connection semantics,
 * which matters for the accept path: idempotency there depends on how a unique violation surfaces,
 * and that is a property of the driver.
 */
export type DbClient = Readonly<{
  /** The typed query builder, with the full schema bound so relational queries work. */
  db: NodePgDatabase<typeof schema>

  /**
   * Raw SQL, for the things a query builder deliberately cannot express.
   *
   * Present for catalogue inspection (does this constraint exist?) and for the advisory locks the
   * concurrency work needs — NOT as a way around the schema. Business queries belong on `db`,
   * where the column types are checked.
   */
  query: (sql: string, parameters?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

  /** A branded transaction handle; outbox intents cannot be created without this callback. */
  transaction: <Result>(operation: (tx: DbTransaction) => Promise<Result>) => Promise<Result>

  /** Release every pooled connection. An un-closed pool keeps the Node event loop alive. */
  close: () => Promise<void>
}>

/**
 * Open a pooled connection to `url`.
 *
 * The caller owns the result and must `close()` it. That is deliberately not hidden behind a
 * `withDb` helper here: the api holds one pool for the process lifetime, while a test wants one per
 * case, and a single helper that assumed either would be wrong for the other.
 */
export const createDbClient = (url: string, poolSize = 10): DbClient => {
  const pool = new Pool({ connectionString: url, max: poolSize })

  // Without this, a connection dropped by the server — a restart, a failover, an idle timeout —
  // surfaces as an unhandled 'error' event on the pool, which takes the whole process down rather
  // than letting the next query reconnect.
  pool.on('error', () => undefined)

  return {
    db: drizzle(pool, { schema }),
    // The row generic is supplied explicitly: pg types `rows` as `any[]` by default, which would
    // flow an unchecked `any` into every caller — exactly what no-unsafe-assignment catches.
    query: async (sql, parameters = []) => {
      const result = await pool.query<Record<string, unknown>>(sql, [...parameters])
      return { rows: result.rows }
    },
    transaction: async (operation) => runInTransaction(pool, operation),
    close: async () => {
      await pool.end()
    },
  }
}
