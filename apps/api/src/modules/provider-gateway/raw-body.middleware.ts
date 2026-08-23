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
export const collectRawBody = async (request: StreamingRequest, limitBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let settled = false

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      action()
    }

    request.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > limitBytes) {
        // PAUSE, do not destroy. Pausing is what bounds memory: TCP backpressure stops the sender
        // rather than this process continuing to buffer a body it has already decided to refuse.
        //
        // Destroying here instead — the first version of this code — killed the socket before the
        // 413 could be written, so the client saw ECONNRESET and never learned why. An unexplained
        // reset is indistinguishable from a network fault, which is a miserable thing to hand a
        // provider integrating against you. The socket IS closed, but only after the response.
        request.pause()
        chunks.length = 0
        finish(() => {
          reject(new PayloadTooLargeStreamError(limitBytes))
        })
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      finish(() => {
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
 * Registered for the webhook path only. Everything else keeps the framework's ordinary parsing,
 * because disabling it globally would make every future endpoint pay for this one's constraints.
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
          // Answered here rather than thrown into Nest's filter chain: the stream is paused
          // mid-body, so there is no complete request for a controller to handle.
          //
          // The connection is closed only once the response has flushed. Closing it any earlier
          // races the write and produces the ECONNRESET this ordering exists to avoid.
          response.on('finish', () => {
            request.destroy()
          })
          response.status(413).json({ accepted: false, reason_code: 'PAYLOAD_TOO_LARGE' })
          return
        }
        next(error)
      },
    )
  }
