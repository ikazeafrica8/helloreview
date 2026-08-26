import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { participants } from './participants.js'
import { campaigns } from './campaigns.js'
import { automationPauses, automationPauseScopeEnum } from './automation-pauses.js'
import { workflowInstances } from './workflow-instances.js'

export const privacyRequestTypeEnum = pgEnum('privacy_request_type', [
  'unspecified',
  'access',
  'correction',
  'deletion',
  'export',
])

export const privacyIdentityVerificationStateEnum = pgEnum('privacy_identity_verification_state', [
  'unverified',
  'pending',
  'verified',
  'failed',
])

export const privacyRequestStatusEnum = pgEnum('privacy_request_status', [
  'received',
  'identity_verification',
  'in_review',
  'blocked',
  'completed',
  'denied',
  'cancelled',
])

export const privacyRequestActorTypeEnum = pgEnum('privacy_request_actor_type', ['system', 'operator', 'participant'])

export const privacyRequestEventTypeEnum = pgEnum('privacy_request_event_type', [
  'intake_recorded',
  'identity_verification_changed',
  'scope_changed',
  'assigned',
  'released',
  'status_changed',
  'evidence_recorded',
  'completed',
  'denied',
  'cancelled',
])

/**
 * Current privacy-request projection. The participant link is explicitly claimed until the
 * verification state is advanced by T97; it must never authorize disclosure on its own.
 */
export const privacyRequests = pgTable(
  'privacy_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestReference: text('request_reference').notNull(),
    requesterReference: text('requester_reference').notNull(),
    claimedParticipantId: uuid('claimed_participant_id').references(() => participants.id, {
      onDelete: 'restrict',
    }),
    requestType: privacyRequestTypeEnum('request_type').notNull(),
    identityVerificationState: privacyIdentityVerificationStateEnum('identity_verification_state')
      .notNull()
      .default('unverified'),
    verificationPolicyReference: text('verification_policy_reference'),
    verificationMethod: text('verification_method'),
    verifiedAt: tstz('verified_at'),
    scopeVersion: text('scope_version').notNull(),
    /** Versioned codes and pseudonymous references only; never raw request text or contact data. */
    scope: jsonb('scope').notNull(),
    status: privacyRequestStatusEnum('status').notNull().default('received'),
    deadlinePolicyReference: text('deadline_policy_reference'),
    deadlineAt: tstz('deadline_at'),
    assigneeId: text('assignee_id'),
    inputDigest: text('input_digest').notNull(),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (table) => [
    unique('privacy_requests_request_reference_key').on(table.requestReference),
    index('privacy_requests_queue_idx').on(table.status, table.deadlineAt, table.assigneeId, table.createdAt),
    index('privacy_requests_claimed_participant_idx').on(table.claimedParticipantId, table.createdAt),
    check('privacy_requests_request_reference', sql`char_length(${table.requestReference}) between 1 and 200`),
    check('privacy_requests_requester_reference', sql`char_length(${table.requesterReference}) between 1 and 200`),
    check('privacy_requests_scope_version', sql`${table.scopeVersion} ~ '^[a-z][a-z0-9-]*-v[0-9]+$'`),
    check('privacy_requests_scope_object', sql`jsonb_typeof(${table.scope}) = 'object'`),
    check(
      'privacy_requests_deadline_policy_coherence',
      sql`(${table.deadlinePolicyReference} is null and ${table.deadlineAt} is null) or (${table.deadlinePolicyReference} is not null and ${table.deadlineAt} is not null)`,
    ),
    check(
      'privacy_requests_assignee_reference',
      sql`${table.assigneeId} is null or char_length(${table.assigneeId}) between 1 and 200`,
    ),
    check('privacy_requests_input_digest', sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'privacy_requests_verified_projection_coherence',
      sql`(${table.identityVerificationState} = 'verified' and ${table.verificationPolicyReference} is not null and ${table.verificationMethod} is not null and ${table.verifiedAt} is not null)
          or (${table.identityVerificationState} <> 'verified' and ${table.verificationPolicyReference} is null and ${table.verificationMethod} is null and ${table.verifiedAt} is null)`,
    ),
  ],
)

/** Immutable links between a privacy request and each narrowly scoped processing pause it created. */
export const privacyRequestProcessingPauses = pgTable(
  'privacy_request_processing_pauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => privacyRequests.id, { onDelete: 'restrict' }),
    pauseId: uuid('pause_id')
      .notNull()
      .references(() => automationPauses.id, { onDelete: 'restrict' }),
    scope: automationPauseScopeEnum('scope').notNull(),
    participantId: uuid('participant_id').references(() => participants.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id').references(() => workflowInstances.id, { onDelete: 'restrict' }),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('privacy_request_processing_pauses_request_pause_key').on(table.requestId, table.pauseId),
    index('privacy_request_processing_pauses_request_idx').on(table.requestId, table.createdAt),
    check(
      'privacy_request_processing_pauses_scope_target',
      sql`(${table.scope} = 'participant' and ${table.participantId} is not null and ${table.campaignId} is null and ${table.workflowId} is null)
          or (${table.scope} = 'participant_campaign' and ${table.participantId} is not null and ${table.campaignId} is not null and ${table.workflowId} is null)
          or (${table.scope} = 'workflow' and ${table.participantId} is null and ${table.campaignId} is null and ${table.workflowId} is not null)`,
    ),
  ],
)

/** Immutable request history and evidence references. */
export const privacyRequestEvents = pgTable(
  'privacy_request_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => privacyRequests.id, { onDelete: 'restrict' }),
    eventType: privacyRequestEventTypeEnum('event_type').notNull(),
    fromStatus: privacyRequestStatusEnum('from_status'),
    toStatus: privacyRequestStatusEnum('to_status'),
    fromVerificationState: privacyIdentityVerificationStateEnum('from_verification_state'),
    toVerificationState: privacyIdentityVerificationStateEnum('to_verification_state'),
    actorType: privacyRequestActorTypeEnum('actor_type').notNull(),
    actorReference: text('actor_reference').notNull(),
    reasonCode: text('reason_code').notNull(),
    evidenceReference: text('evidence_reference').notNull(),
    correlationId: text('correlation_id').notNull(),
    /** Structured codes and pseudonymous references only. */
    detail: jsonb('detail').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('privacy_request_events_deduplication_key').on(table.deduplicationKey),
    index('privacy_request_events_timeline_idx').on(table.requestId, table.occurredAt),
    check('privacy_request_events_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('privacy_request_events_actor_reference', sql`char_length(${table.actorReference}) between 1 and 200`),
    check('privacy_request_events_evidence_reference', sql`char_length(${table.evidenceReference}) between 1 and 200`),
    check('privacy_request_events_correlation', sql`char_length(${table.correlationId}) between 1 and 200`),
    check(
      'privacy_request_events_deduplication_key_length',
      sql`char_length(${table.deduplicationKey}) between 1 and 256`,
    ),
    check('privacy_request_events_detail_object', sql`jsonb_typeof(${table.detail}) = 'object'`),
  ],
)

export type PrivacyRequestRow = typeof privacyRequests.$inferSelect
export type NewPrivacyRequestRow = typeof privacyRequests.$inferInsert
export type PrivacyRequestEventRow = typeof privacyRequestEvents.$inferSelect
export type PrivacyRequestProcessingPauseRow = typeof privacyRequestProcessingPauses.$inferSelect
