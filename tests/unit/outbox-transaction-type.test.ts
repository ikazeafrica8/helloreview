import { expect, test } from 'vitest'
import type { DbTransaction } from '../../packages/db/src/index.js'

const enqueueIntent = (_tx: DbTransaction): Promise<void> => Promise.resolve()

test('DbTransaction is branded and cannot be constructed outside db.transaction()', () => {
  const structuralLookalike = {
    query: (): Promise<{ rows: Record<string, unknown>[] }> => Promise.resolve({ rows: [] }),
  }

  // @ts-expect-error -- the non-exported transaction brand is intentionally missing.
  void enqueueIntent(structuralLookalike)
  expect(structuralLookalike).toHaveProperty('query')
})
