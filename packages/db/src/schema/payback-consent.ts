import { sql } from 'drizzle-orm'
import { check, index, integer, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaignRules } from './campaign-rules.js'
import { campaigns } from './campaigns.js'
import { outboundNotifications } from './outbound-notifications.js'
import { participants } from './participants.js'
import { workflowInstances } from './workflow-instances.js'

export const paybackConsentStateEnum = pgEnum('payback_consent_state', [
  'not_requested',
  'awaiting_response',
  'agreed',
  'declined',
  'withdrawn',
  'human_review_required',
])
export const paybackConsentActorTypeEnum = pgEnum('payback_consent_actor_type', ['system', 'operator', 'participant'])

export const paybackConsentAggregates = pgTable(
  'payback_consent_aggregates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .unique()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [index('payback_consent_aggregates_participant_idx').on(table.participantId, table.createdAt)],
)

/** Immutable state history. Free text is evidence only and never itself the current state. */
export const paybackConsentVersions = pgTable(
  'payback_consent_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregateId: uuid('aggregate_id')
      .notNull()
      .references(() => paybackConsentAggregates.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    state: paybackConsentStateEnum('state').notNull(),
    termsVersion: integer('terms_version'),
    requestId: text('request_id'),
    evidenceMessageId: text('evidence_message_id'),
    channel: text('channel'),
    classification: text('classification'),
    actorType: paybackConsentActorTypeEnum('actor_type').notNull(),
    actorReference: text('actor_reference').notNull(),
    reasonCode: text('reason_code').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('payback_consent_versions_aggregate_version_key').on(table.aggregateId, table.version),
    index('payback_consent_versions_workflow_timeline_idx').on(table.workflowId, table.occurredAt),
    check('payback_consent_versions_positive_version', sql`${table.version} > 0`),
    check('payback_consent_versions_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check(
      'payback_consent_versions_request_correlation',
      sql`${table.state} = 'not_requested' or (${table.termsVersion} is not null and ${table.requestId} is not null)`,
    ),
  ],
)

export const paybackConsentHeads = pgTable('payback_consent_heads', {
  aggregateId: uuid('aggregate_id')
    .primaryKey()
    .references(() => paybackConsentAggregates.id, { onDelete: 'restrict' }),
  versionId: uuid('version_id')
    .notNull()
    .unique()
    .references(() => paybackConsentVersions.id, { onDelete: 'restrict' }),
  updatedAt: tstz('updated_at').notNull(),
})

export const paybackConsentRequests = pgTable(
  'payback_consent_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregateId: uuid('aggregate_id')
      .notNull()
      .references(() => paybackConsentAggregates.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    requestId: text('request_id').notNull().unique(),
    termsRuleId: uuid('terms_rule_id')
      .notNull()
      .references(() => campaignRules.id, { onDelete: 'restrict' }),
    termsVersion: integer('terms_version').notNull(),
    outboundNotificationId: uuid('outbound_notification_id').references(() => outboundNotifications.id, {
      onDelete: 'restrict',
    }),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('payback_consent_requests_aggregate_terms_key').on(table.aggregateId, table.termsVersion),
    index('payback_consent_requests_workflow_idx').on(table.workflowId, table.createdAt),
    check('payback_consent_requests_positive_terms_version', sql`${table.termsVersion} > 0`),
  ],
)

export type PaybackConsentAggregateRow = typeof paybackConsentAggregates.$inferSelect
export type PaybackConsentVersionRow = typeof paybackConsentVersions.$inferSelect
export type PaybackConsentRequestRow = typeof paybackConsentRequests.$inferSelect
