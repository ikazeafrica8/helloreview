import type { GatewayRequest, GatewayResponse, NextFunction, StreamingRequest } from './http.js'

// Collecting the webhook body ourselves, before anything parses it (PRD §18.3, T16/T17).
//
// WHY NOT THE FRAMEWORK'S BODY PARSER. Two reasons, and both are the acceptance criteria:
//
//   1. T16 requires an invalid signature to be rejected "before the body is parsed or persisted".
//      A body parser that has already run has, by definition, parsed an unauthenticated body — and
//      JSON.parse on hostile input is not free. Nest's `rawBody: true` option keeps the bytes but
//      still parses first, so it does not satisfy this.
//   2. T17 requires oversized payloads to be rejected "without being buffered entirely into
//      memory". That means counting bytes as they arrive and destroying the stream the moment the
//      limit is passed, which a parser configured with a limit does only after its own buffering
//      decisions.
//
// So the raw bytes are collected here, with a hard cap, and nothing downstream sees a parsed body
// until the signature has been checked.

/** Where the collected bytes are attached. Read by the signature guard and the controller. */
export const RAW_BODY = Symbol.for('helloreview.rawBody')

export type RequestWithRawBody = GatewayRequest & { [RAW_BODY]?: Buffer }

export class PayloadTooLargeStreamError extends Error {
  constructor(readonly limitBytes: number) {
    super('payload exceeds the configured limit')
    this.name = 'PayloadTooLargeStreamError'
  }
}

/**
 * Read the request stream into a Buffer, refusing to exceed `limitBytes`.
 *
 * The running total is checked on EVERY chunk rather than once at the end, and the stream is
 * destroyed as soon as it is exceeded. Checking Content-Length instead would be worse than
 * useless: it is a claim by the sender, and a chunked request need not send one at all.
 */
/**
 * How much MORE than the limit we are willing to read and throw away.
 *
 * Once the limit is passed the body is refused, but the sender is usually still transmitting. Two
 * bad options and one good one:
 *
 *   - Close the socket immediately: the 413 never reaches the client, which sees ECONNRESET and
 *     cannot tell a refusal from a network fault. (Measured: the test for this was flaky for
 *     exactly this reason, passing or failing on the timing of a 2 MB upload.)
 *   - Read to the end however long that takes: an attacker holds a connection open indefinitely.
 *   - Read a BOUNDED amount more, discarding every byte, then answer properly. A client that
 *     slightly overshoots gets a clean 413; one sending five times the limit gets cut off.
 *
 * Memory is bounded either way — nothing past the limit is ever retained. This allowance bounds
 * TIME and BANDWIDTH, which are the other two things a large upload costs.
 */
const DRAIN_ALLOWANCE_MULTIPLIER = 4

export const collectRawBody = async (request: StreamingRequest, limitBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let discarded = 0
    let overLimit = false
    let settled = false

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      action()
    }

    request.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (overLimit) {
        // Already refused. Discard rather than retain — memory is bounded from here on — but keep
        // reading so the client can finish and receive a real 413 instead of a reset.
        discarded += chunk.length
        if (discarded > limitBytes * DRAIN_ALLOWANCE_MULTIPLIER) {
          request.destroy()
          finish(() => {
            reject(new PayloadTooLargeStreamError(limitBytes))
          })
        }
        return
      }

      if (received > limitBytes) {
        // The moment of refusal. Everything buffered so far is dropped immediately, so peak memory
        // is the limit and not the body.
        overLimit = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      finish(() => {
        if (overLimit) {
          reject(new PayloadTooLargeStreamError(limitBytes))
          return
        }
        resolve(Buffer.concat(chunks))
      })
    })

    request.on('error', (error: Error) => {
      finish(() => {
        reject(error)
      })
    })
  })

/**
 * Express middleware that attaches the raw body and never parses it.
 *
 * Registered for the webhook path only — but READ THE NEXT PARAGRAPH BEFORE ADDING A ROUTE.
 *
 * Body parsing is disabled APPLICATION-WIDE at main.ts (`bodyParser: false`), not merely bypassed
 * here. Nothing registers a parser anywhere. An earlier version of this comment said "everything
 * else keeps the framework's ordinary parsing", which was false and is the single most likely
 * trap for the next person adding a POST endpoint: `@Body() dto` will arrive `undefined`, with no
 * error and nothing pointing at the cause.
 *
 * A route that wants a parsed body must opt in with its own parsing middleware. That is the right
 * default for a service whose only untrusted input arrives over HTTP — parse explicitly, never
 * implicitly — but it is a default that has to be known.
 */
export const createRawBodyMiddleware =
  (limitBytes: number) =>
  (request: RequestWithRawBody, response: GatewayResponse, next: NextFunction): void => {
    collectRawBody(request, limitBytes).then(
      (raw) => {
        request[RAW_BODY] = raw
        next()
      },
      (error: unknown) => {
        if (error instanceof PayloadTooLargeStreamError) {
          // Answered here rather than thrown into Nest's filter chain: there is no parsed body for
          // a controller to have been given, and no route was ever matched.
          response.status(413).json({ accepted: false, reason_code: 'PAYLOAD_TOO_LARGE' })
          return
        }
        next(error)
      },
    )
  }
