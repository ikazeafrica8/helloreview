import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

// Correlation context (T10).
//
// AsyncLocalStorage rather than a parameter threaded through every signature: SPEC.md §23.1 wants a
// correlation id on EVERY log line, and a codebase where twenty modules each pass a `ctx` argument
// down to their repositories is one where somebody eventually forgets and a trace goes dark.
//
// The store survives await boundaries and nests correctly, so a job handler running inside a request
// scope sees the id it inherited rather than the one that happened to be set last.

const storage = new AsyncLocalStorage<string>()

/** Long enough to be unique, short enough to read in a terminal. */
const MAX_LENGTH = 128

/**
 * Whether a value may be used as a correlation id.
 *
 * Inbound ids come from OUTSIDE — a provider webhook header, a job payload — so they are untrusted
 * input. A control character would let a caller forge a second log line inside the first, which is
 * log injection: the reason this rejects rather than sanitizes is that a forged trace is worse than
 * a missing one.
 */
export const isCorrelationId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  value.length <= MAX_LENGTH &&
  // Printable ASCII only: no newline, no tab, no control character.
  /^[\w.:-]+$/.test(value)

export const newCorrelationId = (): string => `cor_${randomUUID().replaceAll('-', '')}`

/**
 * Adopt an inbound id if it is usable, otherwise mint one.
 *
 * SPEC.md §18.3 requires a correlation id on every request; T10 requires that a valid inbound one be
 * REUSED, so a participant interaction spanning several services stays one trace.
 */
export const adoptCorrelationId = (inbound: unknown): string =>
  isCorrelationId(inbound) ? inbound : newCorrelationId()

/** Run `body` with `id` as the ambient correlation id. Nests and restores correctly. */
export const runWithCorrelation = <T>(id: string, body: () => T): T => storage.run(id, body)

/**
 * The ambient correlation id, or undefined outside any scope.
 *
 * Undefined rather than a freshly minted id: fabricating one here would silently join unrelated
 * interactions into a single trace, which is worse than an honestly absent field.
 */
export const currentCorrelationId = (): string | undefined => storage.getStore()
