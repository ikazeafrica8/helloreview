import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { identityResolutionCases } from './identity-resolution.js'

export const humanReviewPriorityEnum = pgEnum('human_review_priority', ['normal', 'high', 'critical'])
export const humanReviewStatusEnum = pgEnum('human_review_status', ['open', 'in_progress', 'resolved', 'cancelled'])

/** Minimal Milestone-1 queue record. Ownership, SLA and resume controls arrive in Milestone 3. */
export const humanReviewTasks = pgTable(
  'human_review_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable pre-workflow or workflow scope. T34 can attach the real workflow id later. */
    workflowReference: text('workflow_reference').notNull(),
    identityResolutionId: uuid('identity_resolution_id').references(() => identityResolutionCases.id, {
      onDelete: 'restrict',
    }),
    reasonCode: text('reason_code').notNull(),
    priority: humanReviewPriorityEnum('priority').notNull(),
    status: humanReviewStatusEnum('status').notNull().default('open'),
    /** Contains reason/state codes and pseudonymous references only, never raw applicant details. */
    casePacket: jsonb('case_packet').notNull(),
    automationPaused: boolean('automation_paused').notNull().default(true),
    deduplicationKey: text('deduplication_key').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('human_review_tasks_deduplication_key').on(table.deduplicationKey),
    index('human_review_tasks_queue_idx').on(table.status, table.priority, table.createdAt),
    index('human_review_tasks_identity_resolution_idx').on(table.identityResolutionId),
    check(
      'human_review_tasks_valid_workflow_reference',
      sql`char_length(${table.workflowReference}) between 1 and 200`,
    ),
    check('human_review_tasks_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('human_review_tasks_valid_deduplication_key', sql`char_length(${table.deduplicationKey}) between 1 and 256`),
  ],
)

export type HumanReviewTaskRow = typeof humanReviewTasks.$inferSelect
export type NewHumanReviewTaskRow = typeof humanReviewTasks.$inferInsert
