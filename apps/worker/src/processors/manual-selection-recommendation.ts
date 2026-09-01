import { WORKFLOW_SIDE_EFFECT, recordSelectionRecommendation } from '@helloreview/workflow-runtime'
import type { WorkflowSideEffectHandler, WorkflowSideEffectHandlers } from './workflow-side-effects.js'

export const MANUAL_SELECTION_RECOMMENDATION_REASON = {
  REVIEW_REQUIRED: 'SELECTION_MANUAL_REVIEW_REQUIRED',
} as const

export class ManualSelectionRecommendationError extends Error {
  override readonly name = 'ManualSelectionRecommendationError'

  constructor(readonly reasonCode: string) {
    super(`manual selection recommendation failed: ${reasonCode}`)
  }
}

const textColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`selection evidence query returned invalid ${column}`)
}

const nullableTextColumn = (row: Record<string, unknown>, column: string): string | null => {
  const value = row[column]
  if (value === null || typeof value === 'string') return value
  throw new Error(`selection evidence query returned invalid ${column}`)
}

const nullableIntegerColumn = (row: Record<string, unknown>, column: string): number | null => {
  const value = row[column]
  if (value === null || (typeof value === 'number' && Number.isSafeInteger(value))) return value
  throw new Error(`selection evidence query returned invalid ${column}`)
}

const dateColumn = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`selection evidence query returned invalid ${column}`)
}

/**
 * Records a shadow/manual-review recommendation only.
 *
 * The website export supplies level, average-daily visitors, and a free-text region, but the pilot
 * still lacks an approved freshness window and authoritative campaign-region mapping. Those facts
 * are retained for the operator; no threshold is evaluated and no workflow selection state changes.
 */
export const createManualSelectionRecommendationHandler =
  (now: () => Date = () => new Date()): WorkflowSideEffectHandler =>
  async (tx, effect) => {
    const selected = await tx.query(
      `SELECT w.application_id, a.blogger_level, a.blog_daily_visitors, a.blogger_region,
              a.last_source_event_id,
              COALESCE(f.last_successful_reconciliation_at, a.last_synchronized_at) AS source_freshness_at
         FROM workflow_instances w
         JOIN applications a ON a.id = w.application_id
         LEFT JOIN application_source_freshness f ON f.source_system = a.source_system
        WHERE w.id = $1 AND w.participant_id = $2 AND w.campaign_id = $3
        FOR SHARE OF w, a`,
      [effect.workflowId, effect.participantId, effect.campaignId],
    )
    const row = selected.rows[0]
    if (row === undefined) {
      throw new ManualSelectionRecommendationError('SELECTION_EVIDENCE_SCOPE_NOT_FOUND')
    }

    await recordSelectionRecommendation(tx, {
      workflowId: effect.workflowId,
      applicationId: textColumn(row, 'application_id'),
      campaignId: effect.campaignId,
      evidence: {
        bloggerLevel: nullableIntegerColumn(row, 'blogger_level'),
        blogDailyVisitors: nullableIntegerColumn(row, 'blog_daily_visitors'),
        bloggerRegion: nullableTextColumn(row, 'blogger_region'),
        mappedRegion: null,
        measurementPeriod: 'website_average_daily',
        sourceFreshnessAt: dateColumn(row, 'source_freshness_at'),
        sourceEventId: textColumn(row, 'last_source_event_id'),
        fresh: false,
      },
      evaluation: {
        result: 'human_review',
        reasonCode: MANUAL_SELECTION_RECOMMENDATION_REASON.REVIEW_REQUIRED,
        policyVersion: null,
        componentOutcomes: [],
      },
      actorReference: 'manual-selection-recommendation',
      occurredAt: now(),
    })
    return { status: 'completed' }
  }

export const createManualSelectionRecommendationSideEffectHandlers = (
  now: () => Date = () => new Date(),
): WorkflowSideEffectHandlers => ({
  [WORKFLOW_SIDE_EFFECT.LOAD_SELECTION_RULE]: createManualSelectionRecommendationHandler(now),
})
