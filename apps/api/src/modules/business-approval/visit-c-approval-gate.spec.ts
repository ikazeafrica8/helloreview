import { describe, expect, test } from 'vitest'
import {
  evaluateVisitCApprovalGate,
  type BusinessApprovalState,
  type VisitCApprovalSnapshot,
} from './visit-c-approval-gate.js'
import { BUSINESS_APPROVAL_REASON } from './reason-codes.js'

const now = new Date('2026-08-24T00:00:00.000Z')
const approved: VisitCApprovalSnapshot = {
  state: 'approved',
  source: 'authorized_operator',
  isCurrentVersion: true,
  scopeMatches: true,
  expiresAt: new Date('2026-08-25T00:00:00.000Z'),
}

describe('Visit C approval hard gate', () => {
  test('allows only a current, scoped, authorized and unexpired approval', () => {
    expect(evaluateVisitCApprovalGate(approved, now)).toEqual({
      allowed: true,
      reasonCode: BUSINESS_APPROVAL_REASON.APPROVED_CURRENT,
    })
    expect(evaluateVisitCApprovalGate({ ...approved, source: 'authorized_system', expiresAt: null }, now).allowed).toBe(
      true,
    )
  })

  test.each([
    ['not_required', BUSINESS_APPROVAL_REASON.APPROVAL_NOT_REQUIRED_INVALID_FOR_VISIT_C],
    ['not_requested', BUSINESS_APPROVAL_REASON.APPROVAL_NOT_REQUESTED],
    ['pending', BUSINESS_APPROVAL_REASON.APPROVAL_PENDING],
    ['rejected', BUSINESS_APPROVAL_REASON.APPROVAL_REJECTED],
    ['expired', BUSINESS_APPROVAL_REASON.APPROVAL_EXPIRED],
    ['revoked', BUSINESS_APPROVAL_REASON.APPROVAL_REVOKED],
    ['human_review_required', BUSINESS_APPROVAL_REASON.APPROVAL_HUMAN_REVIEW_REQUIRED],
  ] as const)('prohibits %s', (state, reasonCode) => {
    expect(
      evaluateVisitCApprovalGate({ ...approved, state: state satisfies BusinessApprovalState }, now),
    ).toMatchObject({
      allowed: false,
      reasonCode,
      pauseProgression: true,
    })
  })

  test('an approved version expires at the exact expiry instant', () => {
    expect(evaluateVisitCApprovalGate({ ...approved, expiresAt: now }, now)).toMatchObject({
      allowed: false,
      reasonCode: BUSINESS_APPROVAL_REASON.APPROVAL_EXPIRED,
      createHumanTask: true,
    })
  })

  test.each([
    [{ source: 'participant' as const }, BUSINESS_APPROVAL_REASON.APPROVAL_SOURCE_NOT_AUTHORIZED, 'critical'],
    [{ scopeMatches: false }, BUSINESS_APPROVAL_REASON.APPROVAL_SCOPE_MISMATCH, 'critical'],
    [{ isCurrentVersion: false }, BUSINESS_APPROVAL_REASON.APPROVAL_VERSION_NOT_CURRENT, 'high'],
  ] as const)('fails closed for authorization, scope, and version violations', (change, reasonCode, priority) => {
    expect(evaluateVisitCApprovalGate({ ...approved, ...change }, now)).toMatchObject({
      allowed: false,
      reasonCode,
      createHumanTask: true,
      taskPriority: priority,
    })
  })

  test('revocation is always critical', () => {
    expect(evaluateVisitCApprovalGate({ ...approved, state: 'revoked' }, now)).toMatchObject({
      allowed: false,
      taskPriority: 'critical',
      participantAction: 'no_automated_message',
    })
  })
})
