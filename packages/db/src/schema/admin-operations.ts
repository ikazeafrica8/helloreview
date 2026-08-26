import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { eventInbox } from './event-inbox.js'

/** Immutable receipt for an operator-authorized retry of one failed inbound job. */
export const adminRetryOperations = pgTable(
  'admin_retry_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationReference: text('operation_reference').notNull(),
    targetEventId: uuid('target_event_id')
      .notNull()
      .references(() => eventInbox.id, { onDelete: 'restrict' }),
    inputDigest: text('input_digest').notNull(),
    priorStatus: text('prior_status').notNull(),
    outcomeCode: text('outcome_code').notNull(),
    actorReference: text('actor_reference').notNull(),
    reasonCode: text('reason_code').notNull(),
    correlationId: text('correlation_id').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('admin_retry_operations_reference_key').on(table.operationReference),
    index('admin_retry_operations_target_idx').on(table.targetEventId, table.occurredAt),
    check('admin_retry_operations_digest', sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check('admin_retry_operations_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('admin_retry_operations_outcome_code', sql`${table.outcomeCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

export type AdminRetryOperationRow = typeof adminRetryOperations.$inferSelect
