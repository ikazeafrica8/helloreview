import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { applications } from './applications.js'
import { auditActorTypeEnum } from './audit-logs.js'
import { campaigns } from './campaigns.js'
import { campaignTypeEnum, visitMethodEnum } from './enums.js'
import { participants } from './participants.js'

export const workflowApplicationStateEnum = pgEnum('workflow_application_state', [
  'not_applied',
  'application_requested',
  'application_pending',
  'application_completed',
  'application_matched',
  'match_ambiguous',
  'application_cancelled',
])

export const workflowSelectionStateEnum = pgEnum('workflow_selection_state', [
  'not_reviewed',
  'review_pending',
  'auto_selected',
  'manually_selected',
  'not_selected',
  'human_review_required',
])

export const workflowSecretCommentStateEnum = pgEnum('workflow_secret_comment_state', [
  'not_claimed',
  'claimed',
  'screenshot_requested',
  'screenshot_received',
  'verified',
  'rejected',
  'human_review_required',
])

export const workflowPaybackConsentStateEnum = pgEnum('workflow_payback_consent_state', [
  'not_applicable',
  'not_requested',
  'awaiting_response',
  'agreed',
  'declined',
  'withdrawn',
  'human_review_required',
])

export const workflowBusinessApprovalStateEnum = pgEnum('workflow_business_approval_state', [
  'not_required',
  'not_requested',
  'pending',
  'approved',
  'rejected',
  'expired',
  'revoked',
  'human_review_required',
])

export const workflowShippingStateEnum = pgEnum('workflow_shipping_state', [
  'not_applicable',
  'address_requested',
  'address_received',
  'address_incomplete',
  'address_valid',
  'address_change_requested',
  'locked',
])

export const workflowReservationStateEnum = pgEnum('workflow_reservation_state', [
  'not_applicable',
  'not_started',
  'instructions_sent',
  'awaiting_participant',
  'information_received',
  'screenshot_received',
  'extraction_pending',
  'validation_pending',
  'valid',
  'correction_required',
  'cancelled',
  'rescheduled',
  'human_review_required',
])

export const workflowGuidelineStateEnum = pgEnum('workflow_guideline_state', [
  'not_ready',
  'ready',
  'delivery_queued',
  'delivered',
  'delivery_failed',
  'suppressed_as_duplicate',
  'redelivery_authorized',
])

export const workflowHumanHandoffStateEnum = pgEnum('workflow_human_handoff_state', [
  'not_required',
  'requested',
  'queued',
  'assigned',
  'in_progress',
  'resolved',
  'returned_to_automation',
  'closed',
])

export const workflowAutomationModeStateEnum = pgEnum('workflow_automation_mode_state', [
  'active',
  'paused_by_rule',
  'paused_for_human',
  'human_owned',
  'campaign_paused',
  'globally_paused',
  'closed',
])

export const workflowDimensionEnum = pgEnum('workflow_dimension', [
  'application',
  'selection',
  'campaign_type',
  'visit_method',
  'secret_comment',
  'payback_consent',
  'business_approval',
  'shipping',
  'reservation',
  'guideline',
  'human_handoff',
  'automation_mode',
])

export const workflowEventKindEnum = pgEnum('workflow_event_kind', [
  'initialized',
  'transition',
  'transition_rejected',
  'stale_event_rejected',
  'correction',
])

export const workflowEventResultEnum = pgEnum('workflow_event_result', ['success', 'rejected', 'corrected'])
export const workflowSideEffectStatusEnum = pgEnum('workflow_side_effect_status', [
  'pending',
  'completed',
  'cancelled',
  'suppressed',
])
export const workflowIncidentSeverityEnum = pgEnum('workflow_incident_severity', ['critical'])
export const workflowIncidentStatusEnum = pgEnum('workflow_incident_status', ['open', 'resolved'])

/** Current workflow projection. Every mutable dimension also carries its own source-origin clock. */
export const workflowInstances = pgTable(
  'workflow_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),

    applicationState: workflowApplicationStateEnum('application_state').notNull().default('not_applied'),
    selectionState: workflowSelectionStateEnum('selection_state').notNull().default('not_reviewed'),
    campaignType: campaignTypeEnum('campaign_type').notNull(),
    visitMethod: visitMethodEnum('visit_method').notNull().default('not_applicable'),
    secretCommentState: workflowSecretCommentStateEnum('secret_comment_state').notNull().default('not_claimed'),
    paybackConsentState: workflowPaybackConsentStateEnum('payback_consent_state').notNull().default('not_applicable'),
    businessApprovalState: workflowBusinessApprovalStateEnum('business_approval_state')
      .notNull()
      .default('not_required'),
    shippingState: workflowShippingStateEnum('shipping_state').notNull().default('not_applicable'),
    reservationState: workflowReservationStateEnum('reservation_state').notNull().default('not_applicable'),
    guidelineState: workflowGuidelineStateEnum('guideline_state').notNull().default('not_ready'),
    humanHandoffState: workflowHumanHandoffStateEnum('human_handoff_state').notNull().default('not_required'),
    automationModeState: workflowAutomationModeStateEnum('automation_mode_state').notNull().default('active'),

    applicationOriginAt: tstz('application_origin_at').notNull(),
    selectionOriginAt: tstz('selection_origin_at').notNull(),
    secretCommentOriginAt: tstz('secret_comment_origin_at').notNull(),
    paybackConsentOriginAt: tstz('payback_consent_origin_at').notNull(),
    businessApprovalOriginAt: tstz('business_approval_origin_at').notNull(),
    shippingOriginAt: tstz('shipping_origin_at').notNull(),
    reservationOriginAt: tstz('reservation_origin_at').notNull(),
    guidelineOriginAt: tstz('guideline_origin_at').notNull(),
    humanHandoffOriginAt: tstz('human_handoff_origin_at').notNull(),
    automationModeOriginAt: tstz('automation_mode_origin_at').notNull(),

    version: integer('version').notNull().default(0),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('workflow_instances_application_campaign_key').on(table.applicationId, table.campaignId),
    index('workflow_instances_participant_idx').on(table.participantId, table.createdAt),
    index('workflow_instances_campaign_idx').on(table.campaignId, table.createdAt),
    check('workflow_instances_nonnegative_version', sql`${table.version} >= 0`),
    check(
      'workflow_instances_visit_method_coherent',
      sql`(${table.campaignType} = 'visit' and ${table.visitMethod} <> 'not_applicable') or (${table.campaignType} <> 'visit' and ${table.visitMethod} = 'not_applicable')`,
    ),
  ],
)

/** Immutable §14.4 ledger: accepted transitions, rejected attempts, stale events, and corrections. */
export const workflowEvents = pgTable(
  'workflow_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    expectedVersion: integer('expected_version').notNull(),
    workflowVersion: integer('workflow_version').notNull(),
    dimension: workflowDimensionEnum('dimension').notNull(),
    eventKind: workflowEventKindEnum('event_kind').notNull(),
    currentState: text('current_state').notNull(),
    requestedTargetState: text('requested_target_state').notNull(),
    triggerCode: text('trigger_code').notNull(),
    triggeringEventId: text('triggering_event_id').notNull(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    preconditions: jsonb('preconditions').notNull(),
    ruleVersion: text('rule_version'),
    decisionReason: text('decision_reason').notNull(),
    sideEffects: jsonb('side_effects').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    recordedAt: tstz('recorded_at').notNull().defaultNow(),
    correlationId: text('correlation_id').notNull(),
    result: workflowEventResultEnum('result').notNull(),
    retainedForReplay: boolean('retained_for_replay').notNull().default(false),
  },
  (table) => [
    index('workflow_events_timeline_idx').on(table.workflowId, table.recordedAt),
    index('workflow_events_trigger_idx').on(table.triggeringEventId),
    index('workflow_events_dimension_result_idx').on(table.dimension, table.result, table.recordedAt),
    check('workflow_events_nonnegative_expected_version', sql`${table.expectedVersion} >= 0`),
    check('workflow_events_nonnegative_workflow_version', sql`${table.workflowVersion} >= 0`),
    check('workflow_events_trigger_code', sql`${table.triggerCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('workflow_events_decision_reason', sql`${table.decisionReason} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('workflow_events_nonempty_correlation_id', sql`char_length(${table.correlationId}) between 1 and 200`),
  ],
)

/** Supersession is a new immutable fact; the prior immutable event is never updated. */
export const workflowEventSupersessions = pgTable(
  'workflow_event_supersessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    priorEventId: uuid('prior_event_id')
      .notNull()
      .references(() => workflowEvents.id, { onDelete: 'restrict' }),
    correctionEventId: uuid('correction_event_id')
      .notNull()
      .references(() => workflowEvents.id, { onDelete: 'restrict' }),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    correlationId: text('correlation_id').notNull(),
  },
  (table) => [
    unique('workflow_event_supersessions_prior_key').on(table.priorEventId),
    unique('workflow_event_supersessions_correction_key').on(table.correctionEventId),
    index('workflow_event_supersessions_workflow_idx').on(table.workflowId, table.occurredAt),
    check('workflow_event_supersessions_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

/** Declared effects are persisted separately so rejection can prove none were produced. */
export const workflowSideEffects = pgTable(
  'workflow_side_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    workflowEventId: uuid('workflow_event_id')
      .notNull()
      .references(() => workflowEvents.id, { onDelete: 'restrict' }),
    dimension: workflowDimensionEnum('dimension').notNull(),
    effectCode: text('effect_code').notNull(),
    status: workflowSideEffectStatusEnum('status').notNull().default('pending'),
    cancellationReason: text('cancellation_reason'),
    invalidatedByEventId: uuid('invalidated_by_event_id').references(() => workflowEvents.id, {
      onDelete: 'restrict',
    }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    completedAt: tstz('completed_at'),
    cancelledAt: tstz('cancelled_at'),
  },
  (table) => [
    unique('workflow_side_effects_event_effect_key').on(table.workflowEventId, table.effectCode),
    index('workflow_side_effects_pending_idx').on(table.status, table.createdAt),
    index('workflow_side_effects_workflow_idx').on(table.workflowId, table.createdAt),
    check('workflow_side_effects_effect_code', sql`${table.effectCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

export const workflowIncidents = pgTable(
  'workflow_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    workflowEventId: uuid('workflow_event_id')
      .notNull()
      .references(() => workflowEvents.id, { onDelete: 'restrict' }),
    severity: workflowIncidentSeverityEnum('severity').notNull().default('critical'),
    reasonCode: text('reason_code').notNull(),
    status: workflowIncidentStatusEnum('status').notNull().default('open'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    resolvedAt: tstz('resolved_at'),
  },
  (table) => [
    index('workflow_incidents_open_idx').on(table.status, table.createdAt),
    check('workflow_incidents_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

export type WorkflowInstanceRow = typeof workflowInstances.$inferSelect
export type NewWorkflowInstanceRow = typeof workflowInstances.$inferInsert
export type WorkflowEventRow = typeof workflowEvents.$inferSelect
export type NewWorkflowEventRow = typeof workflowEvents.$inferInsert
export type WorkflowEventSupersessionRow = typeof workflowEventSupersessions.$inferSelect
export type WorkflowSideEffectRow = typeof workflowSideEffects.$inferSelect
export type WorkflowIncidentRow = typeof workflowIncidents.$inferSelect
