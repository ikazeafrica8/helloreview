// Unit tier: every row of PRD §16.11 human-handoff priority policy (T32).

import { describe, expect, test } from 'vitest'
import { HUMAN_REVIEW_REASON, humanReviewPriority } from '../../apps/api/dist/modules/human-tasks/index.js'

describe('human-review priority table', () => {
  test.each([
    [HUMAN_REVIEW_REASON.PARTICIPANT_REQUESTED_PERSON, 'normal'],
    [HUMAN_REVIEW_REASON.COMPLAINT, 'high'],
    [HUMAN_REVIEW_REASON.IDENTITY_AMBIGUOUS, 'high'],
    [HUMAN_REVIEW_REASON.IDENTITY_CONFLICT, 'high'],
    [HUMAN_REVIEW_REASON.MISSING_SCORE_OR_PROVIDER_OUTAGE, 'normal'],
    [HUMAN_REVIEW_REASON.BORDERLINE_SELECTION, 'normal'],
    [HUMAN_REVIEW_REASON.SUSPICIOUS_SCREENSHOT, 'high'],
    [HUMAN_REVIEW_REASON.VISIT_C_APPROVAL_REVOKED, 'critical'],
    [HUMAN_REVIEW_REASON.GUIDELINE_MAY_HAVE_BEEN_SENT_PREMATURELY, 'critical'],
    [HUMAN_REVIEW_REASON.REPEATED_FAILED_VERIFICATION, 'high'],
    [HUMAN_REVIEW_REASON.PERSONAL_DATA_REQUEST, 'high'],
    [HUMAN_REVIEW_REASON.UNKNOWN_INTENT_AFTER_RETRIES, 'normal'],
    [HUMAN_REVIEW_REASON.SYSTEM_SECURITY_ALERT, 'critical'],
  ])('%s maps to %s', (reasonCode, priority) => {
    expect(humanReviewPriority(reasonCode)).toBe(priority)
  })

  test('the table covers every declared reason code exactly once', () => {
    expect(Object.values(HUMAN_REVIEW_REASON)).toHaveLength(13)
  })
})
