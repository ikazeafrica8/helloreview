import { describe, expect, test } from 'vitest'
import {
  DIRECT_APPLICATION_IDENTITY_REASON,
  createDirectApplicationIdentityHandler,
  createDirectApplicationSideEffectHandlers,
} from '../../apps/worker/dist/processors/index.js'
import { WORKFLOW_SIDE_EFFECT, initialWorkflowSnapshot } from '../../packages/workflow-runtime/dist/index.js'

const workflowId = '11111111-1111-4111-8111-111111111111'
const participantId = '22222222-2222-4222-8222-222222222222'
const campaignId = '33333333-3333-4333-8333-333333333333'
const effectId = '44444444-4444-4444-8444-444444444444'
const sourceEventId = '55555555-5555-4555-8555-555555555555'
const occurredAt = new Date('2026-09-01T05:00:00Z')
const originAt = new Date('2026-09-01T04:00:00Z')

const effect = (overrides = {}) => ({
  id: effectId,
  workflowId,
  workflowEventId: sourceEventId,
  dimension: 'application',
  effectCode: WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING,
  participantId,
  campaignId,
  campaignType: 'shipping',
  campaignStatus: 'active',
  automationMode: 'active',
  sourceWorkflowVersion: 0,
  currentWorkflowVersion: 0,
  sourceEventKind: 'initialized',
  sourceTriggerCode: 'WORKFLOW_INITIALIZED',
  ...overrides,
})

const harness = () => {
  const snapshot = {
    ...initialWorkflowSnapshot({ campaignType: 'shipping', visitMethod: 'not_applicable' }),
    application: 'application_completed',
  }
  const state = { snapshot, version: 0, eventSequence: 0, sideEffects: [] }
  const row = () => ({
    id: workflowId,
    participant_id: participantId,
    campaign_id: campaignId,
    version: state.version,
    campaign_status: 'active',
    application_state: state.snapshot.application,
    selection_state: state.snapshot.selection,
    campaign_type: state.snapshot.campaign_type,
    visit_method: state.snapshot.visit_method,
    secret_comment_state: state.snapshot.secret_comment,
    payback_consent_state: state.snapshot.payback_consent,
    business_approval_state: state.snapshot.business_approval,
    shipping_state: state.snapshot.shipping,
    reservation_state: state.snapshot.reservation,
    guideline_state: state.snapshot.guideline,
    human_handoff_state: state.snapshot.human_handoff,
    automation_mode_state: state.snapshot.automation_mode,
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
  })
  const tx = {
    query: async (sql, values = []) => {
      if (sql.includes('FROM workflow_instances w')) return { rows: [row()] }
      if (sql.includes('FROM automation_pauses')) return { rows: [] }
      if (sql.startsWith('UPDATE workflow_instances')) {
        const stateColumn = sql.match(/SET ([a-z_]+) = \$2/)?.[1]
        if (stateColumn === 'application_state') state.snapshot.application = values[1]
        else if (stateColumn === 'selection_state') state.snapshot.selection = values[1]
        else throw new Error(`unexpected workflow state column: ${stateColumn}`)
        state.version = values[3]
        return { rows: [{ id: workflowId }] }
      }
      if (sql.startsWith('INSERT INTO workflow_events')) {
        state.eventSequence += 1
        return { rows: [{ id: `66666666-6666-4666-8666-66666666666${state.eventSequence}` }] }
      }
      if (sql.startsWith('INSERT INTO workflow_side_effects')) {
        state.sideEffects.push({
          effectCode: values[3],
          workflowEventId: values[1],
          workflowVersion: state.version,
        })
        return { rows: [] }
      }
      if (sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  return { tx, state }
}

describe('direct application identity handler', () => {
  test('advances an authoritative imported application to manual selection review without a channel link', async () => {
    const testHarness = harness()
    const handler = createDirectApplicationSideEffectHandlers(() => occurredAt)[
      WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING
    ]
    expect(handler).toBeTypeOf('function')

    await expect(handler(testHarness.tx, effect())).resolves.toEqual({ status: 'completed' })
    expect(testHarness.state).toMatchObject({
      version: 2,
      snapshot: { application: 'application_matched', selection: 'review_pending' },
    })
    expect(testHarness.state.sideEffects).toEqual([
      expect.objectContaining({ effectCode: WORKFLOW_SIDE_EFFECT.PERSIST_CHANNEL_LINK, workflowVersion: 1 }),
      expect.objectContaining({ effectCode: WORKFLOW_SIDE_EFFECT.LOAD_SELECTION_RULE, workflowVersion: 2 }),
    ])
  })

  test('leaves non-import matching work pending for candidate resolution', async () => {
    const handler = createDirectApplicationIdentityHandler(() => occurredAt)
    await expect(
      handler({ query: () => Promise.reject(new Error('must not query')) }, effect({ sourceEventKind: 'transition' })),
    ).resolves.toEqual({
      status: 'blocked',
      reasonCode: DIRECT_APPLICATION_IDENTITY_REASON.CANDIDATE_RESOLUTION_PENDING,
    })
  })
})
