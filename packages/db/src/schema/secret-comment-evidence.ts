import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { attachments } from './attachments.js'
import { inboundMessages } from './conversations.js'
import { participants } from './participants.js'
import { workflowInstances } from './workflow-instances.js'

// Secret-comment claim evidence (T135, FR-SC-001-004).
//
// SEPARATE FILE, NOT STYLE. The foreign keys have to stay acyclic: `attachments` points at
// `inbound_messages`, and this table points at both. Keeping it in conversations.ts would make
// attachments.ts and conversations.ts import each other, and a cycle between two files that build
// table objects at module load is the kind of thing that fails as `undefined` at runtime rather
// than as an error at compile time.

export const secretCommentEvidenceStatusEnum = pgEnum('secret_comment_evidence_status', [
  'claimed',
  'screenshot_received',
  'superseded',
  'rejected',
])

/**
 * Append-only immutable versions of secret-comment evidence.
 *
 * SUPPORTING EVIDENCE ONLY, structurally. There is no column here that could bind an application,
 * decide a selection, or approve anything, and `supporting_only` carries a CHECK that pins it true —
 * so "this evidence is authoritative" is not a row anyone can write, including a future migration
 * author who has forgotten why. FR-SC-001–004 make the participant's claim a hint that a
 * deterministic service must still confirm.
 */
export const secretCommentEvidenceVersions = pgTable(
  'secret_comment_evidence_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: secretCommentEvidenceStatusEnum('status').notNull(),

    inboundMessageId: uuid('inbound_message_id').references(() => inboundMessages.id, { onDelete: 'restrict' }),
    attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'restrict' }),

    reasonCode: text('reason_code').notNull(),
    /** Pinned true by a CHECK. See the table note: the alternative must not be storable. */
    supportingOnly: boolean('supporting_only').notNull().default(true),
    supersedesVersionId: uuid('supersedes_version_id'),
    actorReference: text('actor_reference').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('secret_comment_evidence_versions_workflow_version_key').on(table.workflowId, table.version),
    index('secret_comment_evidence_versions_timeline_idx').on(table.workflowId, table.occurredAt, table.id),
    check('secret_comment_evidence_versions_positive_version', sql`${table.version} > 0`),
    check('secret_comment_evidence_versions_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('secret_comment_evidence_versions_actor_length', sql`char_length(${table.actorReference}) between 1 and 200`),
    check(
      'secret_comment_evidence_versions_screenshot_evidence',
      sql`${table.status} <> 'screenshot_received' or ${table.attachmentId} is not null`,
    ),
    check(
      'secret_comment_evidence_versions_no_self_supersession',
      sql`${table.supersedesVersionId} is distinct from ${table.id}`,
    ),
    // Pinning the column true is the point: supporting evidence must not be promotable by an UPDATE
    // that never happens, by a future migration, or by a caller that passes false.
    check('secret_comment_evidence_versions_supporting_only', sql`${table.supportingOnly}`),
    foreignKey({
      name: 'secret_comment_evidence_versions_supersedes_fk',
      columns: [table.supersedesVersionId],
      foreignColumns: [table.id],
    }).onDelete('restrict'),
  ],
)

export type SecretCommentEvidenceVersionRow = typeof secretCommentEvidenceVersions.$inferSelect
export type NewSecretCommentEvidenceVersionRow = typeof secretCommentEvidenceVersions.$inferInsert
