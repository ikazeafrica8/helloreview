// The minimum HTTP surface this module actually uses.
//
// Structural types rather than `@types/express`. Two reasons, in order of importance:
//
//   1. It states the dependency exactly. The raw-body middleware needs four things from a request —
//      the ability to stream it, destroy it, and read its headers and route params — and nothing
//      else. Importing the full Express typings would let any of that quietly grow.
//   2. `@types/express` is not currently a dependency of this workspace, and SPEC.md §8 puts adding
//      one under "Ask first". Express itself is present transitively via @nestjs/platform-express,
//      so this is a typing convenience, not a capability we lack.
//
// If a later task genuinely needs Express's full surface, adding the typings is a small, explicit
// change — and these interfaces will still describe what the gateway relies on.

/** A readable request body, as Node's stream events expose it. */
export interface StreamingRequest {
  on: ((event: 'data', listener: (chunk: Buffer) => void) => unknown) &
    ((event: 'end', listener: () => void) => unknown) &
    ((event: 'error', listener: (error: Error) => void) => unknown)
  /**
   * Stop reading. This is what bounds memory: once paused, TCP backpressure stops the sender
   * rather than us continuing to buffer a body we have already decided to refuse.
   */
  pause: () => unknown
  /** Closes the socket. Used only AFTER a response has been written — see the middleware. */
  destroy: (error?: Error) => unknown
}

/** Incoming headers, as Node lowercases them. Values may be absent or repeated. */
export type IncomingHeaders = Readonly<Record<string, string | string[] | undefined>>

export interface GatewayRequest extends StreamingRequest {
  headers: IncomingHeaders
  /** Route parameters. `:provider` for the webhook route. */
  params: Readonly<Record<string, string | undefined>>
}

export interface GatewayResponse {
  status: (code: number) => GatewayResponse
  json: (body: unknown) => unknown
  /** Fires once the response has been flushed. The only safe moment to close the connection. */
  on: (event: 'finish', listener: () => void) => unknown
}

/** Express's `next`, which takes an error or nothing. */
export type NextFunction = (error?: unknown) => void

/**
 * Flatten a header value to the single string a signature check needs.
 *
 * A repeated header arrives as an array. Taking the FIRST value rather than joining is deliberate:
 * a request carrying two signature headers is either broken or an attempt at request smuggling, and
 * joining them would produce a string that matches neither while looking like a normal mismatch.
 */
export const singleHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

/** Narrow incoming headers to the flat shape the verifier port expects. */
export const flattenHeaders = (headers: IncomingHeaders): Record<string, string | undefined> => {
  const flat: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) flat[key] = singleHeader(value)
  return flat
}
