import { sql } from 'drizzle-orm'
import { check, index, integer, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { applications } from './applications.js'
import { campaigns } from './campaigns.js'
import { workflowBusinessApprovalStateEnum, workflowInstances } from './workflow-instances.js'

export const businessApprovalSourceEnum = pgEnum('business_approval_source', [
  'authorized_operator',
  'authorized_system',
])

/** Immutable Visit C approval versions. Currentness lives in business_approval_heads. */
export const businessApprovals = pgTable(
  'business_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    state: workflowBusinessApprovalStateEnum('state').notNull(),
    source: businessApprovalSourceEnum('source').notNull(),
    approverReference: text('approver_reference').notNull(),
    scopeCode: text('scope_code').notNull(),
    reasonCode: text('reason_code').notNull(),
    issuedAt: tstz('issued_at'),
    expiresAt: tstz('expires_at'),
    recordedAt: tstz('recorded_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('business_approvals_workflow_version_key').on(table.workflowId, table.version),
    index('business_approvals_scope_history_idx').on(table.campaignId, table.applicationId, table.version),
    check('business_approvals_positive_version', sql`${table.version} > 0`),
    check('business_approvals_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('business_approvals_scope_code', sql`char_length(${table.scopeCode}) between 1 and 200`),
    check('business_approvals_issued_evidence', sql`${table.state} <> 'approved' or ${table.issuedAt} is not null`),
    check(
      'business_approvals_expiry_after_issue',
      sql`${table.expiresAt} is null or (${table.issuedAt} is not null and ${table.expiresAt} > ${table.issuedAt})`,
    ),
  ],
)

/** One mutable pointer per workflow; changing it never mutates a historical approval version. */
export const businessApprovalHeads = pgTable('business_approval_heads', {
  workflowId: uuid('workflow_id')
    .primaryKey()
    .references(() => workflowInstances.id, { onDelete: 'restrict' }),
  approvalId: uuid('approval_id')
    .notNull()
    .unique()
    .references(() => businessApprovals.id, { onDelete: 'restrict' }),
  updatedAt: tstz('updated_at').notNull(),
})

export type BusinessApprovalRow = typeof businessApprovals.$inferSelect
export type NewBusinessApprovalRow = typeof businessApprovals.$inferInsert
export type BusinessApprovalHeadRow = typeof businessApprovalHeads.$inferSelect
