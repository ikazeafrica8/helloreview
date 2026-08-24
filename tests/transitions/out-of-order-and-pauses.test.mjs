import { describe, expect, test } from 'vitest'
import {
  WORKFLOW_GUARD,
  WORKFLOW_TRIGGER,
  isPauseBlockingTransition,
  pauseAppliesToWorkflow,
  planWorkflowTransition,
} from '../../apps/api/dist/modules/workflow-core/index.js'

const snapshot = {
  application: 'application_pending',
  selection: 'not_reviewed',
  campaign_type: 'shipping',
  visit_method: 'not_applicable',
  secret_comment: 'not_claimed',
  payback_consent: 'not_applicable',
  business_approval: 'not_required',
  shipping: 'address_requested',
  reservation: 'not_applicable',
  guideline: 'not_ready',
  human_handoff: 'not_required',
  automation_mode: 'active',
}

const request = {
  dimension: 'application',
  to: 'application_completed',
  trigger: WORKFLOW_TRIGGER.WEBSITE_CONFIRMS_APPLICATION,
}

describe('out-of-order events and pause behavior', () => {
  test('a reverse-arriving older event is retained for replay and cannot reverse the projection', () => {
    const staleSnapshot = { ...snapshot, automation_mode: 'human_owned' }
    const plan = planWorkflowTransition(staleSnapshot, request, {
      campaignStatus: 'closed',
      guardResults: { [WORKFLOW_GUARD.VALID_APPLICATION_EVENT]: true },
      automated: true,
      redeliveryAuthorized: false,
      occurredAt: new Date('2026-08-24T09:59:59Z'),
      currentStateOriginAt: new Date('2026-08-24T10:00:00Z'),
    })
    expect(plan).toMatchObject({
      approved: false,
      transitionId: 'stale_event_without_correction',
      reasonCode: 'WORKFLOW_STALE_EVENT',
      metricKind: 'stale_event',
      retainedForReplay: true,
      sideEffects: [],
    })
    expect(plan.nextSnapshot).toBe(staleSnapshot)
  })

  test('a same-time event remains eligible and is not falsely stale', () => {
    const at = new Date('2026-08-24T10:00:00Z')
    expect(
      planWorkflowTransition(snapshot, request, {
        campaignStatus: 'active',
        guardResults: { [WORKFLOW_GUARD.VALID_APPLICATION_EVENT]: true },
        automated: true,
        redeliveryAuthorized: false,
        occurredAt: at,
        currentStateOriginAt: at,
      }),
    ).toMatchObject({ approved: true, transitionId: 'application_completed' })
  })

  test('standard pauses block every automated transition while the emergency switch permits essential work', () => {
    const standard = { kind: 'standard' }
    const emergency = { kind: 'emergency_kill_switch' }
    expect(isPauseBlockingTransition(standard, false)).toBe(true)
    expect(isPauseBlockingTransition(standard, true)).toBe(true)
    expect(isPauseBlockingTransition(emergency, false)).toBe(true)
    expect(isPauseBlockingTransition(emergency, true)).toBe(false)
  })

  test('global, campaign, workflow-type, and participant scopes match independently', () => {
    const workflow = { participantId: 'participant-a', campaignId: 'campaign-a', campaignType: 'shipping' }
    const record = (scope, target = {}) => ({
      id: `pause-${scope}`,
      scope,
      kind: 'standard',
      campaignId: null,
      workflowType: null,
      participantId: null,
      reasonCode: 'TEST_PAUSE',
      activatedAt: new Date('2026-08-24T10:00:00Z'),
      ...target,
    })
    expect(pauseAppliesToWorkflow(record('global'), workflow)).toBe(true)
    expect(pauseAppliesToWorkflow(record('campaign', { campaignId: 'campaign-a' }), workflow)).toBe(true)
    expect(pauseAppliesToWorkflow(record('workflow_type', { workflowType: 'shipping' }), workflow)).toBe(true)
    expect(pauseAppliesToWorkflow(record('participant', { participantId: 'participant-a' }), workflow)).toBe(true)
    expect(pauseAppliesToWorkflow(record('campaign', { campaignId: 'campaign-b' }), workflow)).toBe(false)
    expect(pauseAppliesToWorkflow(record('workflow_type', { workflowType: 'payback' }), workflow)).toBe(false)
    expect(pauseAppliesToWorkflow(record('participant', { participantId: 'participant-b' }), workflow)).toBe(false)
  })
})
