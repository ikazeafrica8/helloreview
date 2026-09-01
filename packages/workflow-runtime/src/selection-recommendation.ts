import { createHash } from 'node:crypto'
import type { DbTransaction } from '@helloreview/db'

export type SelectionRecommendationEvidence = Readonly<{
  bloggerLevel: number | null
  blogDailyVisitors: number | null
  bloggerRegion: string | null
  mappedRegion: string | null
  measurementPeriod: string | null
  sourceFreshnessAt: Date
  sourceEventId: string
  fresh: boolean
}>

export type SelectionRecommendationEvaluation = Readonly<{
  result: 'recommend_select' | 'recommend_not_select' | 'human_review'
  reasonCode: string
  policyVersion: string | null
  componentOutcomes: readonly unknown[]
}>

export type RecordSelectionRecommendationInput<
  Evaluation extends SelectionRecommendationEvaluation = SelectionRecommendationEvaluation,
> = Readonly<{
  workflowId: string
  applicationId: string
  campaignId: string
  evidence: SelectionRecommendationEvidence
  evaluation: Evaluation
  actorReference: string
  occurredAt: Date
}>

export type SelectionRecommendationRecord<
  Evaluation extends SelectionRecommendationEvaluation = SelectionRecommendationEvaluation,
> = Readonly<{
  id: string
  version: number
  evaluation: Evaluation
  deduplicated: boolean
}>

export class SelectionRecommendationError extends Error {
  override readonly name = 'SelectionRecommendationError'

  constructor(readonly reasonCode: string) {
    super(`selection recommendation rejected: ${reasonCode}`)
  }
}

const rowText = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`selection recommendation query returned invalid ${column}`)
}

const rowInteger = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw new Error(`selection recommendation query returned invalid ${column}`)
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export const recordSelectionRecommendation = async <Evaluation extends SelectionRecommendationEvaluation>(
  tx: DbTransaction,
  input: RecordSelectionRecommendationInput<Evaluation>,
): Promise<SelectionRecommendationRecord<Evaluation>> => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(input.evaluation.reasonCode)) {
    throw new SelectionRecommendationError('SELECTION_RECOMMENDATION_REASON_INVALID')
  }
  const workflow = await tx.query(
    `SELECT application_id, campaign_id
       FROM workflow_instances
      WHERE id = $1
      FOR UPDATE`,
    [input.workflowId],
  )
  const workflowRow = workflow.rows[0]
  if (workflowRow === undefined) throw new SelectionRecommendationError('SELECTION_WORKFLOW_NOT_FOUND')
  if (
    rowText(workflowRow, 'application_id') !== input.applicationId ||
    rowText(workflowRow, 'campaign_id') !== input.campaignId
  ) {
    throw new SelectionRecommendationError('SELECTION_SCOPE_MISMATCH')
  }

  const facts = {
    bloggerLevel: input.evidence.bloggerLevel,
    blogDailyVisitors: input.evidence.blogDailyVisitors,
    bloggerRegion: input.evidence.bloggerRegion,
    mappedRegion: input.evidence.mappedRegion,
    measurementPeriod: input.evidence.measurementPeriod,
    sourceEventId: input.evidence.sourceEventId,
  }
  const deduplicationKey = digest({
    workflowId: input.workflowId,
    facts,
    sourceFreshnessAt: input.evidence.sourceFreshnessAt.toISOString(),
    policyVersion: input.evaluation.policyVersion,
    evaluation: input.evaluation,
  })
  const existing = await tx.query(
    `SELECT id, version
       FROM selection_recommendations
      WHERE deduplication_key = $1`,
    [deduplicationKey],
  )
  if (existing.rows[0] !== undefined) {
    return {
      id: rowText(existing.rows[0], 'id'),
      version: rowInteger(existing.rows[0], 'version'),
      evaluation: input.evaluation,
      deduplicated: true,
    }
  }

  const versionResult = await tx.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM selection_recommendations
      WHERE workflow_id = $1`,
    [input.workflowId],
  )
  const version = rowInteger(versionResult.rows[0] ?? {}, 'next_version')
  const inserted = await tx.query(
    `INSERT INTO selection_recommendations (
       workflow_id, application_id, campaign_id, version, result, reason_code,
       policy_version, input_facts, component_outcomes, source_freshness_at,
       actor_reference, deduplication_key, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.workflowId,
      input.applicationId,
      input.campaignId,
      version,
      input.evaluation.result,
      input.evaluation.reasonCode,
      input.evaluation.policyVersion,
      JSON.stringify(facts),
      JSON.stringify(input.evaluation.componentOutcomes),
      input.evidence.sourceFreshnessAt,
      input.actorReference,
      deduplicationKey,
      input.occurredAt,
    ],
  )
  return {
    id: rowText(inserted.rows[0] ?? {}, 'id'),
    version,
    evaluation: input.evaluation,
    deduplicated: false,
  }
}
