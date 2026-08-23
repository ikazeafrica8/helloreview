// The PRD §18.4 error model, as a typed hierarchy.
//
// §18.4 is a table of HTTP status codes. Implementing it as `throw new HttpException(409)` at each
// call site would scatter the table across the codebase and make it unsearchable — the question
// "what can return 409?" would have no answer short of grepping for the number. One class per row
// means the table is the type system, and a controller maps error to status in one place.
//
// WHY A BASE CLASS. A controller must be able to distinguish "a failure this platform modelled"
// from "something unexpected went wrong". The first is a client-facing status; the second is a 500
// and an alert. `instanceof ContractError` is that line, and it is why nothing here extends Error
// directly.
//
// WHAT DOES NOT BELONG IN `message`. These are rendered into HTTP responses, so the message is
// disclosed to whoever called. Never put a signature, a secret, a token, or a participant
// identifier in one (SPEC.md §8, PRD §21.4). The reasonCode is the machine-readable half and is
// what §23.1 expects in the log line; the message is for a human reading a response body.

/** HTTP statuses the §18.4 table assigns to a modelled failure. 200/202 are successes. */
export type ContractErrorStatus = 400 | 401 | 403 | 409 | 413 | 415 | 422 | 429 | 503

/**
 * Base for every failure PRD §18.4 models.
 *
 * Abstract on purpose: a bare ContractError would have no status, and the whole value of the
 * hierarchy is that the status cannot be forgotten.
 */
export abstract class ContractError extends Error {
  abstract readonly status: ContractErrorStatus

  /**
   * SCREAMING_SNAKE machine-readable cause, for §23.1's `reason_code` log field.
   *
   * Optional because not every failure has a business reason worth naming — a malformed JSON body
   * is fully described by its status — and inventing one per throw site produces a registry nobody
   * can enumerate.
   */
  readonly reasonCode?: string

  constructor(message: string, reasonCode?: string) {
    super(message)
    // Without this, `error.name` is "Error" for every subclass, because the prototype chain is set
    // before the subclass constructor runs. It is what makes a log line say which failure occurred.
    this.name = new.target.name
    if (reasonCode !== undefined) this.reasonCode = reasonCode
  }
}

/** 400 — invalid JSON or an envelope that fails schema validation (§18.3). */
export class InvalidEnvelopeError extends ContractError {
  readonly status = 400 as const
}

/** 401 — missing or invalid authentication, including a failed signature check. */
export class UnauthenticatedError extends ContractError {
  readonly status = 401 as const
}

/** 403 — authenticated, but not permitted to perform this action. */
export class ForbiddenError extends ContractError {
  readonly status = 403 as const
}

/**
 * 409 — a stale workflow version or a semantic conflict.
 *
 * The one that carries the most weight: FR-MSG-007 requires that a delayed event cannot reverse a
 * newer valid state, and this is how that refusal reaches the caller.
 */
export class StaleVersionError extends ContractError {
  readonly status = 409 as const
}

/** 413 — payload or attachment over the configured limit (§18.3). */
export class PayloadTooLargeError extends ContractError {
  readonly status = 413 as const
}

/** 415 — unsupported media type. */
export class UnsupportedMediaTypeError extends ContractError {
  readonly status = 415 as const
}

/**
 * 422 — the schema is valid but the business command is not.
 *
 * Distinct from 400 deliberately. 400 says "this is not one of our events"; 422 says "this is one
 * of our events and we will not act on it" — a campaign that is not active, a transition that is
 * not permitted. The two need different responses from an operator, so they need different codes.
 */
export class UnprocessableCommandError extends ContractError {
  readonly status = 422 as const
}

/** 429 — rate limit exceeded, per provider (§18.3). */
export class RateLimitedError extends ContractError {
  readonly status = 429 as const
}

/** 503 — a dependency or this service is temporarily unavailable. Retryable, unlike the 4xx rows. */
export class DependencyUnavailableError extends ContractError {
  readonly status = 503 as const
}
