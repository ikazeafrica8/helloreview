import type { Pool } from 'pg'

const transactionBrand: unique symbol = Symbol('DbTransaction')

export type DbTransaction = Readonly<{
  query: (sql: string, parameters?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  readonly [transactionBrand]: 'DbTransaction'
}>

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
