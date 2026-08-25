import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { applications } from './applications.js'
import { campaigns } from './campaigns.js'
import { workflowInstances } from './workflow-instances.js'

export const selectionRecommendationResultEnum = pgEnum('selection_recommendation_result', [
  'recommend_select',
  'recommend_not_select',
  'human_review',
])
export const selectionManualDecisionResultEnum = pgEnum('selection_manual_decision_result', [
  'selected',
  'not_selected',
  'revoked',
])
export const selectionShadowOutcomeEnum = pgEnum('selection_shadow_outcome', ['matched', 'differed', 'not_comparable'])

export const selectionRecommendations = pgTable(
  'selection_recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    result: selectionRecommendationResultEnum('result').notNull(),
    reasonCode: text('reason_code').notNull(),
    policyVersion: text('policy_version'),
    inputFacts: jsonb('input_facts').notNull(),
    componentOutcomes: jsonb('component_outcomes').notNull(),
    sourceFreshnessAt: tstz('source_freshness_at').notNull(),
    actorReference: text('actor_reference').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('selection_recommendations_workflow_version_key').on(table.workflowId, table.version),
    unique('selection_recommendations_dedupe_key').on(table.deduplicationKey),
    index('selection_recommendations_application_idx').on(table.applicationId, table.createdAt),
    index('selection_recommendations_campaign_result_idx').on(table.campaignId, table.result, table.createdAt),
    check('selection_recommendations_positive_version', sql`${table.version} > 0`),
    check('selection_recommendations_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

export const selectionManualDecisions = pgTable(
  'selection_manual_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    recommendationId: uuid('recommendation_id').references(() => selectionRecommendations.id, {
      onDelete: 'restrict',
    }),
    version: integer('version').notNull(),
    decision: selectionManualDecisionResultEnum('decision').notNull(),
    priorWorkflowState: text('prior_workflow_state').notNull(),
    reasonCode: text('reason_code').notNull(),
    actorReference: text('actor_reference').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('selection_manual_decisions_workflow_version_key').on(table.workflowId, table.version),
    unique('selection_manual_decisions_dedupe_key').on(table.deduplicationKey),
    index('selection_manual_decisions_workflow_timeline_idx').on(table.workflowId, table.occurredAt),
    check('selection_manual_decisions_positive_version', sql`${table.version} > 0`),
    check('selection_manual_decisions_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

export const selectionDecisionHeads = pgTable('selection_decision_heads', {
  workflowId: uuid('workflow_id')
    .primaryKey()
    .references(() => workflowInstances.id, { onDelete: 'restrict' }),
  decisionId: uuid('decision_id')
    .notNull()
    .unique()
    .references(() => selectionManualDecisions.id, { onDelete: 'restrict' }),
  updatedAt: tstz('updated_at').notNull(),
})

export const selectionShadowComparisons = pgTable(
  'selection_shadow_comparisons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => selectionRecommendations.id, { onDelete: 'restrict' }),
    manualDecisionId: uuid('manual_decision_id')
      .notNull()
      .references(() => selectionManualDecisions.id, { onDelete: 'restrict' }),
    outcome: selectionShadowOutcomeEnum('outcome').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [unique('selection_shadow_comparisons_pair_key').on(table.recommendationId, table.manualDecisionId)],
)

export type SelectionRecommendationRow = typeof selectionRecommendations.$inferSelect
export type SelectionManualDecisionRow = typeof selectionManualDecisions.$inferSelect
export type SelectionDecisionHeadRow = typeof selectionDecisionHeads.$inferSelect
export type SelectionShadowComparisonRow = typeof selectionShadowComparisons.$inferSelect
