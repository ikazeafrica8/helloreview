// Unit tier: recognising a database refusal without leaking what caused it (T15).
//
// The integration suite proves these helpers work against a real Postgres. These prove the two
// properties that a real database cannot demonstrate on its own: that the cause chain is walked
// rather than peeked at, and that nothing here hands a caller a value that came off the wire.

import { test, describe, expect } from 'vitest'
import {
  isUniqueViolation,
  isRetryableDatabaseFailure,
  sqlStateOf,
  violatedConstraint,
  describeDatabaseFailure,
} from '../../packages/db/src/errors.js'

/**
 * The shape drizzle-orm 0.45 actually throws, measured: a wrapper with the pg error as `cause`.
 *
 * `params` is named in the type because one test below asserts on it — it is the field carrying
 * the bound values, and therefore the participant data this module exists to keep out of logs.
 */
type FakeDrizzleQueryError = Error & { query: string; params: readonly unknown[]; cause: Error }

const drizzleQueryError = (code: string, constraint?: string): FakeDrizzleQueryError => {
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  })
  return Object.assign(new Error('Failed query: insert into "event_inbox" ...'), {
    query: 'insert into "event_inbox" ...',
    // The hazard this module exists to route around: the bound values live here.
    params: ['홍길동', '+821012345678'],
    cause: pgError,
  })
}

describe('sqlStateOf walks the cause chain', () => {
  test('finds a code nested one level down, where drizzle actually puts it', () => {
    expect(sqlStateOf(drizzleQueryError('23505'))).toBe('23505')
  })

  test('finds a code on the error itself, for a driver that does not wrap', () => {
    expect(sqlStateOf(Object.assign(new Error('x'), { code: '23505' }))).toBe('23505')
  })

  test('finds a code buried deeper, because the wrapper count is a driver detail', () => {
    // It has already changed once between drizzle versions. Reading exactly one level would work
    // today and silently stop working on an upgrade — with no symptom until a duplicate arrives.
    const deep = new Error('outer', { cause: new Error('middle', { cause: drizzleQueryError('23505') }) })
    expect(sqlStateOf(deep)).toBe('23505')
  })

  test('returns undefined rather than throwing for things that are not database errors', () => {
    for (const value of [undefined, null, 'a string', 42, {}, new Error('plain')]) {
      expect(sqlStateOf(value)).toBeUndefined()
    }
  })

  test('a self-referential cause terminates instead of spinning', () => {
    // Not hypothetical: a wrapper that sets `cause` to itself is a two-character mistake, and an
    // unbounded walk would hang the request rather than fail it.
    const looping: { cause?: unknown } = {}
    looping.cause = looping
    expect(sqlStateOf(looping)).toBeUndefined()
  })
})

describe('violatedConstraint', () => {
  test('names the constraint from the nested pg error', () => {
    expect(violatedConstraint(drizzleQueryError('23505', 'event_inbox_source_external_id_key'))).toBe(
      'event_inbox_source_external_id_key',
    )
  })

  test('is undefined when the failure names none, rather than inventing one', () => {
    // A not-null violation carries a column, not a constraint. Returning a plausible-looking string
    // here would make the accept path's constraint check silently match the wrong thing.
    expect(violatedConstraint(drizzleQueryError('23502'))).toBeUndefined()
    expect(violatedConstraint(new Error('connection terminated'))).toBeUndefined()
  })
})

describe('isUniqueViolation', () => {
  test('is true for 23505', () => {
    expect(isUniqueViolation(drizzleQueryError('23505'))).toBe(true)
  })

  test.each([
    ['a not-null violation', '23502'],
    ['a foreign key violation', '23503'],
    ['a check violation', '23514'],
    ['a deadlock', '40P01'],
  ])('is false for %s — only a duplicate means "already have it"', (_label, code) => {
    expect(isUniqueViolation(drizzleQueryError(code))).toBe(false)
  })

  test('when a constraint is named, only THAT constraint counts', () => {
    // The accept path depends on this. A unique violation on a different constraint means
    // something unexpected happened, and swallowing it as a duplicate would return 202 for an
    // event that was never stored.
    const error = drizzleQueryError('23505', 'event_inbox_source_external_id_key')

    expect(isUniqueViolation(error, 'event_inbox_source_external_id_key')).toBe(true)
    expect(isUniqueViolation(error, 'outbound_notifications_dedupe_key')).toBe(false)
  })

  test('an unconstrained check still passes when no constraint name is available', () => {
    expect(isUniqueViolation(drizzleQueryError('23505'), undefined)).toBe(true)
  })
})

describe('isRetryableDatabaseFailure', () => {
  test.each([
    ['a serialization failure', '40001'],
    ['a deadlock', '40P01'],
  ])('%s is retryable', (_label, code) => {
    expect(isRetryableDatabaseFailure(drizzleQueryError(code))).toBe(true)
  })

  test('a unique violation is NOT retryable — retrying produces the identical refusal', () => {
    expect(isRetryableDatabaseFailure(drizzleQueryError('23505'))).toBe(false)
  })
})

describe('describeDatabaseFailure never discloses a bound value', () => {
  test('reports the SQLSTATE and constraint, and nothing else', () => {
    const described = describeDatabaseFailure(drizzleQueryError('23505', 'event_inbox_source_external_id_key'))
    expect(described).toEqual({ sqlState: '23505', constraint: 'event_inbox_source_external_id_key' })
  })

  test('the description carries no participant data, even though the error object does', () => {
    // The whole reason this function exists. DrizzleQueryError holds `.params` — the bound values —
    // and embeds the SQL in `.message`. For an application.created insert those params are a name
    // and a phone number, so logging the error is a §21.4 leak while logging this is not.
    const error = drizzleQueryError('23505', 'event_inbox_source_external_id_key')
    const serialized = JSON.stringify(describeDatabaseFailure(error))

    expect(serialized).not.toContain('홍길동')
    expect(serialized).not.toContain('821012345678')
    expect(serialized).not.toContain('insert into')

    // And a demonstration that the naive alternative would have leaked both.
    expect(JSON.stringify({ params: error.params })).toContain('821012345678')
  })

  test('an unrecognisable failure still produces something loggable', () => {
    expect(describeDatabaseFailure(new Error('connection terminated'))).toEqual({ sqlState: 'unknown' })
  })
})
