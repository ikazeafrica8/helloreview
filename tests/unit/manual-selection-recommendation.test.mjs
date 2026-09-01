import { describe, expect, test } from 'vitest'
import {
  MANUAL_SELECTION_RECOMMENDATION_REASON,
  createManualSelectionRecommendationSideEffectHandlers,
} from '../../apps/worker/dist/processors/index.js'
import { WORKFLOW_SIDE_EFFECT } from '../../packages/workflow-runtime/dist/index.js'

const workflowId = '11111111-1111-4111-8111-111111111111'
const applicationId = '22222222-2222-4222-8222-222222222222'
const participantId = '33333333-3333-4333-8333-333333333333'
const campaignId = '44444444-4444-4444-8444-444444444444'
const recommendationId = '55555555-5555-4555-8555-555555555555'
const occurredAt = new Date('2026-09-01T06:00:00Z')
const sourceFreshnessAt = new Date('2026-09-01T05:00:00Z')

const effect = {
  id: '66666666-6666-4666-8666-666666666666',
  workflowId,
  workflowEventId: '77777777-7777-4777-8777-777777777777',
  dimension: 'selection',
  effectCode: WORKFLOW_SIDE_EFFECT.LOAD_SELECTION_RULE,
  participantId,
  campaignId,
  campaignType: 'shipping',
  campaignStatus: 'active',
  automationMode: 'active',
  sourceWorkflowVersion: 2,
  currentWorkflowVersion: 2,
  sourceEventKind: 'transition',
  sourceTriggerCode: 'APPLICATION_MATCHED',
}

const harness = () => {
  const state = { recommendation: undefined, inserts: 0, versionQueries: 0, workflowUpdates: 0 }
  const tx = {
    query: async (sql, values = []) => {
      if (sql.includes('JOIN applications a')) {
        return {
          rows: [
            {
              application_id: applicationId,
              blogger_level: 1,
              blog_daily_visitors: 1500,
              blogger_region: '서울',
              last_source_event_id: 'import-event-1',
              source_freshness_at: sourceFreshnessAt,
            },
          ],
        }
      }
      if (sql.includes('FROM workflow_instances') && sql.includes('FOR UPDATE')) {
        return { rows: [{ application_id: applicationId, campaign_id: campaignId }] }
      }
      if (sql.includes('FROM selection_recommendations') && sql.includes('deduplication_key')) {
        return { rows: state.recommendation === undefined ? [] : [state.recommendation] }
      }
      if (sql.includes('COALESCE(MAX(version)')) {
        state.versionQueries += 1
        return { rows: [{ next_version: 1 }] }
      }
      if (sql.startsWith('INSERT INTO selection_recommendations')) {
        state.inserts += 1
        state.recommendation = { id: recommendationId, version: 1 }
        state.insertValues = values
        return { rows: [{ id: recommendationId }] }
      }
      if (sql.startsWith('UPDATE workflow_instances')) {
        state.workflowUpdates += 1
        return { rows: [] }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  return { tx, state }
}

describe('manual selection recommendation handler', () => {
  test('records imported ranking facts for human review without selecting the applicant', async () => {
    const testHarness = harness()
    const handler = createManualSelectionRecommendationSideEffectHandlers(() => occurredAt)[
      WORKFLOW_SIDE_EFFECT.LOAD_SELECTION_RULE
    ]
    expect(handler).toBeTypeOf('function')

    await expect(handler(testHarness.tx, effect)).resolves.toEqual({ status: 'completed' })
    expect(testHarness.state.inserts).toBe(1)
    expect(testHarness.state.workflowUpdates).toBe(0)
    expect(testHarness.state.insertValues[4]).toBe('human_review')
    expect(testHarness.state.insertValues[5]).toBe(MANUAL_SELECTION_RECOMMENDATION_REASON.REVIEW_REQUIRED)
    expect(JSON.parse(testHarness.state.insertValues[7])).toEqual({
      bloggerLevel: 1,
      blogDailyVisitors: 1500,
      bloggerRegion: '서울',
      mappedRegion: null,
      measurementPeriod: 'website_average_daily',
      sourceEventId: 'import-event-1',
    })
  })

  test('deduplicates replay without creating a second recommendation version', async () => {
    const testHarness = harness()
    const handler = createManualSelectionRecommendationSideEffectHandlers(() => occurredAt)[
      WORKFLOW_SIDE_EFFECT.LOAD_SELECTION_RULE
    ]

    await handler(testHarness.tx, effect)
    await handler(testHarness.tx, effect)
    expect(testHarness.state).toMatchObject({ inserts: 1, versionQueries: 1, workflowUpdates: 0 })
  })
})
