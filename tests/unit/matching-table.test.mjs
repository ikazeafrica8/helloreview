// Unit tier: every row of PRD §16.1 applicant matching (T29, FR-ID-001/002/012).

import { describe, expect, test } from 'vitest'
import {
  matchApplicant,
  MatchingTableError,
  IDENTITY_RESOLUTION_REASON,
} from '../../apps/api/dist/modules/identity-resolution/index.js'

const decidedAt = new Date('2026-08-24T08:00:00Z')

const expectEvidence = (result, expected) => {
  expect(result).toMatchObject({ ...expected, decidedAt })
  expect(typeof result.method).toBe('string')
  expect(typeof result.evidenceCategory).toBe('string')
  expect(typeof result.reasonCode).toBe('string')
}

describe('PRD §16.1 applicant matching decision table', () => {
  test('row 1 — a valid application-specific token verifies exactly one application', () => {
    expectEvidence(matchApplicant({ kind: 'verification_token', applicationId: 'app-1' }, decidedAt), {
      category: 'verified',
      candidateApplicationIds: ['app-1'],
      automaticLinkAllowed: true,
      nextAction: 'persist_link',
    })
  })

  test.each([
    ['policy allows linking', 'allow', true, 'persist_link'],
    ['policy requires confirmation', 'confirm', false, 'confirm_then_persist'],
  ])('row 2 — exact phone, campaign and name is Strong Match when %s', (_label, policy, allowed, nextAction) => {
    expectEvidence(
      matchApplicant({ kind: 'phone_campaign_name', applicationId: 'app-1', automaticLinkPolicy: policy }, decidedAt),
      {
        category: 'strong_match',
        automaticLinkAllowed: allowed,
        nextAction,
      },
    )
  })

  test('row 3 — exact phone and campaign with a name difference is Ambiguous', () => {
    expectEvidence(matchApplicant({ kind: 'phone_campaign', candidateApplicationIds: ['app-1', 'app-2'] }, decidedAt), {
      category: 'ambiguous',
      candidateApplicationIds: ['app-1', 'app-2'],
      automaticLinkAllowed: false,
      nextAction: 'human_review',
    })
  })

  test('row 4 — name and campaign only is structurally non-binding Weak Match', () => {
    const result = matchApplicant({ kind: 'name_campaign', applicationId: 'app-1' }, decidedAt)
    expectEvidence(result, {
      category: 'weak_match',
      evidenceCategory: 'name_only',
      automaticLinkAllowed: false,
      nextAction: 'additional_verification',
    })
    expect(result.category).not.toBe('verified')
    expect(result.category).not.toBe('strong_match')
  })

  test('row 5 — one phone across several active campaigns requires campaign disambiguation', () => {
    expectEvidence(
      matchApplicant({ kind: 'phone_multiple_campaigns', candidateApplicationIds: ['app-1', 'app-2'] }, decidedAt),
      {
        category: 'ambiguous',
        nextAction: 'campaign_disambiguation',
        automaticLinkAllowed: false,
      },
    )
  })

  test('row 6 — a secret-comment screenshot is supporting evidence only', () => {
    expectEvidence(matchApplicant({ kind: 'secret_comment_screenshot' }, decidedAt), {
      category: 'weak_match',
      candidateApplicationIds: [],
      automaticLinkAllowed: false,
      nextAction: 'continue_matching',
    })
  })

  test.each([
    ['weak policy', 'weak', 'weak_match', IDENTITY_RESOLUTION_REASON.BLOG_CAMPAIGN_WEAK],
    ['strong policy', 'strong', 'strong_match', IDENTITY_RESOLUTION_REASON.BLOG_CAMPAIGN_STRONG],
  ])('row 7 — blog URL and campaign with no phone follows the approved %s', (_label, policy, category, reasonCode) => {
    expectEvidence(
      matchApplicant({ kind: 'blog_campaign', applicationId: 'app-1', approvedPolicy: policy }, decidedAt),
      {
        category,
        reasonCode,
        automaticLinkAllowed: false,
        nextAction: 'additional_verification',
      },
    )
  })

  test('row 8 — no candidate after reconciliation is No Match', () => {
    expectEvidence(matchApplicant({ kind: 'no_candidate_after_reconciliation' }, decidedAt), {
      category: 'no_match',
      candidateApplicationIds: [],
      automaticLinkAllowed: false,
      nextAction: 'application_not_found',
    })
  })

  test('row 9 — an existing link to another participant is a security-review ambiguity', () => {
    expectEvidence(matchApplicant({ kind: 'participant_link_conflict', applicationId: 'app-1' }, decidedAt), {
      category: 'ambiguous',
      evidenceCategory: 'ownership_conflict',
      automaticLinkAllowed: false,
      nextAction: 'security_review',
    })
  })

  test('unknown evidence fails closed with no candidate detail in the error', () => {
    const privateCandidate = 'private-candidate-id'
    try {
      matchApplicant({ kind: 'not-a-table-row', applicationId: privateCandidate }, decidedAt)
    } catch (error) {
      expect(error).toBeInstanceOf(MatchingTableError)
      expect(error).toMatchObject({ reasonCode: IDENTITY_RESOLUTION_REASON.MATCHING_EVIDENCE_INVALID })
      if (error instanceof Error) expect(error.message).not.toContain(privateCandidate)
      return
    }
    throw new Error('expected MatchingTableError')
  })
})
