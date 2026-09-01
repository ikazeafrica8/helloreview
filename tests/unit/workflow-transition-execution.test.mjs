import { describe, expect, test, vi } from 'vitest'
import {
  WORKFLOW_EXECUTION_REASON,
  WORKFLOW_SIDE_EFFECT,
  executeGovernedWorkflowTransition,
  initialWorkflowSnapshot,
} from '../../packages/workflow-runtime/dist/index.js'

const workflowId = '11111111-1111-4111-8111-111111111111'
const participantId = '22222222-2222-4222-8222-222222222222'
const campaignId = '33333333-3333-4333-8333-333333333333'
const eventId = '44444444-4444-4444-8444-444444444444'
const occurredAt = new Date('2026-09-01T04:00:00Z')
const originAt = new Date('2026-09-01T03:00:00Z')

const workflowRow = (overrides = {}) => {
  const snapshot = { ...initialWorkflowSnapshot({ campaignType: 'shipping', visitMethod: 'not_applicable' }) }
  return {
    id: workflowId,
    participant_id: participantId,
    campaign_id: campaignId,
    version: 0,
    campaign_status: 'active',
    application_state: snapshot.application,
    selection_state: snapshot.selection,
    campaign_type: snapshot.campaign_type,
    visit_method: snapshot.visit_method,
    secret_comment_state: snapshot.secret_comment,
    payback_consent_state: snapshot.payback_consent,
    business_approval_state: snapshot.business_approval,
    shipping_state: snapshot.shipping,
    reservation_state: snapshot.reservation,
    guideline_state: snapshot.guideline,
    human_handoff_state: snapshot.human_handoff,
    automation_mode_state: snapshot.automation_mode,
    application_origin_at: originAt,
    selection_origin_at: originAt,
    secret_comment_origin_at: originAt,
    payback_consent_origin_at: originAt,
    business_approval_origin_at: originAt,
    shipping_origin_at: originAt,
    reservation_origin_at: originAt,
    guideline_origin_at: originAt,
    human_handoff_origin_at: originAt,
    automation_mode_origin_at: originAt,
    ...overrides,
  }
}

const input = (overrides = {}) => ({
  workflowId,
  expectedVersion: 0,
  dimension: 'application',
  to: 'application_requested',
  trigger: 'INITIAL_APPLICANT_CONTACT',
  triggeringEventId: 'inbound:test:1',
  actorType: 'system',
  actorId: 'worker',
  preconditionCodes: ['CAMPAIGN_APPLICATION_URL_EXISTS'],
  guardResults: { CAMPAIGN_APPLICATION_URL_EXISTS: true },
  correlationId: 'cor-transition-execution',
  occurredAt,
  automated: true,
  ...overrides,
})

const approvedPlanner = (snapshot) => ({
  approved: true,
  transitionId: 'application_request',
  currentState: snapshot.application,
  nextSnapshot: { ...snapshot, application: 'application_requested' },
  reasonCode: 'WORKFLOW_TRANSITION_APPROVED',
  sideEffects: [WORKFLOW_SIDE_EFFECT.QUEUE_APPLICATION_REQUEST_MESSAGE],
})

const harness = ({ row = workflowRow(), pauses = [] } = {}) => {
  const calls = []
  const tx = {
    query: async (sql, values = []) => {
      calls.push({ sql, values })
      if (sql.includes('FROM workflow_instances w')) return { rows: row === undefined ? [] : [row] }
      if (sql.includes('FROM automation_pauses')) return { rows: pauses }
      if (sql.startsWith('UPDATE workflow_instances')) return { rows: [{ id: workflowId }] }
      if (sql.startsWith('INSERT INTO workflow_events')) return { rows: [{ id: eventId }] }
      if (sql.startsWith('INSERT INTO workflow_side_effects')) return { rows: [] }
      if (sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  return { tx, calls }
}

describe('governed workflow transition execution', () => {
  test('locks, updates, and records transition evidence and side effects atomically', async () => {
    const testHarness = harness()

    await expect(executeGovernedWorkflowTransition(testHarness.tx, input(), approvedPlanner)).resolves.toEqual({
      status: 'applied',
      outcome: {
        workflowId,
        workflowVersion: 1,
        eventId,
        transitionId: 'application_request',
        snapshot: expect.objectContaining({ application: 'application_requested' }),
        sideEffects: [WORKFLOW_SIDE_EFFECT.QUEUE_APPLICATION_REQUEST_MESSAGE],
      },
    })

    expect(testHarness.calls[0].sql).toContain('FOR UPDATE OF w')
    expect(testHarness.calls.filter(({ sql }) => sql.startsWith('UPDATE workflow_instances'))).toHaveLength(1)
    expect(testHarness.calls.filter(({ sql }) => sql.startsWith('INSERT INTO workflow_events'))).toHaveLength(1)
    expect(testHarness.calls.filter(({ sql }) => sql.startsWith('INSERT INTO workflow_side_effects'))).toHaveLength(1)
    expect(testHarness.calls.filter(({ sql }) => sql.startsWith('INSERT INTO audit_logs'))).toHaveLength(1)
  })

  test('persists stale-version rejection without consulting the planner or pauses', async () => {
    const testHarness = harness()
    const planner = vi.fn(approvedPlanner)

    await expect(
      executeGovernedWorkflowTransition(testHarness.tx, input({ expectedVersion: 9 }), planner),
    ).resolves.toMatchObject({
      status: 'rejected',
      rejection: { reasonCode: WORKFLOW_EXECUTION_REASON.STALE_VERSION, metricKind: 'stale_version' },
    })

    expect(planner).not.toHaveBeenCalled()
    expect(testHarness.calls.some(({ sql }) => sql.includes('FROM automation_pauses'))).toBe(false)
    expect(testHarness.calls.some(({ sql }) => sql.startsWith('UPDATE workflow_instances'))).toBe(false)
    expect(testHarness.calls.filter(({ sql }) => sql.startsWith('INSERT INTO workflow_events'))).toHaveLength(1)
    expect(testHarness.calls.filter(({ sql }) => sql.startsWith('INSERT INTO audit_logs'))).toHaveLength(1)
  })

  test('classifies planner rejections before operational pauses', async () => {
    const testHarness = harness({ pauses: [{ id: 'pause', kind: 'standard' }] })
    const planner = vi.fn(() => ({
      approved: false,
      transitionId: null,
      reasonCode: 'WORKFLOW_TRANSITION_NOT_ALLOWED',
      failedGuard: null,
      metricKind: 'illegal_transition',
      retainedForReplay: false,
    }))

    await expect(executeGovernedWorkflowTransition(testHarness.tx, input(), planner)).resolves.toMatchObject({
      status: 'rejected',
      rejection: { reasonCode: 'WORKFLOW_TRANSITION_NOT_ALLOWED', metricKind: 'illegal_transition' },
    })
    expect(testHarness.calls.some(({ sql }) => sql.includes('FROM automation_pauses'))).toBe(false)
  })

  test('blocks normal automation under a pause and records the active pause id', async () => {
    const pauseId = '55555555-5555-4555-8555-555555555555'
    const testHarness = harness({ pauses: [{ id: pauseId, kind: 'standard' }] })

    await expect(executeGovernedWorkflowTransition(testHarness.tx, input(), approvedPlanner)).resolves.toMatchObject({
      status: 'rejected',
      rejection: { reasonCode: WORKFLOW_EXECUTION_REASON.AUTOMATION_PAUSED, metricKind: 'automation_pause' },
    })
    expect(testHarness.calls.some(({ sql }) => sql.startsWith('UPDATE workflow_instances'))).toBe(false)
    const auditCall = testHarness.calls.find(({ sql }) => sql.startsWith('INSERT INTO audit_logs'))
    expect(JSON.parse(auditCall.values[8]).active_pause_ids).toEqual([pauseId])
  })

  test('allows essential safety work through an emergency pause but not a standard pause', async () => {
    const emergencyHarness = harness({ pauses: [{ id: 'emergency', kind: 'emergency_kill_switch' }] })
    await expect(
      executeGovernedWorkflowTransition(emergencyHarness.tx, input({ essential: true }), approvedPlanner),
    ).resolves.toMatchObject({ status: 'applied' })

    const standardHarness = harness({ pauses: [{ id: 'standard', kind: 'standard' }] })
    await expect(
      executeGovernedWorkflowTransition(standardHarness.tx, input({ essential: true }), approvedPlanner),
    ).resolves.toMatchObject({
      status: 'rejected',
      rejection: { reasonCode: WORKFLOW_EXECUTION_REASON.AUTOMATION_PAUSED },
    })
  })
})
