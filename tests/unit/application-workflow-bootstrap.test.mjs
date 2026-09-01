import { describe, expect, test, vi } from 'vitest'
import { ApplicationWorkflowBootstrapService } from '../../apps/api/dist/modules/workflow-core/index.js'

const applicationId = '11111111-1111-4111-8111-111111111111'
const campaignId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const participantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const workflow = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', participantId, applicationId, campaignId }

describe('application workflow bootstrap orchestration', () => {
  test('owns the database transaction and returns the shared operation result', async () => {
    let storedWorkflow
    let workflowEventNumber = 0
    const query = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: null }
      if (sql.startsWith('SELECT campaign_id FROM applications')) return { rows: [{ campaign_id: campaignId }] }
      if (sql.includes('SELECT id, participant_id') && sql.includes('FROM workflow_instances')) {
        return { rows: storedWorkflow === undefined ? [] : [{ id: workflow.id, participant_id: participantId }] }
      }
      if (sql.startsWith('INSERT INTO participants')) return { rows: [{ id: participantId }] }
      if (sql.includes('SELECT a.campaign_id, c.type, c.visit_method')) {
        return { rows: [{ campaign_id: campaignId, type: 'shipping', visit_method: 'not_applicable' }] }
      }
      if (sql.startsWith('INSERT INTO workflow_instances')) {
        storedWorkflow = workflow
        return { rows: [{ id: workflow.id }] }
      }
      if (sql.startsWith('INSERT INTO workflow_events')) {
        workflowEventNumber += 1
        return { rows: [{ id: `event-${String(workflowEventNumber)}` }] }
      }
      if (sql.startsWith('INSERT INTO audit_logs') || sql.startsWith('INSERT INTO workflow_side_effects')) {
        return { rows: [] }
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const client = { query, release: vi.fn() }
    const pool = { connect: vi.fn(async () => client) }
    const workflows = { findByApplicationCampaignWithClient: vi.fn(async () => workflow) }
    const service = new ApplicationWorkflowBootstrapService(pool, workflows)

    const first = await service.bootstrap({
      applicationId,
      triggeringEventId: 'import:first',
      correlationId: 'correlation:first',
      occurredAt: new Date('2026-08-24T01:00:00Z'),
    })
    const replay = await service.bootstrap({
      applicationId,
      triggeringEventId: 'import:replay',
      correlationId: 'correlation:replay',
      occurredAt: new Date('2026-08-24T01:01:00Z'),
    })

    expect(first).toEqual({ workflow, created: true })
    expect(replay).toEqual({ workflow, created: false })
    expect(workflows.findByApplicationCampaignWithClient).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2)
    expect(query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(0)
  })
})
