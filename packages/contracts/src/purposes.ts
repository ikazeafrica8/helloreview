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
