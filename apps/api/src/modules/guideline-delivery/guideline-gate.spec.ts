import { describe, expect, test } from 'vitest'
import { initialWorkflowSnapshot, type WorkflowSnapshot } from '../workflow-core/index.js'
import { evaluateGuidelineReadiness, type GuidelineReadinessSnapshot } from './guideline-gate.js'
import { GUIDELINE_BLOCK } from './reason-codes.js'

const now = new Date('2026-08-24T00:00:00.000Z')

const visitWorkflow = (visitMethod: 'visit_a' | 'visit_b' | 'visit_c'): WorkflowSnapshot => ({
  ...initialWorkflowSnapshot({ campaignType: 'visit', visitMethod }),
  application: 'application_matched',
  selection: 'manually_selected',
  secret_comment: 'verified',
  business_approval: visitMethod === 'visit_c' ? 'approved' : 'not_required',
  reservation: 'valid',
})

const readySnapshot = (route: GuidelineReadinessSnapshot['campaign']['route']): GuidelineReadinessSnapshot => {
  const workflow =
    route === 'shipping'
      ? {
          ...initialWorkflowSnapshot({ campaignType: 'shipping', visitMethod: 'not_applicable' }),
          selection: 'auto_selected' as const,
          shipping: 'address_valid' as const,
        }
      : route === 'payback'
        ? {
            ...initialWorkflowSnapshot({ campaignType: 'payback', visitMethod: 'not_applicable' }),
            selection: 'auto_selected' as const,
            payback_consent: 'agreed' as const,
          }
        : visitWorkflow(route)
  return {
    workflow,
    campaign: {
      route,
      status: 'active',
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-09-01T00:00:00.000Z'),
      activeGuidelineVersion: 4,
      activeTermsVersion: route === 'payback' ? 2 : null,
    },
    consentTermsVersion: route === 'payback' ? 2 : null,
    businessApprovalExpiresAt: route === 'visit_c' ? new Date('2026-08-25T00:00:00.000Z') : null,
    safeScreenshotReceived: route === 'visit_b' || route === 'visit_c',
    criticalFieldsExtracted: route === 'visit_b' || route === 'visit_c',
    shippingPrerequisitesSatisfied: true,
    paybackPrerequisitesSatisfied: true,
    deliveredGuidelineVersions: [],
  }
}

describe('PRD §16.9 guideline readiness', () => {
  test.each(['shipping', 'payback', 'visit_a', 'visit_b', 'visit_c'] as const)(
    '%s becomes ready only through its explicit route',
    (route) => {
      expect(evaluateGuidelineReadiness(readySnapshot(route), now)).toEqual({
        ready: true,
        reasonCode: GUIDELINE_BLOCK.READY,
        guidelineVersion: 4,
      })
    },
  )

  test.each([
    [
      (snapshot: GuidelineReadinessSnapshot) => ({
        ...snapshot,
        workflow: { ...snapshot.workflow, automation_mode: 'campaign_paused' as const },
      }),
      GUIDELINE_BLOCK.AUTOMATION_PAUSED,
    ],
    [
      (snapshot: GuidelineReadinessSnapshot) => ({
        ...snapshot,
        workflow: { ...snapshot.workflow, human_handoff: 'assigned' as const },
      }),
      GUIDELINE_BLOCK.HUMAN_OWNERSHIP_ACTIVE,
    ],
    [
      (snapshot: GuidelineReadinessSnapshot) => ({
        ...snapshot,
        workflow: { ...snapshot.workflow, human_handoff: 'in_progress' as const },
      }),
      GUIDELINE_BLOCK.HUMAN_OWNERSHIP_ACTIVE,
    ],
    [
      (snapshot: GuidelineReadinessSnapshot) => ({
        ...snapshot,
        campaign: { ...snapshot.campaign, status: 'paused' as const },
      }),
      GUIDELINE_BLOCK.CAMPAIGN_NOT_ACTIVE,
    ],
    [
      (snapshot: GuidelineReadinessSnapshot) => ({
        ...snapshot,
        campaign: { ...snapshot.campaign, startsAt: new Date('2026-08-25T00:00:00.000Z') },
      }),
      GUIDELINE_BLOCK.CAMPAIGN_NOT_ACTIVE,
    ],
    [
      (snapshot: GuidelineReadinessSnapshot) => ({ ...snapshot, campaign: { ...snapshot.campaign, endsAt: now } }),
      GUIDELINE_BLOCK.CAMPAIGN_NOT_ACTIVE,
    ],
    [
      (snapshot: GuidelineReadinessSnapshot) => ({
        ...snapshot,
        workflow: { ...snapshot.workflow, selection: 'review_pending' as const },
      }),
      GUIDELINE_BLOCK.NOT_SELECTED,
    ],
    [
      (snapshot: GuidelineReadinessSnapshot) => ({
        ...snapshot,
        campaign: { ...snapshot.campaign, activeGuidelineVersion: null },
      }),
      GUIDELINE_BLOCK.NO_ACTIVE_GUIDELINE_VERSION,
    ],
    [
      (snapshot: GuidelineReadinessSnapshot) => ({ ...snapshot, deliveredGuidelineVersions: [3, 4] }),
      GUIDELINE_BLOCK.VERSION_ALREADY_DELIVERED,
    ],
  ] as const)('applies each universal block before route checks', (change, reasonCode) => {
    const result = evaluateGuidelineReadiness(change(readySnapshot('visit_a')), now)
    expect(result).toMatchObject({ ready: false, reasonCode })
    if (!result.ready) {
      expect(result.observed.length).toBeGreaterThan(0)
      expect(result.expected.length).toBeGreaterThan(0)
      expect(result.correction.length).toBeGreaterThan(0)
    }
  })

  test('accepts an open-ended active campaign and either selected state', () => {
    const snapshot = readySnapshot('visit_a')
    expect(
      evaluateGuidelineReadiness(
        {
          ...snapshot,
          campaign: { ...snapshot.campaign, endsAt: null },
          workflow: { ...snapshot.workflow, selection: 'auto_selected' },
        },
        now,
      ).ready,
    ).toBe(true)
  })

  test('shipping names address and additional prerequisite failures', () => {
    const snapshot = readySnapshot('shipping')
    expect(
      evaluateGuidelineReadiness(
        { ...snapshot, workflow: { ...snapshot.workflow, shipping: 'address_incomplete' } },
        now,
      ),
    ).toMatchObject({
      ready: false,
      reasonCode: GUIDELINE_BLOCK.SHIPPING_ADDRESS_NOT_VALID,
    })
    expect(evaluateGuidelineReadiness({ ...snapshot, shippingPrerequisitesSatisfied: false }, now)).toMatchObject({
      ready: false,
      reasonCode: GUIDELINE_BLOCK.SHIPPING_PREREQUISITES_NOT_MET,
    })
  })

  test('payback requires agreement to the active terms and all extra prerequisites', () => {
    const snapshot = readySnapshot('payback')
    expect(evaluateGuidelineReadiness({ ...snapshot, consentTermsVersion: 1 }, now)).toMatchObject({
      reasonCode: GUIDELINE_BLOCK.CONSENT_NOT_CURRENT,
    })
    expect(
      evaluateGuidelineReadiness(
        { ...snapshot, workflow: { ...snapshot.workflow, payback_consent: 'withdrawn' } },
        now,
      ),
    ).toMatchObject({ reasonCode: GUIDELINE_BLOCK.CONSENT_NOT_CURRENT })
    expect(
      evaluateGuidelineReadiness({ ...snapshot, workflow: { ...snapshot.workflow, payback_consent: 'declined' } }, now),
    ).toMatchObject({ reasonCode: GUIDELINE_BLOCK.CONSENT_NOT_CURRENT })
    expect(evaluateGuidelineReadiness({ ...snapshot, paybackPrerequisitesSatisfied: false }, now)).toMatchObject({
      reasonCode: GUIDELINE_BLOCK.PAYBACK_PREREQUISITES_NOT_MET,
    })
  })

  test('Visit A requires a current valid reservation', () => {
    const snapshot = readySnapshot('visit_a')
    expect(
      evaluateGuidelineReadiness(
        { ...snapshot, workflow: { ...snapshot.workflow, reservation: 'correction_required' } },
        now,
      ),
    ).toMatchObject({
      ready: false,
      reasonCode: GUIDELINE_BLOCK.RESERVATION_NOT_VALID,
    })
  })

  test.each(['visit_b', 'visit_c'] as const)(
    '%s requires safe screenshot, extracted critical fields, and valid reservation',
    (route) => {
      const snapshot = readySnapshot(route)
      expect(evaluateGuidelineReadiness({ ...snapshot, safeScreenshotReceived: false }, now)).toMatchObject({
        reasonCode: GUIDELINE_BLOCK.SCREENSHOT_NOT_SAFE,
      })
      expect(evaluateGuidelineReadiness({ ...snapshot, criticalFieldsExtracted: false }, now)).toMatchObject({
        reasonCode: GUIDELINE_BLOCK.CRITICAL_FIELDS_NOT_EXTRACTED,
      })
      expect(
        evaluateGuidelineReadiness(
          { ...snapshot, workflow: { ...snapshot.workflow, reservation: 'correction_required' } },
          now,
        ),
      ).toMatchObject({ reasonCode: GUIDELINE_BLOCK.RESERVATION_NOT_VALID })
    },
  )

  test('Visit C checks approval before screenshot and treats the expiry boundary as expired', () => {
    const snapshot = readySnapshot('visit_c')
    expect(
      evaluateGuidelineReadiness(
        {
          ...snapshot,
          workflow: { ...snapshot.workflow, business_approval: 'pending' },
          safeScreenshotReceived: false,
        },
        now,
      ),
    ).toMatchObject({ reasonCode: GUIDELINE_BLOCK.BUSINESS_APPROVAL_NOT_CURRENT })
    expect(evaluateGuidelineReadiness({ ...snapshot, businessApprovalExpiresAt: now }, now)).toMatchObject({
      reasonCode: GUIDELINE_BLOCK.BUSINESS_APPROVAL_EXPIRED,
    })
    expect(evaluateGuidelineReadiness({ ...snapshot, businessApprovalExpiresAt: null }, now).ready).toBe(true)
  })
})
