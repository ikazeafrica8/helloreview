import { index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'

// The audit log (PRD §17.2, §21.4, T13).
//
// APPEND-ONLY, ENFORCED BY TRIGGERS — and it is worth being precise about what that does and does
// not buy, because the earlier wording here overclaimed.
//
// The triggers in 0001 reject UPDATE, DELETE and TRUNCATE, and 0002 makes them ENABLE ALWAYS so a
// session cannot skip them with `SET session_replication_role = replica` (measured: before 0002,
// that one session variable plus a DELETE emptied the table). TRUNCATE needs its own trigger
// because it does not fire DELETE triggers.
//
// What triggers CANNOT do is defend against the role that owns the table: an owner can still run
// `ALTER TABLE audit_logs DISABLE TRIGGER ALL`, and a superuser can do anything. Closing that needs
// privilege separation — a distinct owner/migration role, with UPDATE, DELETE and TRUNCATE revoked
// from the application role — which is a deployment decision about role provisioning. It is
// recorded as an open decision in tasks/todo.md rather than assumed here.
//
// So: accidental rewrites and the cheap deliberate bypass are closed. A determined operator with
// the application's own credentials is not, until the role work lands.
//
// NOTHING HERE HOLDS RAW PERSONAL DATA. Actor and target identifiers are masked or pseudonymous
// before they arrive (SPEC.md §21.4), and `detail` is for masked evidence references, never for a
// phone number or an address. §17.2 says the same: "Mask or tokenize PII".

/** Who acted. Kept coarse on purpose — the detail belongs in actorId, already masked. */
export const auditActorTypeEnum = pgEnum('audit_actor_type', [
  'system',
  'operator',
  'participant',
  'provider',
  'scheduler',
])

/** What became of the attempt. A rejected action is as important to record as a successful one. */
export const auditResultEnum = pgEnum('audit_result', ['success', 'failure', 'rejected'])

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Not `created_at`: this is when the audited thing happened, which a caller may set from an
    // event's own timestamp rather than from wall-clock insert time.
    occurredAt: tstz('occurred_at').notNull().defaultNow(),

    actorType: auditActorTypeEnum('actor_type').notNull(),
    /** Masked or pseudonymous — never a raw name, phone number or channel identifier. */
    actorId: text('actor_id').notNull(),

    /** SCREAMING_SNAKE, e.g. SELECTION_OVERRIDDEN, GUIDELINE_DELIVERED (SPEC.md §6). */
    action: text('action').notNull(),

    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),

    result: auditResultEnum('result').notNull(),
    /** A reason CODE, not prose — the same registry the deterministic decisions report. */
    reason: text('reason'),

    /** Nullable because a scheduled job may legitimately run outside any request scope. */
    correlationId: text('correlation_id'),

    /**
     * Whether this action is one §23.3 treats as protected.
     *
     * Stored rather than derived, so a later change to the protected list cannot retroactively
     * reclassify what was already written — the record says what the rule was at the time.
     */
    protectedAction: text('protected_action').notNull().default('no'),

    /** Masked evidence references only. Never raw personal data. */
    detail: jsonb('detail'),
  },
  (table) => [
    // §13.15 FR-ADM-009: audit logs are searchable by participant, application, campaign, actor and
    // event. Each index below serves one of those lookups.
    index('audit_logs_actor_idx').on(table.actorType, table.actorId),
    index('audit_logs_target_idx').on(table.targetType, table.targetId),
    index('audit_logs_action_idx').on(table.action),
    index('audit_logs_occurred_at_idx').on(table.occurredAt),
    index('audit_logs_correlation_idx').on(table.correlationId),
  ],
)
