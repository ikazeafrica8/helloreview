// Unit tier: the PRD §18 event contracts (T14).
//
// Every fixture below is copied VERBATIM from the PRD. That is the point of this file — the
// schemas are only worth anything if the documents they claim to implement actually parse against
// them, and a fixture someone retyped to match the schema proves the schema matches itself.
//
// Both directions are covered. Accepting the documented shape is the contract; REJECTING a
// malformed one is what makes the schema a validator rather than a cast. §18.3 requires "schema
// validation before acceptance", so anything that slips through here reaches the inbox.

import { test, describe, expect } from 'vitest'
import {
  platformEventSchema,
  acceptanceResponseSchema,
  EVENT_TYPES,
  MESSAGE_PURPOSES,
  ALL_MESSAGE_PURPOSES,
  isMessagePurpose,
  ContractError,
  InvalidEnvelopeError,
  UnauthenticatedError,
  ForbiddenError,
  StaleVersionError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  UnprocessableCommandError,
  RateLimitedError,
  DependencyUnavailableError,
} from '../../packages/contracts/src/index.js'

/** The §18.1 envelope, verbatim. Payload is supplied per-case by the fixtures below. */
const ENVELOPE = {
  event_id: 'evt_01JEXAMPLE',
  event_version: 1,
  source: 'helloreview_website',
  occurred_at: '2026-08-22T10:30:00+09:00',
  received_at: '2026-08-22T10:30:01+09:00',
  correlation_id: 'cor_01JEXAMPLE',
  idempotency_key: 'helloreview_website:application:app_123:create:v1',
}

/** One entry per PRD subsection §18.5–§18.15, each payload copied from the document. */
const PRD_EXAMPLES = [
  [
    '§18.5 new application',
    'application.created',
    {
      application_id: 'app_123',
      campaign_id: 'camp_456',
      application_status: 'completed',
      application_source: 'website',
      applicant: {
        name: '홍길동',
        phone_normalized: '+821012345678',
        blog_url: 'https://example.invalid/blog',
      },
      submitted_at: '2026-08-22T10:30:00+09:00',
    },
  ],
  [
    '§18.6 application updated',
    'application.updated',
    {
      application_id: 'app_123',
      changed_fields: ['application_status'],
      application_status: 'cancelled',
      source_version: 7,
    },
  ],
  [
    '§18.7 selection updated',
    'selection.updated',
    {
      application_id: 'app_123',
      campaign_id: 'camp_456',
      selection_result: 'manually_selected',
      decision_id: 'sel_789',
      decision_reason_code: 'OPERATOR_APPROVED',
      rule_version: 'selection-v3',
    },
  ],
  [
    '§18.8 incoming KakaoTalk message',
    'channel.message.received',
    {
      provider: 'official_kakao_provider',
      external_message_id: 'provider-message-123',
      external_conversation_id: 'provider-conversation-456',
      external_user_id: 'provider-user-789',
      message_type: 'text',
      text: '신청 완료했습니다',
      sent_at: '2026-08-22T11:00:00+09:00',
    },
  ],
  [
    '§18.9 incoming attachment',
    'channel.attachment.received',
    {
      provider: 'official_kakao_provider',
      external_message_id: 'provider-message-124',
      external_conversation_id: 'provider-conversation-456',
      attachment_type: 'image',
      provider_attachment_reference: 'opaque-reference',
      declared_mime_type: 'image/jpeg',
      declared_size_bytes: 345678,
    },
  ],
  [
    '§18.10 Aligo delivery result',
    'message.delivery.updated',
    {
      provider: 'aligo',
      provider_message_id: 'aligo-message-123',
      internal_notification_id: 'not_456',
      delivery_status: 'delivered',
      delivered_at: '2026-08-22T11:02:00+09:00',
      provider_status_code: 'NORMALIZED_PROVIDER_CODE',
    },
  ],
  [
    '§18.11 business approval updated',
    'business_approval.updated',
    {
      workflow_id: 'wf_123',
      campaign_id: 'camp_456',
      approval_state: 'approved',
      approval_version: 2,
      approved_by: 'operator_789',
      approved_at: '2026-08-22T13:00:00+09:00',
      expires_at: '2026-08-29T23:59:59+09:00',
    },
  ],
  [
    '§18.12 reservation submitted',
    'reservation.submitted',
    {
      workflow_id: 'wf_123',
      submission_type: 'screenshot',
      attachment_id: 'att_456',
      participant_message_id: 'msg_789',
      reservation_version: 1,
    },
  ],
  [
    '§18.13 guideline-delivery request',
    'guideline.delivery.requested',
    {
      workflow_id: 'wf_123',
      guideline_version: 'guideline-v4',
      triggering_event_id: 'evt_456',
      requested_reason: 'READINESS_PREDICATE_PASSED',
    },
  ],
  [
    '§18.14 human handoff created',
    'human_review.created',
    {
      workflow_id: 'wf_123',
      reason_code: 'IDENTITY_AMBIGUOUS',
      priority: 'high',
      automation_paused: true,
      source_event_id: 'evt_456',
    },
  ],
  [
    '§18.15 human review completed',
    'human_review.completed',
    {
      task_id: 'task_123',
      workflow_id: 'wf_456',
      resolution_code: 'IDENTITY_CONFIRMED',
      operator_id: 'operator_789',
      return_to_automation: true,
      resolution_reason: 'Application ID verified through approved process',
    },
  ],
] as const

describe('every PRD §18 example parses against its schema', () => {
  test.each(PRD_EXAMPLES)('%s', (_label, eventType, payload) => {
    const result = platformEventSchema.safeParse({ ...ENVELOPE, event_type: eventType, payload })

    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(true)
  })

  test('every §18.5–§18.15 subsection is represented, so none was quietly skipped', () => {
    // Guards against the failure where a payload schema is deleted or renamed and the loop above
    // simply iterates over fewer cases while still reporting green.
    expect(PRD_EXAMPLES).toHaveLength(11)
    const covered = new Set(PRD_EXAMPLES.map(([, eventType]) => eventType))
    for (const eventType of Object.values(EVENT_TYPES)) {
      expect(covered.has(eventType)).toBe(true)
    }
  })
})

describe('the envelope is parsed into the domain shape', () => {
  const [, eventType, payload] = PRD_EXAMPLES[0]

  test('wire snake_case becomes domain camelCase, the way the config loader does it', () => {
    // Same boundary decision as packages/config, which turns DATABASE_URL into config.databaseUrl:
    // the wire format is the provider's, the domain shape is ours, and the schema is where they
    // meet. A provider renaming a field then changes one line here instead of every call site.
    const event = platformEventSchema.parse({ ...ENVELOPE, event_type: eventType, payload })

    expect(event.eventId).toBe('evt_01JEXAMPLE')
    expect(event.eventType).toBe('application.created')
    expect(event.eventVersion).toBe(1)
    expect(event.source).toBe('helloreview_website')
    expect(event.correlationId).toBe('cor_01JEXAMPLE')
    expect(event.idempotencyKey).toBe('helloreview_website:application:app_123:create:v1')
  })

  test('the payload is narrowed by event type, not left as unknown', () => {
    const event = platformEventSchema.parse({ ...ENVELOPE, event_type: eventType, payload })

    // The discriminant is what makes this a contract rather than a bag: reading a field off the
    // payload must not require a cast, which is what no-unsafe-type-assertion forbids anyway.
    if (event.eventType !== 'application.created') throw new Error('discriminant did not narrow')
    expect(event.payload.applicationId).toBe('app_123')
    expect(event.payload.applicant.phoneNormalized).toBe('+821012345678')
  })

  test('optional envelope fields are genuinely optional', () => {
    // received_at and correlation_id are stamped by the receiver, so a producer legitimately omits
    // them. Requiring them would reject valid traffic at the edge.
    const { received_at: _r, correlation_id: _c, ...minimal } = ENVELOPE
    expect(platformEventSchema.safeParse({ ...minimal, event_type: eventType, payload }).success).toBe(true)
  })
})

describe('malformed envelopes are rejected, because §18.3 validates before acceptance', () => {
  const [, eventType, payload] = PRD_EXAMPLES[0]
  const valid = { ...ENVELOPE, event_type: eventType, payload }

  test.each([
    ['an unknown event type', { ...valid, event_type: 'application.exploded' }],
    ['a missing event id', { ...valid, event_id: undefined }],
    ['an empty event id', { ...valid, event_id: '' }],
    ['a missing idempotency key', { ...valid, idempotency_key: undefined }],
    ['a non-integer event version', { ...valid, event_version: 1.5 }],
    ['a zero event version', { ...valid, event_version: 0 }],
    ['an unparseable occurred_at', { ...valid, occurred_at: 'yesterday' }],
    ['a payload that does not match the event type', { ...valid, payload: { nothing: 'relevant' } }],
    ['a null payload', { ...valid, payload: null }],
    ['a non-object body', 'not an envelope'],
  ])('rejects %s', (_label, body) => {
    expect(platformEventSchema.safeParse(body).success).toBe(false)
  })

  test('an unrecognised payload field is rejected rather than silently dropped', () => {
    // Strict, deliberately. A provider that starts sending a field we do not model is a contract
    // change worth noticing at the edge — silently discarding it means the first symptom is a
    // business rule quietly operating on incomplete data.
    const result = platformEventSchema.safeParse({
      ...valid,
      payload: { ...payload, unexpected_field: 'surprise' },
    })
    expect(result.success).toBe(false)
  })
})

describe('the §18.2 acceptance response', () => {
  test('parses the documented example verbatim', () => {
    const result = acceptanceResponseSchema.safeParse({
      accepted: true,
      event_id: 'evt_01JEXAMPLE',
      duplicate: false,
      correlation_id: 'cor_01JEXAMPLE',
      processing_status: 'queued',
    })
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true)
  })

  test('rejects a processing status outside the documented set', () => {
    expect(
      acceptanceResponseSchema.safeParse({
        accepted: true,
        event_id: 'evt_1',
        duplicate: false,
        processing_status: 'probably_fine',
      }).success,
    ).toBe(false)
  })
})

describe('the §18.4 error model is a typed hierarchy, not a status-code literal', () => {
  test.each([
    ['invalid envelope', new InvalidEnvelopeError('bad json'), 400],
    ['unauthenticated', new UnauthenticatedError('no signature'), 401],
    ['forbidden', new ForbiddenError('not permitted'), 403],
    ['stale version', new StaleVersionError('workflow moved on'), 409],
    ['payload too large', new PayloadTooLargeError('too big'), 413],
    ['unsupported media type', new UnsupportedMediaTypeError('not json'), 415],
    ['unprocessable command', new UnprocessableCommandError('valid shape, invalid command'), 422],
    ['rate limited', new RateLimitedError('slow down'), 429],
    ['dependency unavailable', new DependencyUnavailableError('provider down'), 503],
  ])('%s maps to HTTP %i', (_label, error, status) => {
    expect(error.status).toBe(status)
    // One base class, so a controller can catch the family without enumerating every member — and
    // so an error that is NOT one of ours cannot be mistaken for a modelled failure.
    expect(error instanceof ContractError).toBe(true)
    expect(error instanceof Error).toBe(true)
  })

  test('every §18.4 status with a modelled cause is covered', () => {
    // 200/202 are successes rather than errors, so the error hierarchy covers the other nine rows.
    const covered = [
      new InvalidEnvelopeError('x'),
      new UnauthenticatedError('x'),
      new ForbiddenError('x'),
      new StaleVersionError('x'),
      new PayloadTooLargeError('x'),
      new UnsupportedMediaTypeError('x'),
      new UnprocessableCommandError('x'),
      new RateLimitedError('x'),
      new DependencyUnavailableError('x'),
    ].map((error) => error.status)

    expect(new Set(covered)).toEqual(new Set([400, 401, 403, 409, 413, 415, 422, 429, 503]))
  })

  test('a reason code travels with the error, because §23.1 logs one', () => {
    const error = new UnprocessableCommandError('cannot apply', 'CAMPAIGN_NOT_ACTIVE')
    expect(error.reasonCode).toBe('CAMPAIGN_NOT_ACTIVE')
  })

  test('the message never has to carry a secret to be useful', () => {
    // Regression guard on a habit rather than on code: these errors are rendered into HTTP
    // responses, so anything put in `message` is disclosed to the caller.
    const error = new UnauthenticatedError('signature verification failed')
    expect(error.message).not.toMatch(/secret|token|signature=|Bearer/i)
  })
})

describe('message purpose codes are one registry with a derived union', () => {
  test('every code is SCREAMING_SNAKE, as SPEC.md §6 requires', () => {
    for (const purpose of ALL_MESSAGE_PURPOSES) {
      // The parameterised forms (GUIDELINE_DELIVERY:<version>) are templates rather than codes, so
      // the registry holds the stem and the parameter is applied when the dedupe key is built.
      expect(purpose).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  test('carries the purposes FR-MSG-002 names', () => {
    // "Logs can distinguish application, selection, consent, reservation, holding, and guideline
    // messages" — the acceptance condition, checked rather than assumed.
    const joined = ALL_MESSAGE_PURPOSES.join(' ')
    for (const fragment of ['APPLICATION', 'SELECTION', 'CONSENT', 'RESERVATION', 'HOLDING', 'GUIDELINE']) {
      expect(joined).toContain(fragment)
    }
  })

  test('the Visit C purposes exist and are distinct, because §26.3 AC-03 turns on it', () => {
    // Approval status and booking instructions must be separate codes: the acceptance test asserts
    // that no VISIT_C_BOOKING_INSTRUCTIONS notification exists before approval, which is
    // unexpressible if the two share one code.
    expect(MESSAGE_PURPOSES.VISIT_C_APPROVAL_STATUS).not.toBe(MESSAGE_PURPOSES.VISIT_C_BOOKING_INSTRUCTIONS)
  })

  test('has no duplicate values, which would make two workflows share a dedupe namespace', () => {
    expect(new Set(ALL_MESSAGE_PURPOSES).size).toBe(ALL_MESSAGE_PURPOSES.length)
  })

  test('the guard narrows an arbitrary string', () => {
    expect(isMessagePurpose('GUIDELINE_DELIVERY')).toBe(true)
    expect(isMessagePurpose('NOT_A_PURPOSE')).toBe(false)
    // A predicate rather than a cast: the value arrives from a database column or a provider,
    // and no-unsafe-type-assertion forbids asserting it into the union.
    expect(isMessagePurpose('')).toBe(false)
  })
})
