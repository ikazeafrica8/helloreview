import { Inject, Injectable, type NestMiddleware } from '@nestjs/common'
import { adoptCorrelationId, runWithCorrelation, type Logger } from '@helloreview/observability'
import { APP_LOGGER } from '../tokens.js'

/** The header a caller may use to continue an existing trace across a service boundary. */
export const CORRELATION_HEADER = 'x-correlation-id'

interface IncomingLike {
  headers: Record<string, unknown>
  method?: string
  url?: string
}

interface OutgoingLike {
  statusCode?: number
  setHeader: (key: string, value: string) => void
  on: (event: string, listener: () => void) => void
}

/**
 * Establish the correlation scope for the whole request, and log its outcome (T10).
 *
 * Middleware rather than an interceptor: middleware runs BEFORE guards, pipes and the router, so a
 * request rejected by a guard — an unauthorized admin call, a webhook with a bad signature — is
 * still scoped and still logged. Those are exactly the requests somebody later wants to trace.
 *
 * An inbound id is adopted only if it validates. It arrives from outside, so a control character in
 * it would let a caller forge a second log line inside the first; adoptCorrelationId mints a fresh
 * one rather than sanitizing, because a forged trace is worse than a discontinuous one.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(@Inject(APP_LOGGER) private readonly logger: Logger) {}

  use(request: IncomingLike, response: OutgoingLike, next: () => void): void {
    const correlationId = adoptCorrelationId(request.headers[CORRELATION_HEADER])

    // Echoed back so a caller — or an operator with a browser open — can quote the id in a report.
    response.setHeader(CORRELATION_HEADER, correlationId)

    runWithCorrelation(correlationId, () => {
      // Logged on 'finish' rather than on entry, so the line carries the status the request actually
      // ended with. The listener is registered INSIDE the scope, so it still sees the id when it runs.
      response.on('finish', () => {
        const status = response.statusCode ?? 0

        // PATH ONLY — the query string is stripped, not merely "not intended to be logged".
        // `request.url` is the raw request target and INCLUDES the query string, so logging it
        // verbatim put whatever a caller passed in `?phone=…` into every request line. This line is
        // written on every single request, so it is the highest-volume place a participant
        // identifier could reach a log (SPEC.md §21.4).
        const path = (request.url ?? '/').split('?')[0] ?? '/'

        this.logger.info(`${request.method ?? 'UNKNOWN'} ${path}`, {
          operation: 'http.request',
          // The status CLASS, so a dashboard can group without parsing.
          result: status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'ok',
          statusCode: status,
        })
      })

      next()
    })
  }
}
