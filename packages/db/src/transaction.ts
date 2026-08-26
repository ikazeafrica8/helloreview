import type { Pool, PoolClient } from 'pg'

const transactionBrand: unique symbol = Symbol('DbTransaction')

export type DbTransaction = Readonly<{
  query: (sql: string, parameters?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  readonly [transactionBrand]: 'DbTransaction'
}>

/**
 * Bind an already-BEGIN'd pg client to the branded outbox transaction contract.
 *
 * Use only inside a service that owns the surrounding BEGIN/COMMIT/ROLLBACK. This exists for
 * workflows that must commit a rejected-attempt audit before returning an application error.
 */
export const bindDbTransaction = (client: PoolClient): DbTransaction => ({
  query: async (sql: string, parameters: readonly unknown[] = []) => {
    const result = await client.query<Record<string, unknown>>(sql, [...parameters])
    return { rows: result.rows }
  },
  [transactionBrand]: 'DbTransaction',
})

/**
 * The only constructor for the branded transaction token accepted by transactional outbox writes.
 */
export const runInTransaction = async <Result>(
  pool: Pool,
  operation: (tx: DbTransaction) => Promise<Result>,
): Promise<Result> => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tx: DbTransaction = {
      query: async (sql: string, parameters: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
        const result = await client.query<Record<string, unknown>>(sql, [...parameters])
        return { rows: result.rows }
      },
      [transactionBrand]: 'DbTransaction',
    }
    const result = await operation(tx)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
