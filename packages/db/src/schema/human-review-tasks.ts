import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'
import { identityResolutionCases } from './identity-resolution.js'
import { outboundNotifications } from './outbound-notifications.js'
import { workflowInstances } from './workflow-instances.js'

export const humanReviewPriorityEnum = pgEnum('human_review_priority', ['normal', 'high', 'critical'])
export const humanReviewStatusEnum = pgEnum('human_review_status', ['open', 'in_progress', 'resolved', 'cancelled'])
export const humanReviewTaskEventTypeEnum = pgEnum('human_review_task_event_type', [
  'created',
  'holding_queued',
  'assigned',
  'released',
  'resolution_recorded',
  'resume_rejected',
  'returned_to_automation',
  'cancelled',
  'sla_escalated',
])

/** Current queue projection. Immutable operational history lives in human_review_task_events. */
export const humanReviewTasks = pgTable(
  'human_review_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id').references(() => workflowInstances.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'restrict' }),
    workflowReference: text('workflow_reference').notNull(),
    episodeNumber: integer('episode_number').notNull().default(1),
    identityResolutionId: uuid('identity_resolution_id').references(() => identityResolutionCases.id, {
      onDelete: 'restrict',
    }),
    reasonCode: text('reason_code').notNull(),
    priority: humanReviewPriorityEnum('priority').notNull(),
    status: humanReviewStatusEnum('status').notNull().default('open'),
    /** Contains reason/state codes and pseudonymous references only, never raw applicant details. */
    casePacket: jsonb('case_packet').notNull(),
    casePacketVersion: text('case_packet_version').notNull().default('legacy-case-packet-v0'),
    automationPaused: boolean('automation_paused').notNull().default(true),
    assigneeId: text('assignee_id'),
    assignedAt: tstz('assigned_at'),
    slaPolicyVersion: text('sla_policy_version'),
    dueAt: tstz('due_at'),
    escalationAt: tstz('escalation_at'),
    resolvedAt: tstz('resolved_at'),
    resolvedBy: text('resolved_by'),
    resolutionCode: text('resolution_code'),
    resolutionReason: text('resolution_reason'),
    returnedToAutomationAt: tstz('returned_to_automation_at'),
    deduplicationKey: text('deduplication_key').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('human_review_tasks_deduplication_key').on(table.deduplicationKey),
    uniqueIndex('human_review_tasks_workflow_episode_key')
      .on(table.workflowId, table.episodeNumber)
      .where(sql`${table.workflowId} is not null`),
    index('human_review_tasks_queue_idx').on(
      table.status,
      table.priority,
      table.dueAt,
      table.campaignId,
      table.assigneeId,
      table.createdAt,
    ),
    index('human_review_tasks_identity_resolution_idx').on(table.identityResolutionId),
    index('human_review_tasks_workflow_idx').on(table.workflowId, table.createdAt),
    check(
      'human_review_tasks_valid_workflow_reference',
      sql`char_length(${table.workflowReference}) between 1 and 200`,
    ),
    check('human_review_tasks_positive_episode', sql`${table.episodeNumber} > 0`),
    check('human_review_tasks_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('human_review_tasks_case_packet_version', sql`${table.casePacketVersion} ~ '^[a-z][a-z0-9-]*-v[0-9]+$'`),
    check('human_review_tasks_valid_deduplication_key', sql`char_length(${table.deduplicationKey}) between 1 and 256`),
    check(
      'human_review_tasks_assignment_coherence',
      sql`(${table.assigneeId} is null and ${table.assignedAt} is null) or (${table.assigneeId} is not null and ${table.assignedAt} is not null)`,
    ),
    check(
      'human_review_tasks_sla_coherence',
      sql`(${table.slaPolicyVersion} is null and ${table.dueAt} is null and ${table.escalationAt} is null) or (${table.slaPolicyVersion} is not null and ${table.dueAt} is not null and ${table.escalationAt} is not null and ${table.escalationAt} >= ${table.dueAt})`,
    ),
    check(
      'human_review_tasks_resolution_coherence',
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} is not null and ${table.resolvedBy} is not null and ${table.resolutionCode} is not null and ${table.resolutionReason} is not null)`,
    ),
    check(
      'human_review_tasks_resolution_code',
      sql`${table.resolutionCode} is null or ${table.resolutionCode} ~ '^[A-Z][A-Z0-9_]*$'`,
    ),
  ],
)

/** Append-only ownership, SLA, resolution, rejection and resume evidence. */
export const humanReviewTaskEvents = pgTable(
  'human_review_task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => humanReviewTasks.id, { onDelete: 'restrict' }),
    eventType: humanReviewTaskEventTypeEnum('event_type').notNull(),
    fromStatus: humanReviewStatusEnum('from_status'),
    toStatus: humanReviewStatusEnum('to_status'),
    actorId: text('actor_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    correlationId: text('correlation_id').notNull(),
    detail: jsonb('detail').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('human_review_task_events_dedupe_key').on(table.deduplicationKey),
    index('human_review_task_events_timeline_idx').on(table.taskId, table.occurredAt),
    check('human_review_task_events_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('human_review_task_events_correlation', sql`char_length(${table.correlationId}) between 1 and 200`),
  ],
)

/** One logical holding message for each handoff episode and approved template version. */
export const humanReviewHoldingMessages = pgTable(
  'human_review_holding_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => humanReviewTasks.id, { onDelete: 'restrict' }),
    templateVersion: integer('template_version').notNull(),
    outboundNotificationId: uuid('outbound_notification_id')
      .notNull()
      .references(() => outboundNotifications.id, { onDelete: 'restrict' }),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('human_review_holding_messages_task_template_key').on(table.taskId, table.templateVersion),
    unique('human_review_holding_messages_notification_key').on(table.outboundNotificationId),
    check('human_review_holding_messages_positive_template', sql`${table.templateVersion} > 0`),
  ],
)

export type HumanReviewTaskRow = typeof humanReviewTasks.$inferSelect
export type NewHumanReviewTaskRow = typeof humanReviewTasks.$inferInsert
export type HumanReviewTaskEventRow = typeof humanReviewTaskEvents.$inferSelect
export type HumanReviewHoldingMessageRow = typeof humanReviewHoldingMessages.$inferSelect
