import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import {
  evaluateSelectionRecommendation,
  type RankingEvidence,
  type SelectionEvaluation,
  type SelectionPolicy,
} from './recommendation-evaluator.js'
import { SELECTION_REASON } from './reason-codes.js'

export const AUTOMATIC_SELECTION_ENABLED = false as const

export type RecordSelectionRecommendationInput = Readonly<{
  workflowId: string
  applicationId: string
  campaignId: string
  evidence: RankingEvidence
  policy: SelectionPolicy | null
  actorReference: string
  occurredAt: Date
}>

export type RecordManualSelectionDecisionInput = Readonly<{
  workflowId: string
  recommendationId: string | null
  decision: 'selected' | 'not_selected' | 'revoked'
  actorType: 'operator' | 'system' | 'participant'
  actorReference: string
  authorized: boolean
  reasonCode: string
  correlationId: string
  occurredAt: Date
}>

export type SelectionRecommendationRecord = Readonly<{
  id: string
  version: number
  evaluation: SelectionEvaluation
  deduplicated: boolean
}>

export type ManualSelectionDecisionRecord = Readonly<{
  id: string
  version: number
  decision: RecordManualSelectionDecisionInput['decision']
  shadowOutcome: 'matched' | 'differed' | 'not_comparable' | null
  deduplicated: boolean
}>

export class SelectionServiceError extends Error {
  override readonly name = 'SelectionServiceError'
  constructor(readonly reasonCode: string) {
    super(`selection action rejected: ${reasonCode}`)
  }
}

const rowText = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`selection query returned invalid ${column}`)
}

const rowInteger = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw new Error(`selection query returned invalid ${column}`)
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const shadowOutcome = (
  recommendation: SelectionEvaluation['result'],
  decision: RecordManualSelectionDecisionInput['decision'],
): 'matched' | 'differed' | 'not_comparable' => {
  if (recommendation === 'human_review' || decision === 'revoked') return 'not_comparable'
  if (
    (recommendation === 'recommend_select' && decision === 'selected') ||
    (recommendation === 'recommend_not_select' && decision === 'not_selected')
  )
    return 'matched'
  return 'differed'
}

@Injectable()
export class SelectionService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  participantFacingStatus(): Readonly<{ status: 'pending_operator_review' }> {
    return { status: 'pending_operator_review' }
  }

  async recordRecommendation(input: RecordSelectionRecommendationInput): Promise<SelectionRecommendationRecord> {
    const evaluation = evaluateSelectionRecommendation(input.evidence, input.policy)
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
      policyVersion: evaluation.policyVersion,
      evaluation,
    })
    return runInTransaction(this.pool, async (tx) => {
      const workflow = await this.lockScopedWorkflow(tx, input.workflowId)
      if (
        rowText(workflow, 'application_id') !== input.applicationId ||
        rowText(workflow, 'campaign_id') !== input.campaignId
      )
        throw new SelectionServiceError('SELECTION_SCOPE_MISMATCH')
      const existing = await tx.query(
        `SELECT id, version, result, reason_code, policy_version, component_outcomes
           FROM selection_recommendations WHERE deduplication_key = $1`,
        [deduplicationKey],
      )
      if (existing.rows[0] !== undefined) {
        return {
          id: rowText(existing.rows[0], 'id'),
          version: rowInteger(existing.rows[0], 'version'),
          evaluation,
          deduplicated: true,
        }
      }
      const versionResult = await tx.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM selection_recommendations WHERE workflow_id = $1`,
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
          evaluation.result,
          evaluation.reasonCode,
          evaluation.policyVersion,
          JSON.stringify(facts),
          JSON.stringify(evaluation.componentOutcomes),
          input.evidence.sourceFreshnessAt,
          input.actorReference,
          deduplicationKey,
          input.occurredAt,
        ],
      )
      return {
        id: rowText(inserted.rows[0] ?? {}, 'id'),
        version,
        evaluation,
        deduplicated: false,
      }
    })
  }

  async recordManualDecision(input: RecordManualSelectionDecisionInput): Promise<ManualSelectionDecisionRecord> {
    if (input.actorType !== 'operator' || !input.authorized)
      throw new SelectionServiceError('SELECTION_OPERATOR_NOT_AUTHORIZED')
    if (!/^[A-Z][A-Z0-9_]*$/.test(input.reasonCode)) throw new SelectionServiceError('SELECTION_REASON_REQUIRED')
    const deduplicationKey = digest({
      workflowId: input.workflowId,
      recommendationId: input.recommendationId,
      decision: input.decision,
      actorReference: input.actorReference,
      reasonCode: input.reasonCode,
      correlationId: input.correlationId,
    })
    return runInTransaction(this.pool, async (tx) => {
      const workflow = await this.lockScopedWorkflow(tx, input.workflowId)
      const existing = await tx.query(
        `SELECT d.id, d.version, d.decision, c.outcome
           FROM selection_manual_decisions d
           LEFT JOIN selection_shadow_comparisons c ON c.manual_decision_id = d.id
          WHERE d.deduplication_key = $1`,
        [deduplicationKey],
      )
      if (existing.rows[0] !== undefined) {
        const comparison = existing.rows[0].outcome
        return {
          id: rowText(existing.rows[0], 'id'),
          version: rowInteger(existing.rows[0], 'version'),
          decision: input.decision,
          shadowOutcome:
            comparison === 'matched' || comparison === 'differed' || comparison === 'not_comparable'
              ? comparison
              : null,
          deduplicated: true,
        }
      }
      const priorState = rowText(workflow, 'selection_state')
      if (input.decision === 'revoked' && priorState !== 'manually_selected' && priorState !== 'auto_selected')
        throw new SelectionServiceError('SELECTION_REVOCATION_INVALID_STATE')

      let recommendationResult: SelectionEvaluation['result'] | null = null
      if (input.recommendationId !== null) {
        const recommendation = await tx.query(
          `SELECT result FROM selection_recommendations WHERE id = $1 AND workflow_id = $2`,
          [input.recommendationId, input.workflowId],
        )
        const value = recommendation.rows[0]?.result
        if (value !== 'recommend_select' && value !== 'recommend_not_select' && value !== 'human_review')
          throw new SelectionServiceError('SELECTION_RECOMMENDATION_NOT_FOUND')
        recommendationResult = value
      }

      const versionResult = await tx.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM selection_manual_decisions WHERE workflow_id = $1`,
        [input.workflowId],
      )
      const version = rowInteger(versionResult.rows[0] ?? {}, 'next_version')
      const inserted = await tx.query(
        `INSERT INTO selection_manual_decisions (
           workflow_id, recommendation_id, version, decision, prior_workflow_state,
           reason_code, actor_reference, deduplication_key, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          input.workflowId,
          input.recommendationId,
          version,
          input.decision,
          priorState,
          input.reasonCode,
          input.actorReference,
          deduplicationKey,
          input.occurredAt,
        ],
      )
      const decisionId = rowText(inserted.rows[0] ?? {}, 'id')
      await tx.query(
        `INSERT INTO selection_decision_heads (workflow_id, decision_id, updated_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (workflow_id) DO UPDATE SET decision_id = EXCLUDED.decision_id, updated_at = EXCLUDED.updated_at`,
        [input.workflowId, decisionId, input.occurredAt],
      )
      const nextState =
        input.decision === 'selected'
          ? 'manually_selected'
          : input.decision === 'not_selected'
            ? 'not_selected'
            : 'human_review_required'
      if (input.decision === 'revoked') {
        await tx.query(
          `UPDATE workflow_instances
              SET selection_state = $2, selection_origin_at = $3,
                  reservation_state = CASE WHEN reservation_state = 'not_applicable' THEN reservation_state ELSE 'human_review_required' END,
                  reservation_origin_at = CASE WHEN reservation_state = 'not_applicable' THEN reservation_origin_at ELSE $3 END,
                  guideline_state = 'not_ready', guideline_origin_at = $3,
                  automation_mode_state = 'paused_for_human', automation_mode_origin_at = $3,
                  version = version + 1, updated_at = $3
            WHERE id = $1`,
          [input.workflowId, nextState, input.occurredAt],
        )
        await tx.query(
          `INSERT INTO human_review_tasks (
             workflow_reference, reason_code, priority, status, case_packet,
             automation_paused, deduplication_key, created_at, updated_at
           ) VALUES ($1,'SELECTION_REVOKED','high','open',$2::jsonb,true,$3,$4,$4)
           ON CONFLICT (deduplication_key) DO NOTHING`,
          [
            input.workflowId,
            JSON.stringify({
              stateCode: nextState,
              summaryCode: 'SELECTION_REVOKED',
              evidenceCodes: [`SELECTION_DECISION_VERSION_${String(version)}`],
              allowedActionCodes: ['REVIEW_SELECTION_REVOCATION', 'KEEP_AUTOMATION_PAUSED'],
              recommendationCode: 'REVIEW_SELECTION_REVOCATION',
            }),
            `selection-revoked:${decisionId}`,
            input.occurredAt,
          ],
        )
      } else {
        await tx.query(
          `UPDATE workflow_instances
              SET selection_state = $2, selection_origin_at = $3,
                  version = version + 1, updated_at = $3
            WHERE id = $1`,
          [input.workflowId, nextState, input.occurredAt],
        )
      }

      let comparison: ManualSelectionDecisionRecord['shadowOutcome'] = null
      if (recommendationResult !== null && input.recommendationId !== null) {
        comparison = shadowOutcome(recommendationResult, input.decision)
        await tx.query(
          `INSERT INTO selection_shadow_comparisons (
             recommendation_id, manual_decision_id, outcome, created_at
           ) VALUES ($1,$2,$3,$4)`,
          [input.recommendationId, decisionId, comparison, input.occurredAt],
        )
      }
      await this.insertAudit(tx, input, decisionId, priorState, nextState)
      return { id: decisionId, version, decision: input.decision, shadowOutcome: comparison, deduplicated: false }
    })
  }

  private async lockScopedWorkflow(tx: DbTransaction, workflowId: string): Promise<Record<string, unknown>> {
    const result = await tx.query(
      `SELECT id, participant_id, application_id, campaign_id, selection_state
         FROM workflow_instances WHERE id = $1 FOR UPDATE`,
      [workflowId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new SelectionServiceError('SELECTION_WORKFLOW_NOT_FOUND')
    return row
  }

  private async insertAudit(
    tx: DbTransaction,
    input: RecordManualSelectionDecisionInput,
    decisionId: string,
    priorState: string,
    nextState: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO audit_logs (
         occurred_at, actor_type, actor_id, action, target_type, target_id,
         result, reason, correlation_id, protected_action, detail
       ) VALUES ($1,'operator',$2,$3,'selection_decision',$4,'success',$5,$6,'yes',$7::jsonb)`,
      [
        input.occurredAt,
        input.actorReference,
        input.decision === 'revoked' ? SELECTION_REASON.SELECTION_REVOKED : 'SELECTION_DECIDED',
        decisionId,
        input.reasonCode,
        input.correlationId,
        JSON.stringify({ workflowReference: input.workflowId, priorState, nextState }),
      ],
    )
  }
}
