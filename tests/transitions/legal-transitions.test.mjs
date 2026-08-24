import { describe, expect, test } from 'vitest'
import { LEGAL_WORKFLOW_TRANSITIONS, planWorkflowTransition } from '../../apps/api/dist/modules/workflow-core/index.js'

const now = new Date('2026-08-24T09:00:00.000Z')

const safeSnapshot = () => ({
  application: 'application_matched',
  selection: 'auto_selected',
  campaign_type: 'visit',
  visit_method: 'visit_a',
  secret_comment: 'verified',
  payback_consent: 'agreed',
  business_approval: 'approved',
  shipping: 'address_valid',
  reservation: 'valid',
  guideline: 'not_ready',
  human_handoff: 'not_required',
  automation_mode: 'active',
})

const snapshotFor = (definition) => ({ ...safeSnapshot(), [definition.dimension]: definition.from[0] })
const contextFor = (definition, passes) => ({
  campaignStatus: 'active',
  identityMatchCategory: definition.id === 'application_matched' ? 'verified' : undefined,
  guardResults: { [definition.guard]: passes },
  automated: false,
  redeliveryAuthorized: false,
  occurredAt: now,
  currentStateOriginAt: now,
})

describe('PRD section 14.5 legal workflow table', () => {
  test('contains every one of the 32 current PRD rows exactly once', () => {
    expect(LEGAL_WORKFLOW_TRANSITIONS).toHaveLength(32)
    expect(new Set(LEGAL_WORKFLOW_TRANSITIONS.map((entry) => entry.id)).size).toBe(32)
  })

  test.each(LEGAL_WORKFLOW_TRANSITIONS)('$id applies when its guard passes', (definition) => {
    const snapshot = snapshotFor(definition)
    const request = { dimension: definition.dimension, to: definition.to, trigger: definition.trigger }
    const plan = planWorkflowTransition(snapshot, request, contextFor(definition, true))

    expect(plan).toMatchObject({
      approved: true,
      transitionId: definition.id,
      currentState: definition.from[0],
      reasonCode: 'WORKFLOW_TRANSITION_APPROVED',
      sideEffects: definition.sideEffects,
      metricKind: 'transition_success',
      retainedForReplay: false,
    })
    expect(plan.nextSnapshot).not.toBe(snapshot)
    expect(plan.nextSnapshot[definition.dimension]).toBe(definition.to)
    expect(snapshot[definition.dimension]).toBe(definition.from[0])
  })

  test.each(LEGAL_WORKFLOW_TRANSITIONS)('$id has no state change or side effect when its guard fails', (definition) => {
    const snapshot = snapshotFor(definition)
    const request = { dimension: definition.dimension, to: definition.to, trigger: definition.trigger }
    const plan = planWorkflowTransition(snapshot, request, contextFor(definition, false))

    expect(plan).toMatchObject({
      approved: false,
      transitionId: definition.id,
      reasonCode: 'WORKFLOW_TRANSITION_GUARD_FAILED',
      failedGuard: definition.guard,
      sideEffects: [],
      metricKind: 'guard_rejection',
    })
    expect(plan.nextSnapshot).toBe(snapshot)
  })
})
