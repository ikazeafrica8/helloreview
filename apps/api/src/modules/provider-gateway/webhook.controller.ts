import { Controller, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common'
import { InvalidEnvelopeError, platformEventSchema, type AcceptanceResponse } from '@helloreview/contracts'
import { currentCorrelationId } from '@helloreview/observability'
import { ContractErrorFilter } from './contract-error.filter.js'
import { SignatureGuard } from './signature.guard.js'
import { RateLimitGuard } from './rate-limit.guard.js'
import { RAW_BODY, type RequestWithRawBody } from './raw-body.middleware.js'

// The webhook edge (PRD §18.3, T16).
//
// ORDER IS THE DESIGN. Nest runs guards before the handler, and the raw-body middleware before
// both, so the sequence is: collect bytes under a cap -> verify signature -> only then parse. A
// request that fails verification is answered 401 having never been through JSON.parse and having
// touched no table, which is T16's first acceptance criterion stated as control flow rather than
// as a comment.
//
// T17 adds the size, media-type and rate limits around this; T18 replaces the acknowledgement below
// with the idempotent inbox insert. What is here now is the authenticated, validated edge.

@Controller('webhooks')
@UseFilters(ContractErrorFilter)
export class WebhookController {
  @Post(':provider')
  // Order is significant: authenticate FIRST, then limit. Limiting first would let an
  // unauthenticated attacker drain a named provider's bucket — a denial of service against that
  // provider, using the rate limiter as the weapon. Nest runs guards left to right.
  @UseGuards(SignatureGuard, RateLimitGuard)
  accept(@Param('provider') provider: string, @Req() request: RequestWithRawBody): AcceptanceResponse {
    const rawBody = request[RAW_BODY]
    if (rawBody === undefined) throw new InvalidEnvelopeError('request body was not read')

    // Parsed HERE, after the guard, not by a framework pipe before it.
    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody.toString('utf8'))
    } catch {
      // The parser's own message quotes the input, which for this platform means a participant's
      // phone number in an error body and a log line (PRD §21.4).
      throw new InvalidEnvelopeError('body is not valid JSON', 'MALFORMED_JSON')
    }

    const event = platformEventSchema.safeParse(parsed)
    if (!event.success) {
      // Zod's issues name the failing paths and quote values. Neither is returned: a caller learns
      // that the envelope was rejected, not which field would make it pass.
      throw new InvalidEnvelopeError('body does not match the event envelope', 'ENVELOPE_SCHEMA_INVALID')
    }

    if (event.data.source !== provider) {
      // The signature was verified with the path provider's secret. An envelope claiming a
      // different source would otherwise be authenticated by one provider and attributed to
      // another, which is a privilege escalation between providers.
      throw new InvalidEnvelopeError('envelope source does not match the authenticated provider', 'SOURCE_MISMATCH')
    }

    return {
      accepted: true,
      event_id: event.data.eventId,
      duplicate: false,
      ...(currentCorrelationId() === undefined ? {} : { correlation_id: currentCorrelationId() }),
      processing_status: 'queued',
    }
  }
}
