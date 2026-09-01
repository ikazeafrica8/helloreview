import { describe, expect, test } from 'vitest'
import {
  WORKFLOW_BOOTSTRAP_REASON,
  bootstrapApplicationWorkflow,
  createApplicationWorkflow,
} from '../../packages/workflow-runtime/dist/index.js'

const applicationId = '11111111-1111-4111-8111-111111111111'
const campaignId = '22222222-2222-4222-8222-222222222222'
const participantId = '33333333-3333-4333-8333-333333333333'
const workflowId = '44444444-4444-4444-8444-444444444444'
const occurredAt = new Date('2026-08-24T01:00:00Z')

const harness = () => {
  const state = {
    workflow: undefined,
    participantCreates: 0,
    workflowEvents: 0,
    sideEffects: 0,
    audits: 0,
    workflowInsert: [],
  }
  return {
    state,
    tx: {
      query: async (sql, values = []) => {
        if (sql.startsWith('SELECT campaign_id FROM applications')) return { rows: [{ campaign_id: campaignId }] }
        if (sql.includes('SELECT id, participant_id') && sql.includes('FROM workflow_instances')) {
          return { rows: state.workflow === undefined ? [] : [{ ...state.workflow }] }
        }
        if (sql.startsWith('INSERT INTO participants')) {
          state.participantCreates += 1
          return { rows: [{ id: participantId }] }
        }
        if (sql.includes('SELECT a.campaign_id, c.type, c.visit_method')) {
          return { rows: [{ campaign_id: campaignId, type: 'shipping', visit_method: 'not_applicable' }] }
        }
        if (sql.startsWith('INSERT INTO workflow_instances')) {
          state.workflowInsert = values
          if (state.workflow !== undefined) return { rows: [] }
          state.workflow = { id: workflowId, participant_id: participantId }
          return { rows: [{ id: workflowId }] }
        }
        if (sql.startsWith('INSERT INTO workflow_events')) {
          state.workflowEvents += 1
          return { rows: [{ id: `event-${String(state.workflowEvents)}` }] }
        }
        if (sql.startsWith('INSERT INTO workflow_side_effects')) {
          state.sideEffects += 1
          return { rows: [] }
        }
        if (sql.startsWith('INSERT INTO audit_logs')) {
          state.audits += 1
          return { rows: [] }
        }
        throw new Error(`unexpected query: ${sql}`)
      },
    },
  }
}

const input = {
  applicationId,
  actorType: 'system',
  actorId: 'application-import-bootstrap',
  triggeringEventId: 'application-import:first',
  correlationId: 'correlation:first',
  occurredAt,
}

describe('shared application workflow bootstrap', () => {
  test('creates one participant, projection, immutable initialization ledger, and protected audit', async () => {
    const testHarness = harness()
    const first = await bootstrapApplicationWorkflow(testHarness.tx, input)
    const replay = await bootstrapApplicationWorkflow(testHarness.tx, { ...input, triggeringEventId: 'replay' })

    expect(first).toEqual({ workflowId, participantId, applicationId, campaignId, created: true })
    expect(replay).toEqual({ workflowId, participantId, applicationId, campaignId, created: false })
    expect(testHarness.state).toMatchObject({ participantCreates: 1, workflowEvents: 12, sideEffects: 1, audits: 1 })
    expect(testHarness.state.workflowInsert).toContain('application_completed')
    expect(testHarness.state.workflowInsert).toContain('address_requested')
  })

  test('rejects a replay that tries to bind the application to another participant', async () => {
    const testHarness = harness()
    await bootstrapApplicationWorkflow(testHarness.tx, input)
    await expect(
      bootstrapApplicationWorkflow(testHarness.tx, {
        ...input,
        participantId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toMatchObject({ reasonCode: WORKFLOW_BOOTSTRAP_REASON.SCOPE_CONFLICT })
    expect(testHarness.state.workflowEvents).toBe(12)
    expect(testHarness.state.sideEffects).toBe(1)
  })

  test('keeps generic workflow creation at not-applied without scheduling direct-application matching', async () => {
    const testHarness = harness()
    await createApplicationWorkflow(testHarness.tx, {
      ...input,
      participantId,
      campaignId,
    })

    expect(testHarness.state.workflowInsert).toContain('not_applied')
    expect(testHarness.state.workflowInsert).not.toContain('application_completed')
    expect(testHarness.state.sideEffects).toBe(0)
  })
})
