// Message purpose codes (FR-MSG-002, PRD §14.1 workflow table).
//
// Every outbound message carries one of these. It is what makes a log line answerable — §23.1's
// logical key is `KAKAO|wf_123|app_456|camp_789|GUIDELINE_DELIVERY|guideline_v4` — and it is the
// namespace half of every dedupe key, so two workflows sharing a code would silently deduplicate
// each other's messages.
//
// ONE registry, derived union, no string literals at call sites. The alternative is a purpose code
// spelled two ways in two modules, which produces two dedupe namespaces that look like one.
//
// PARAMETERISED PURPOSES. Four of the PRD's dedupe purposes carry a parameter:
// `GUIDELINE_DELIVERY:<version>`, `GUIDELINE_REDELIVERY:<version>:<authorization>`, and
// `RESERVATION_CORRECTION:<rule>`. The registry holds the STEM only. The parameter belongs to the
// dedupe key, which T43 builds — a code with a version baked into it is not a code, it is a key,
// and mixing the two is how `GUIDELINE_DELIVERY:v4` ends up compared against `GUIDELINE_DELIVERY`.

export const MESSAGE_PURPOSES = {
  /**
   * 0. Website application request — the campaign's application URL (PRD §32.1, FR-SC-002).
   *
   * Added in T136. §14.5 has always made "Campaign application URL exists" a mandatory guard on
   * Not Applied -> Application Requested, and §32.1 defines the Korean template that interpolates
   * `{{application_url}}` — but no purpose code existed for it, so the one message that starts the
   * secret-comment route could not pass through the outbox at all. Numbered 0 because it precedes
   * the match outcome that §14.1 numbers 1.
   */
  APPLICATION_REQUEST: 'APPLICATION_REQUEST',
  /** 1. Direct website applicant — match outcome. */
  APPLICATION_MATCH_STATUS: 'APPLICATION_MATCH_STATUS',
  /** 2. Secret-comment applicant — screenshot request. */
  SECRET_COMMENT_SCREENSHOT_REQUEST: 'SECRET_COMMENT_SCREENSHOT_REQUEST',
  /** 3. Application not found — status while reconciling. */
  APPLICATION_NOT_FOUND_STATUS: 'APPLICATION_NOT_FOUND_STATUS',
  /** 4. Ambiguous identity — holding message while a human decides. */
  IDENTITY_REVIEW_HOLDING: 'IDENTITY_REVIEW_HOLDING',
  /** 5 and 6. Automatic and manual selection share one purpose: the participant sees one outcome. */
  SELECTION_RESULT: 'SELECTION_RESULT',
  /** 7. Non-selection notice, subject to campaign policy. */
  NON_SELECTION_NOTICE: 'NON_SELECTION_NOTICE',
  /** 8. Shipping — secure address request. */
  SHIPPING_ADDRESS_REQUEST: 'SHIPPING_ADDRESS_REQUEST',
  /** 9. Payback — explicit consent to current terms. */
  PAYBACK_CONSENT_REQUEST: 'PAYBACK_CONSENT_REQUEST',
  /** 9 (continued). One bounded clarification for an ambiguous current-terms response. */
  PAYBACK_CONSENT_CLARIFICATION: 'PAYBACK_CONSENT_CLARIFICATION',
  /** 10. Visit A — phone number and reservation instructions. */
  VISIT_A_INSTRUCTIONS: 'VISIT_A_INSTRUCTIONS',
  /** 11. Visit B — booking instructions, screenshot expected back. */
  VISIT_B_INSTRUCTIONS: 'VISIT_B_INSTRUCTIONS',
  /** 12. Visit C — approval state only. Never booking instructions; see the next entry. */
  VISIT_C_APPROVAL_STATUS: 'VISIT_C_APPROVAL_STATUS',
  /**
   * 12 (continued). Visit C booking instructions, permitted ONLY after a current business approval.
   *
   * Deliberately a separate code from VISIT_C_APPROVAL_STATUS. §26.3 AC-03 asserts that no
   * notification with this purpose exists while approval is pending, and SPEC.md §8 lists sending
   * it early under "Never" — neither is expressible if approval status and booking instructions
   * share one code.
   */
  VISIT_C_BOOKING_INSTRUCTIONS: 'VISIT_C_BOOKING_INSTRUCTIONS',
  /** 13. Reservation correction. Parameterised by rule when the dedupe key is built. */
  RESERVATION_CORRECTION: 'RESERVATION_CORRECTION',
  /** 14. Reservation cancellation acknowledgement. */
  RESERVATION_CANCELLATION_ACK: 'RESERVATION_CANCELLATION_ACK',
  /** 15. Reservation reschedule acknowledgement. */
  RESERVATION_RESCHEDULE_ACK: 'RESERVATION_RESCHEDULE_ACK',
  /** 16. Guideline delivery. Parameterised by guideline version when the dedupe key is built. */
  GUIDELINE_DELIVERY: 'GUIDELINE_DELIVERY',
  /** 17. Authorized guideline re-delivery. Parameterised by version and authorization. */
  GUIDELINE_REDELIVERY: 'GUIDELINE_REDELIVERY',
  /** 18. Human handoff — the single holding message sent when automation pauses. */
  HUMAN_HANDOFF_HOLDING: 'HUMAN_HANDOFF_HOLDING',
  /** 19. Return from human review — status once automation resumes. */
  RETURN_TO_AUTOMATION_STATUS: 'RETURN_TO_AUTOMATION_STATUS',
  /** 20. System outage fallback notice. */
  SYSTEM_DELAY_NOTICE: 'SYSTEM_DELAY_NOTICE',
} as const

export type MessagePurpose = (typeof MESSAGE_PURPOSES)[keyof typeof MESSAGE_PURPOSES]

export const ALL_MESSAGE_PURPOSES: readonly MessagePurpose[] = Object.freeze(Object.values(MESSAGE_PURPOSES))

const PURPOSE_VALUES: ReadonlySet<string> = new Set<string>(ALL_MESSAGE_PURPOSES)

/**
 * Narrow an arbitrary string to a MessagePurpose.
 *
 * A PREDICATE, not a cast. Purpose codes arrive from database columns and provider payloads, so
 * asserting one into the union would be exactly the unchecked claim
 * @typescript-eslint/no-unsafe-type-assertion exists to catch — and a stale code read from a row
 * written by an older deployment is the realistic case.
 */
export const isMessagePurpose = (value: string): value is MessagePurpose => PURPOSE_VALUES.has(value)

/**
 * The purposes that take a parameter, and what the parameter means.
 *
 * §14.1 writes these as `RESERVATION_CORRECTION:<rule>` and `GUIDELINE_DELIVERY:<version>`. The
 * registry above holds STEMS; this is the list of stems that are incomplete on their own.
 *
 * Why it matters beyond tidiness: `message_templates.purpose_code` stores the FULL form, and §32
 * has seven distinct reservation-correction templates. If the stem were stored instead, six of them
 * could not exist — PRD §17.3 makes (purpose_code, version) unique.
 */
export const PARAMETERISED_PURPOSES: ReadonlySet<MessagePurpose> = new Set<MessagePurpose>([
  MESSAGE_PURPOSES.RESERVATION_CORRECTION,
  MESSAGE_PURPOSES.GUIDELINE_DELIVERY,
  MESSAGE_PURPOSES.GUIDELINE_REDELIVERY,
])

/**
 * Purpose stems whose TEMPLATE identity includes a parameter.
 *
 * This is intentionally narrower than PARAMETERISED_PURPOSES. A guideline delivery's outbound
 * purpose carries the delivered guideline version, but its approved wrapper template does not —
 * the guideline content/version is a separate record. Reservation corrections, on the other hand,
 * genuinely have different approved wording per failed rule, so the rule is part of the template
 * purpose (`RESERVATION_CORRECTION:INVALID_TIME`).
 */
export const PARAMETERISED_TEMPLATE_PURPOSES: ReadonlySet<MessagePurpose> = new Set<MessagePurpose>([
  MESSAGE_PURPOSES.RESERVATION_CORRECTION,
])

/** Separates a stem from its parameters, matching §14.1's `RESERVATION_CORRECTION:<rule>`. */
export const PURPOSE_PARAMETER_SEPARATOR = ':'

/**
 * Compose the full purpose string from a stem and its parameters.
 *
 * COMPOSED, NEVER SPELLED BY HAND. A purpose written out as a literal at one call site and composed
 * at another is how one purpose acquires two spellings — and since the purpose is the namespace half
 * of every dedupe key, two spellings are two dedupe namespaces that look like one, which shows up
 * as a duplicate message to a participant rather than as a failing test.
 *
 * Rejects an empty or separator-containing parameter for the same reason: `GUIDELINE_DELIVERY:4:x`
 * parsed back gives a different stem than it started with.
 */
export const composePurpose = (stem: MessagePurpose, ...parameters: readonly string[]): string => {
  for (const parameter of parameters) {
    if (parameter === '' || parameter.includes(PURPOSE_PARAMETER_SEPARATOR)) {
      throw new Error(
        `invalid purpose parameter ${JSON.stringify(parameter)} for ${stem}: ` +
          `it must be non-empty and must not contain "${PURPOSE_PARAMETER_SEPARATOR}"`,
      )
    }
  }
  return [stem, ...parameters].join(PURPOSE_PARAMETER_SEPARATOR)
}

/**
 * Recover the stem from a full purpose string, or undefined if it names no known purpose.
 *
 * Undefined rather than a throw: purpose codes are read back from rows written by older
 * deployments, and a code this build does not recognise is data, not a programming error.
 */
export const purposeStem = (fullPurpose: string): MessagePurpose | undefined => {
  const [stem] = fullPurpose.split(PURPOSE_PARAMETER_SEPARATOR)
  return stem !== undefined && isMessagePurpose(stem) ? stem : undefined
}

/**
 * Whether a stored purpose_code is well formed: a known stem, parameterised only if the stem allows
 * it, and carrying a parameter if the stem requires one.
 */
export const isWellFormedPurposeCode = (fullPurpose: string): boolean => {
  const parts = fullPurpose.split(PURPOSE_PARAMETER_SEPARATOR)
  const [stem, ...parameters] = parts
  if (stem === undefined || !isMessagePurpose(stem)) return false
  if (parameters.some((parameter) => parameter === '')) return false
  return PARAMETERISED_PURPOSES.has(stem) ? parameters.length > 0 : parameters.length === 0
}

/** Whether a `message_templates.purpose_code` names one valid approved-template namespace. */
export const isWellFormedTemplatePurposeCode = (templatePurpose: string): boolean => {
  const parts = templatePurpose.split(PURPOSE_PARAMETER_SEPARATOR)
  const [stem, ...parameters] = parts
  if (stem === undefined || !isMessagePurpose(stem)) return false
  if (parameters.some((parameter) => parameter === '')) return false
  return PARAMETERISED_TEMPLATE_PURPOSES.has(stem) ? parameters.length > 0 : parameters.length === 0
}
