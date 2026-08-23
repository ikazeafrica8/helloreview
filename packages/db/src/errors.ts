// Recognising a database refusal, safely.
//
// The idempotency spine is built on the database REFUSING a duplicate rather than on the
// application avoiding one (PRD §17.3). That only works if the refusal can be told apart from every
// other failure — a not-null violation, a dropped connection, a syntax error — because the accept
// path treats one of them as "already have it, return the prior result" and the rest as errors.
//
// HOW THE REFUSAL ACTUALLY ARRIVES, measured against Postgres 16 and drizzle-orm 0.45:
//
//   DrizzleQueryError            <- what is thrown; has NO `code`
//     .cause -> DatabaseError    <- the pg error; `code === '23505'`, `constraint === '<name>'`
//
// Checking `error.code === '23505'` on the thrown value therefore does nothing, silently: it is
// always undefined, so every duplicate would be treated as an unexpected failure and the whole
// idempotency guarantee would degrade into 500s. That is a one-line mistake with no symptom in
// development, where duplicates are rare.
//
// A PII HAZARD LIVES ON THE SAME OBJECT. DrizzleQueryError carries `.query` (the SQL text) and
// `.params` (THE BOUND VALUES), and its `.message` embeds the query. For an application.created
// event the params include a participant's name and phone number. So:
//
//   - never log the error object,
//   - never log `.params`,
//   - never put `String(error)` in a log line or an HTTP response.
//
// `describeDatabaseFailure` below is the safe way to say what happened (SPEC.md §8, PRD §21.4).

/** Postgres SQLSTATE codes this platform reacts to by name rather than by message text. */
const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const

/**
 * Read an own property off an unknown value without asserting a shape onto it.
 *
 * `Object.getOwnPropertyDescriptor`, NOT an object spread. `new Error(message, { cause })` defines
 * `cause` as a NON-ENUMERABLE own property, and spread copies only enumerable ones — so
 * `{ ...error }.cause` is undefined for every natively-chained error. The first version of this
 * module used spread; it read the drizzle wrapper correctly (whose `cause` is enumerable, being
 * set by Object.assign) and silently failed on any deeper chain. Caught by a test, not by review.
 *
 * A getter is deliberately not invoked: calling an unknown accessor while handling an error is a
 * good way to throw from the error path.
 */
const ownProperty = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

const ownString = (value: unknown, key: string): string | undefined => {
  const found = ownProperty(value, key)
  return typeof found === 'string' ? found : undefined
}

/**
 * Walk the `cause` chain looking for a string property, wherever the driver buried it.
 *
 * Bounded: a self-referential cause is a two-character mistake, and an unbounded walk would hang
 * the request rather than fail it. The depth is generous because the number of wrappers is a
 * property of the driver version and has already changed once.
 */
const findInCauseChain = (error: unknown, key: string): string | undefined => {
  let current = error
  for (let depth = 0; depth < 5; depth += 1) {
    const found = ownString(current, key)
    if (found !== undefined) return found
    current = ownProperty(current, 'cause')
    if (current === undefined) return undefined
  }
  return undefined
}

/** The SQLSTATE of a database failure, wherever the driver buried it. */
export const sqlStateOf = (error: unknown): string | undefined => findInCauseChain(error, 'code')

/** The constraint a failure names, if it named one. */
export const violatedConstraint = (error: unknown): string | undefined => findInCauseChain(error, 'constraint')

/**
 * Was this the database refusing a duplicate?
 *
 * Pass `constraint` when the caller knows which one it expects. The accept path does: a unique
 * violation on `event_inbox_source_external_id_key` means "already received", while a violation on
 * some other constraint means something genuinely unexpected happened and must not be swallowed as
 * a successful duplicate.
 */
export const isUniqueViolation = (error: unknown, constraint?: string): boolean => {
  if (sqlStateOf(error) !== SQLSTATE.UNIQUE_VIOLATION) return false
  return constraint === undefined || violatedConstraint(error) === constraint
}

/** Is this worth retrying as-is? Both of these mean "the database gave up, try again". */
export const isRetryableDatabaseFailure = (error: unknown): boolean => {
  const state = sqlStateOf(error)
  return state === SQLSTATE.SERIALIZATION_FAILURE || state === SQLSTATE.DEADLOCK_DETECTED
}

/**
 * A log-safe description of a database failure.
 *
 * Returns the SQLSTATE and the constraint name — both structural, neither derived from a bound
 * value. Deliberately returns no message: the driver's message embeds the SQL, and the object it
 * came from carries the parameters, which for this platform means participant names and phone
 * numbers.
 */
export const describeDatabaseFailure = (error: unknown): { sqlState: string; constraint?: string } => {
  const sqlState = sqlStateOf(error) ?? 'unknown'
  const constraint = violatedConstraint(error)
  return constraint === undefined ? { sqlState } : { sqlState, constraint }
}
