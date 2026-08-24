import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { applications } from './applications.js'
import { campaigns } from './campaigns.js'
import { guidelineVersions } from './guideline-versions.js'
import { outboundNotifications } from './outbound-notifications.js'
import { participants } from './participants.js'
import { workflowInstances } from './workflow-instances.js'

export const guidelineDeliveryStatusEnum = pgEnum('guideline_delivery_status', ['queued', 'delivered', 'failed'])
export const guidelineDeliveryAttemptOutcomeEnum = pgEnum('guideline_delivery_attempt_outcome', [
  'queued',
  'suppressed',
  'blocked',
])
export const guidelineIncidentStatusEnum = pgEnum('guideline_incident_status', ['open', 'resolved'])

/** One logical automatic delivery per workflow and guideline version (FR-GDL-003/004). */
export const guidelineDeliveries = pgTable(
  'guideline_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    guidelineVersionId: uuid('guideline_version_id')
      .notNull()
      .references(() => guidelineVersions.id, { onDelete: 'restrict' }),
    guidelineVersion: integer('guideline_version').notNull(),
    channel: text('channel').notNull(),
    triggeringEventId: text('triggering_event_id').notNull(),
    ruleResult: jsonb('rule_result').notNull(),
    status: guidelineDeliveryStatusEnum('status').notNull().default('queued'),
    outboundNotificationId: uuid('outbound_notification_id')
      .notNull()
      .references(() => outboundNotifications.id, { onDelete: 'restrict' }),
    providerResult: jsonb('provider_result').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    requestedAt: tstz('requested_at').notNull(),
    deliveredAt: tstz('delivered_at'),
    updatedAt: tstz('updated_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('guideline_deliveries_workflow_version_key').on(table.workflowId, table.guidelineVersion),
    unique('guideline_deliveries_deduplication_key').on(table.deduplicationKey),
    index('guideline_deliveries_audit_idx').on(table.campaignId, table.participantId, table.createdAt),
    index('guideline_deliveries_status_idx').on(table.status, table.updatedAt),
    check('guideline_deliveries_positive_version', sql`${table.guidelineVersion} > 0`),
    check('guideline_deliveries_channel_code', sql`${table.channel} ~ '^[A-Z][A-Z0-9_]*$'`),
    check(
      'guideline_deliveries_delivery_evidence',
      sql`${table.status} <> 'delivered' or ${table.deliveredAt} is not null`,
    ),
  ],
)

/** Append-only record of every request, including every duplicate suppression. */
export const guidelineDeliveryAttempts = pgTable(
  'guideline_delivery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    deliveryId: uuid('delivery_id').references(() => guidelineDeliveries.id, { onDelete: 'restrict' }),
    guidelineVersion: integer('guideline_version'),
    triggeringEventId: text('triggering_event_id').notNull(),
    outcome: guidelineDeliveryAttemptOutcomeEnum('outcome').notNull(),
    reasonCode: text('reason_code').notNull(),
    ruleResult: jsonb('rule_result').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    index('guideline_delivery_attempts_timeline_idx').on(table.workflowId, table.occurredAt),
    check('guideline_delivery_attempts_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check(
      'guideline_delivery_attempts_version_coherence',
      sql`(${table.outcome} = 'blocked') or (${table.guidelineVersion} is not null and ${table.deliveryId} is not null)`,
    ),
  ],
)

/** Critical premature-delivery incidents, deduplicated per logical delivery and reason. */
export const guidelineDeliveryIncidents = pgTable(
  'guideline_delivery_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => guidelineDeliveries.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    severity: text('severity').notNull().default('critical'),
    status: guidelineIncidentStatusEnum('status').notNull().default('open'),
    reasonCode: text('reason_code').notNull(),
    stateSnapshot: jsonb('state_snapshot').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    resolvedAt: tstz('resolved_at'),
  },
  (table) => [
    unique('guideline_delivery_incidents_delivery_reason_key').on(table.deliveryId, table.reasonCode),
    index('guideline_delivery_incidents_open_idx').on(table.status, table.createdAt),
    check('guideline_delivery_incidents_critical_only', sql`${table.severity} = 'critical'`),
    check('guideline_delivery_incidents_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

export type GuidelineDeliveryRow = typeof guidelineDeliveries.$inferSelect
export type NewGuidelineDeliveryRow = typeof guidelineDeliveries.$inferInsert
export type GuidelineDeliveryAttemptRow = typeof guidelineDeliveryAttempts.$inferSelect
export type GuidelineDeliveryIncidentRow = typeof guidelineDeliveryIncidents.$inferSelect
