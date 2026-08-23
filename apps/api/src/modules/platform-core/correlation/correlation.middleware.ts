import { Injectable, type NestMiddleware } from '@nestjs/common'
import { adoptCorrelationId, runWithCorrelation } from '@helloreview/observability'

/** The header a caller may use to continue an existing trace across a service boundary. */
export const CORRELATION_HEADER = 'x-correlation-id'

/**
 * Establish the correlation scope for the whole request (T10).
 *
 * Middleware rather than an interceptor: middleware runs BEFORE guards, pipes and the router, so a
 * request rejected by a guard — an unauthorized admin call, a webhook with a bad signature — is
 * still logged under an id. Those are exactly the requests somebody will later want to trace.
 *
 * An inbound id is adopted only if it passes validation. It arrives from outside, so a control
 * character in it would let a caller forge a second log line inside the first; adoptCorrelationId
 * mints a fresh one rather than sanitizing, because a forged trace is worse than a discontinuous one.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(
    request: { headers: Record<string, unknown> },
    response: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ): void {
    const correlationId = adoptCorrelationId(request.headers[CORRELATION_HEADER])

    // Echoed back so a caller — or an operator with a browser open — can quote the id in a report.
    response.setHeader(CORRELATION_HEADER, correlationId)

    runWithCorrelation(correlationId, next)
  }
}
