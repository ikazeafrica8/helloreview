import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { auditActorTypeEnum } from './audit-logs.js'
import { campaigns } from './campaigns.js'
import { campaignTypeEnum } from './enums.js'
import { participants } from './participants.js'

export const automationPauseScopeEnum = pgEnum('automation_pause_scope', [
  'global',
  'campaign',
  'workflow_type',
  'participant',
])
export const automationPauseKindEnum = pgEnum('automation_pause_kind', ['standard', 'emergency_kill_switch'])

/** Durable pause activations. Deactivation closes the activation record without deleting history. */
export const automationPauses = pgTable(
  'automation_pauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: automationPauseScopeEnum('scope').notNull(),
    kind: automationPauseKindEnum('kind').notNull().default('standard'),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'restrict' }),
    workflowType: campaignTypeEnum('workflow_type'),
    participantId: uuid('participant_id').references(() => participants.id, { onDelete: 'restrict' }),
    reasonCode: text('reason_code').notNull(),
    activatedByType: auditActorTypeEnum('activated_by_type').notNull(),
    activatedById: text('activated_by_id').notNull(),
    activatedAt: tstz('activated_at').notNull(),
    deactivatedByType: auditActorTypeEnum('deactivated_by_type'),
    deactivatedById: text('deactivated_by_id'),
    deactivationReasonCode: text('deactivation_reason_code'),
    deactivatedAt: tstz('deactivated_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('automation_pauses_active_global_key')
      .on(table.kind)
      .where(sql`${table.scope} = 'global' and ${table.deactivatedAt} is null`),
    uniqueIndex('automation_pauses_active_campaign_key')
      .on(table.campaignId, table.kind)
      .where(sql`${table.scope} = 'campaign' and ${table.deactivatedAt} is null`),
    uniqueIndex('automation_pauses_active_workflow_type_key')
      .on(table.workflowType, table.kind)
      .where(sql`${table.scope} = 'workflow_type' and ${table.deactivatedAt} is null`),
    uniqueIndex('automation_pauses_active_participant_key')
      .on(table.participantId, table.kind)
      .where(sql`${table.scope} = 'participant' and ${table.deactivatedAt} is null`),
    index('automation_pauses_active_lookup_idx').on(table.scope, table.kind, table.deactivatedAt),
    check(
      'automation_pauses_scope_target',
      sql`(${table.scope} = 'global' and ${table.campaignId} is null and ${table.workflowType} is null and ${table.participantId} is null)
          or (${table.scope} = 'campaign' and ${table.campaignId} is not null and ${table.workflowType} is null and ${table.participantId} is null)
          or (${table.scope} = 'workflow_type' and ${table.campaignId} is null and ${table.workflowType} is not null and ${table.participantId} is null)
          or (${table.scope} = 'participant' and ${table.campaignId} is null and ${table.workflowType} is null and ${table.participantId} is not null)`,
    ),
    check(
      'automation_pauses_emergency_global_only',
      sql`${table.kind} <> 'emergency_kill_switch' or ${table.scope} = 'global'`,
    ),
    check('automation_pauses_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check(
      'automation_pauses_valid_deactivation',
      sql`${table.deactivatedAt} is null or (${table.deactivatedAt} >= ${table.activatedAt} and ${table.deactivatedByType} is not null and ${table.deactivatedById} is not null and ${table.deactivationReasonCode} is not null)`,
    ),
  ],
)

export type AutomationPauseRow = typeof automationPauses.$inferSelect
export type NewAutomationPauseRow = typeof automationPauses.$inferInsert
