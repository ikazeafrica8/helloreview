import {
  applyWorkflowStateChange,
  type MutableWorkflowDimension,
  type WorkflowSnapshot,
  type WorkflowStateByDimension,
  type WorkflowStateChange,
} from './state-model.js'
import { WORKFLOW_AUDIT_ACTION, WORKFLOW_TRANSITION_REASON } from './reason-codes.js'

export const WORKFLOW_TRIGGER = {
  INITIAL_APPLICANT_CONTACT: 'INITIAL_APPLICANT_CONTACT',
  PARTICIPANT_CLAIMS_COMPLETED: 'PARTICIPANT_CLAIMS_COMPLETED',
  WEBSITE_CONFIRMS_APPLICATION: 'WEBSITE_CONFIRMS_APPLICATION',
  IDENTITY_VERIFIED: 'IDENTITY_VERIFIED',
  IDENTITY_CONFLICT_DETECTED: 'IDENTITY_CONFLICT_DETECTED',
  APPLICATION_MATCHED: 'APPLICATION_MATCHED',
  AUTOMATIC_RULE_PASSED: 'AUTOMATIC_RULE_PASSED',
  OPERATOR_SELECTED: 'OPERATOR_SELECTED',
  SELECTION_RULE_FAILED: 'SELECTION_RULE_FAILED',
  SELECTION_DATA_UNCERTAIN: 'SELECTION_DATA_UNCERTAIN',
  PAYBACK_PARTICIPANT_SELECTED: 'PAYBACK_PARTICIPANT_SELECTED',
  PAYBACK_AGREED: 'PAYBACK_AGREED',
  PAYBACK_REFUSED: 'PAYBACK_REFUSED',
  PAYBACK_WITHDRAWN: 'PAYBACK_WITHDRAWN',
  VISIT_C_SELECTED: 'VISIT_C_SELECTED',
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_REVOKED: 'APPROVAL_REVOKED',
  SHIPPING_ADDRESS_SUBMITTED: 'SHIPPING_ADDRESS_SUBMITTED',
  SHIPPING_ADDRESS_VALIDATED: 'SHIPPING_ADDRESS_VALIDATED',
  RESERVATION_INSTRUCTIONS_AUTHORIZED: 'RESERVATION_INSTRUCTIONS_AUTHORIZED',
  RESERVATION_FILE_ACCEPTED: 'RESERVATION_FILE_ACCEPTED',
  RESERVATION_EXTRACTION_RETURNED: 'RESERVATION_EXTRACTION_RETURNED',
  RESERVATION_RULES_PASSED: 'RESERVATION_RULES_PASSED',
  RESERVATION_CORRECTABLE_FAILURE: 'RESERVATION_CORRECTABLE_FAILURE',
  RESERVATION_CANCELLED: 'RESERVATION_CANCELLED',
  RESERVATION_RESCHEDULED: 'RESERVATION_RESCHEDULED',
  GUIDELINE_READINESS_PASSED: 'GUIDELINE_READINESS_PASSED',
  GUIDELINE_DELIVERY_QUEUED: 'GUIDELINE_DELIVERY_QUEUED',
  GUIDELINE_DELIVERED: 'GUIDELINE_DELIVERED',
  HANDOFF_REQUESTED: 'HANDOFF_REQUESTED',
  HANDOFF_TASK_PERSISTED: 'HANDOFF_TASK_PERSISTED',
  HANDOFF_RETURNED: 'HANDOFF_RETURNED',
} as const

export type WorkflowTrigger = (typeof WORKFLOW_TRIGGER)[keyof typeof WORKFLOW_TRIGGER]

export const WORKFLOW_GUARD = {
  CAMPAIGN_APPLICATION_URL_EXISTS: 'CAMPAIGN_APPLICATION_URL_EXISTS',
  NO_CONFIRMED_APPLICATION: 'NO_CONFIRMED_APPLICATION',
  VALID_APPLICATION_EVENT: 'VALID_APPLICATION_EVENT',
  DETERMINISTIC_MATCH_APPROVED: 'DETERMINISTIC_MATCH_APPROVED',
  CANDIDATE_CONFLICT: 'CANDIDATE_CONFLICT',
  CAMPAIGN_ACTIVE: 'CAMPAIGN_ACTIVE',
  AUTO_SELECTION_ELIGIBLE: 'AUTO_SELECTION_ELIGIBLE',
  AUTHORIZED_SELECTION_WITH_REASON: 'AUTHORIZED_SELECTION_WITH_REASON',
  FAILURE_POLICY_CONFIGURED: 'FAILURE_POLICY_CONFIGURED',
  BLOCKING_UNCERTAINTY: 'BLOCKING_UNCERTAINTY',
  CURRENT_TERMS_ACTIVE: 'CURRENT_TERMS_ACTIVE',
  CURRENT_TERMS_AGREEMENT: 'CURRENT_TERMS_AGREEMENT',
  VALID_CURRENT_TERMS_RESPONSE: 'VALID_CURRENT_TERMS_RESPONSE',
  WITHDRAWAL_POLICY_PERMITS: 'WITHDRAWAL_POLICY_PERMITS',
  AUTHORIZED_APPROVAL_REQUEST: 'AUTHORIZED_APPROVAL_REQUEST',
  APPROVAL_SCOPE_VALID: 'APPROVAL_SCOPE_VALID',
  AUTHORIZED_APPROVAL_REVOCATION: 'AUTHORIZED_APPROVAL_REVOCATION',
  SUBMISSION_OWNERSHIP_VERIFIED: 'SUBMISSION_OWNERSHIP_VERIFIED',
  SHIPPING_FIELDS_VALID: 'SHIPPING_FIELDS_VALID',
  SELECTION_AND_VISIT_APPROVAL_COMPLETE: 'SELECTION_AND_VISIT_APPROVAL_COMPLETE',
  RESERVATION_FILE_SAFE: 'RESERVATION_FILE_SAFE',
  EXTRACTION_SCHEMA_VALID: 'EXTRACTION_SCHEMA_VALID',
  RESERVATION_RULES_VALID: 'RESERVATION_RULES_VALID',
  RESERVATION_RETRY_ALLOWED: 'RESERVATION_RETRY_ALLOWED',
  CURRENT_RESERVATION_IDENTIFIED: 'CURRENT_RESERVATION_IDENTIFIED',
  RESCHEDULE_VERSION_VALID: 'RESCHEDULE_VERSION_VALID',
  GUIDELINE_READINESS_CURRENT: 'GUIDELINE_READINESS_CURRENT',
  UNIQUE_DEDUPE_KEY_INSERTED: 'UNIQUE_DEDUPE_KEY_INSERTED',
  PROVIDER_MESSAGE_MATCHED: 'PROVIDER_MESSAGE_MATCHED',
  HANDOFF_REASON_PRESENT: 'HANDOFF_REASON_PRESENT',
  HANDOFF_CASE_PACKET_COMPLETE: 'HANDOFF_CASE_PACKET_COMPLETE',
  HANDOFF_RETURN_STATE_VALID: 'HANDOFF_RETURN_STATE_VALID',
} as const

export type WorkflowGuardCode = (typeof WORKFLOW_GUARD)[keyof typeof WORKFLOW_GUARD]
export type WorkflowGuardResults = Readonly<Partial<Record<WorkflowGuardCode, boolean>>>

export const WORKFLOW_SIDE_EFFECT = {
  QUEUE_APPLICATION_REQUEST_MESSAGE: 'QUEUE_APPLICATION_REQUEST_MESSAGE',
  RUN_APPLICATION_RECONCILIATION: 'RUN_APPLICATION_RECONCILIATION',
  BEGIN_IDENTITY_MATCHING: 'BEGIN_IDENTITY_MATCHING',
  PERSIST_CHANNEL_LINK: 'PERSIST_CHANNEL_LINK',
  CREATE_HUMAN_TASK: 'CREATE_HUMAN_TASK',
  LOAD_SELECTION_RULE: 'LOAD_SELECTION_RULE',
  ROUTE_CAMPAIGN: 'ROUTE_CAMPAIGN',
  APPLY_SELECTION_FAILURE_POLICY: 'APPLY_SELECTION_FAILURE_POLICY',
  PAUSE_SELECTION_AUTOMATION: 'PAUSE_SELECTION_AUTOMATION',
  SEND_TERMS_AND_CONSENT_REQUEST: 'SEND_TERMS_AND_CONSENT_REQUEST',
  EVALUATE_GUIDELINE_READINESS: 'EVALUATE_GUIDELINE_READINESS',
  STOP_PROGRESSION: 'STOP_PROGRESSION',
  PAUSE_AND_REVIEW: 'PAUSE_AND_REVIEW',
  SEND_APPROVAL_PENDING_MESSAGE_ONLY: 'SEND_APPROVAL_PENDING_MESSAGE_ONLY',
  QUEUE_BOOKING_INSTRUCTIONS_ONCE: 'QUEUE_BOOKING_INSTRUCTIONS_ONCE',
  STOP_AUTOMATION_AND_CREATE_REVIEW: 'STOP_AUTOMATION_AND_CREATE_REVIEW',
  VALIDATE_SHIPPING_FIELDS: 'VALIDATE_SHIPPING_FIELDS',
  SEND_RESERVATION_INSTRUCTIONS_ONCE: 'SEND_RESERVATION_INSTRUCTIONS_ONCE',
  QUEUE_OCR: 'QUEUE_OCR',
  RUN_RESERVATION_RULES: 'RUN_RESERVATION_RULES',
  SEND_RESERVATION_CORRECTION: 'SEND_RESERVATION_CORRECTION',
  REVOKE_GUIDELINE_READINESS: 'REVOKE_GUIDELINE_READINESS',
  REVALIDATE_AND_REVOKE_PRIOR_READINESS: 'REVALIDATE_AND_REVOKE_PRIOR_READINESS',
  CREATE_OUTBOX_INTENT: 'CREATE_OUTBOX_INTENT',
  SEND_MESSAGE: 'SEND_MESSAGE',
  RECORD_DELIVERY: 'RECORD_DELIVERY',
  PAUSE_AUTOMATION: 'PAUSE_AUTOMATION',
  SEND_HOLDING_MESSAGE: 'SEND_HOLDING_MESSAGE',
  RESUME_FROM_CURRENT_STATE: 'RESUME_FROM_CURRENT_STATE',
  REEVALUATE_GUIDELINE_READINESS: 'REEVALUATE_GUIDELINE_READINESS',
  CREATE_CRITICAL_INCIDENT: 'CREATE_CRITICAL_INCIDENT',
} as const

export type WorkflowSideEffectCode = (typeof WORKFLOW_SIDE_EFFECT)[keyof typeof WORKFLOW_SIDE_EFFECT]

type LegalTransitionDefinition = {
  [Dimension in MutableWorkflowDimension]: Readonly<{
    id: string
    dimension: Dimension
    from: readonly WorkflowStateByDimension[Dimension][]
    trigger: WorkflowTrigger
    to: WorkflowStateByDimension[Dimension]
    guard: WorkflowGuardCode
    sideEffects: readonly WorkflowSideEffectCode[]
  }>
}[MutableWorkflowDimension]

const transition = <Dimension extends MutableWorkflowDimension>(
  definition: Readonly<{
    id: string
    dimension: Dimension
    from: readonly WorkflowStateByDimension[Dimension][]
    trigger: WorkflowTrigger
    to: WorkflowStateByDimension[Dimension]
    guard: WorkflowGuardCode
    sideEffects: readonly WorkflowSideEffectCode[]
  }>,
) => definition

/** All 32 rows currently present in PRD §14.5, in document order. */
export const LEGAL_WORKFLOW_TRANSITIONS = [
  transition({
    id: 'application_request',
    dimension: 'application',
    from: ['not_applied'],
    trigger: WORKFLOW_TRIGGER.INITIAL_APPLICANT_CONTACT,
    to: 'application_requested',
    guard: WORKFLOW_GUARD.CAMPAIGN_APPLICATION_URL_EXISTS,
    sideEffects: [WORKFLOW_SIDE_EFFECT.QUEUE_APPLICATION_REQUEST_MESSAGE],
  }),
  transition({
    id: 'application_pending',
    dimension: 'application',
    from: ['application_requested'],
    trigger: WORKFLOW_TRIGGER.PARTICIPANT_CLAIMS_COMPLETED,
    to: 'application_pending',
    guard: WORKFLOW_GUARD.NO_CONFIRMED_APPLICATION,
    sideEffects: [WORKFLOW_SIDE_EFFECT.RUN_APPLICATION_RECONCILIATION],
  }),
  transition({
    id: 'application_completed',
    dimension: 'application',
    from: ['application_pending'],
    trigger: WORKFLOW_TRIGGER.WEBSITE_CONFIRMS_APPLICATION,
    to: 'application_completed',
    guard: WORKFLOW_GUARD.VALID_APPLICATION_EVENT,
    sideEffects: [WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING],
  }),
  transition({
    id: 'application_matched',
    dimension: 'application',
    from: ['application_completed'],
    trigger: WORKFLOW_TRIGGER.IDENTITY_VERIFIED,
    to: 'application_matched',
    guard: WORKFLOW_GUARD.DETERMINISTIC_MATCH_APPROVED,
    sideEffects: [WORKFLOW_SIDE_EFFECT.PERSIST_CHANNEL_LINK],
  }),
  transition({
    id: 'application_ambiguous',
    dimension: 'application',
    from: ['application_completed'],
    trigger: WORKFLOW_TRIGGER.IDENTITY_CONFLICT_DETECTED,
    to: 'match_ambiguous',
    guard: WORKFLOW_GUARD.CANDIDATE_CONFLICT,
    sideEffects: [WORKFLOW_SIDE_EFFECT.CREATE_HUMAN_TASK],
  }),
  transition({
    id: 'selection_review_pending',
    dimension: 'selection',
    from: ['not_reviewed'],
    trigger: WORKFLOW_TRIGGER.APPLICATION_MATCHED,
    to: 'review_pending',
    guard: WORKFLOW_GUARD.CAMPAIGN_ACTIVE,
    sideEffects: [WORKFLOW_SIDE_EFFECT.LOAD_SELECTION_RULE],
  }),
  transition({
    id: 'selection_auto_selected',
    dimension: 'selection',
    from: ['review_pending'],
    trigger: WORKFLOW_TRIGGER.AUTOMATIC_RULE_PASSED,
    to: 'auto_selected',
    guard: WORKFLOW_GUARD.AUTO_SELECTION_ELIGIBLE,
    sideEffects: [WORKFLOW_SIDE_EFFECT.ROUTE_CAMPAIGN],
  }),
  transition({
    id: 'selection_manually_selected',
    dimension: 'selection',
    from: ['review_pending'],
    trigger: WORKFLOW_TRIGGER.OPERATOR_SELECTED,
    to: 'manually_selected',
    guard: WORKFLOW_GUARD.AUTHORIZED_SELECTION_WITH_REASON,
    sideEffects: [WORKFLOW_SIDE_EFFECT.ROUTE_CAMPAIGN],
  }),
  transition({
    id: 'selection_not_selected',
    dimension: 'selection',
    from: ['review_pending'],
    trigger: WORKFLOW_TRIGGER.SELECTION_RULE_FAILED,
    to: 'not_selected',
    guard: WORKFLOW_GUARD.FAILURE_POLICY_CONFIGURED,
    sideEffects: [WORKFLOW_SIDE_EFFECT.APPLY_SELECTION_FAILURE_POLICY],
  }),
  transition({
    id: 'selection_human_review',
    dimension: 'selection',
    from: ['review_pending'],
    trigger: WORKFLOW_TRIGGER.SELECTION_DATA_UNCERTAIN,
    to: 'human_review_required',
    guard: WORKFLOW_GUARD.BLOCKING_UNCERTAINTY,
    sideEffects: [WORKFLOW_SIDE_EFFECT.PAUSE_SELECTION_AUTOMATION],
  }),
  transition({
    id: 'payback_awaiting_response',
    dimension: 'payback_consent',
    from: ['not_requested'],
    trigger: WORKFLOW_TRIGGER.PAYBACK_PARTICIPANT_SELECTED,
    to: 'awaiting_response',
    guard: WORKFLOW_GUARD.CURRENT_TERMS_ACTIVE,
    sideEffects: [WORKFLOW_SIDE_EFFECT.SEND_TERMS_AND_CONSENT_REQUEST],
  }),
  transition({
    id: 'payback_agreed',
    dimension: 'payback_consent',
    from: ['awaiting_response'],
    trigger: WORKFLOW_TRIGGER.PAYBACK_AGREED,
    to: 'agreed',
    guard: WORKFLOW_GUARD.CURRENT_TERMS_AGREEMENT,
    sideEffects: [WORKFLOW_SIDE_EFFECT.EVALUATE_GUIDELINE_READINESS],
  }),
  transition({
    id: 'payback_declined',
    dimension: 'payback_consent',
    from: ['awaiting_response'],
    trigger: WORKFLOW_TRIGGER.PAYBACK_REFUSED,
    to: 'declined',
    guard: WORKFLOW_GUARD.VALID_CURRENT_TERMS_RESPONSE,
    sideEffects: [WORKFLOW_SIDE_EFFECT.STOP_PROGRESSION],
  }),
  transition({
    id: 'payback_withdrawn',
    dimension: 'payback_consent',
    from: ['agreed'],
    trigger: WORKFLOW_TRIGGER.PAYBACK_WITHDRAWN,
    to: 'withdrawn',
    guard: WORKFLOW_GUARD.WITHDRAWAL_POLICY_PERMITS,
    sideEffects: [WORKFLOW_SIDE_EFFECT.PAUSE_AND_REVIEW],
  }),
  transition({
    id: 'approval_pending',
    dimension: 'business_approval',
    from: ['not_requested'],
    trigger: WORKFLOW_TRIGGER.VISIT_C_SELECTED,
    to: 'pending',
    guard: WORKFLOW_GUARD.AUTHORIZED_APPROVAL_REQUEST,
    sideEffects: [WORKFLOW_SIDE_EFFECT.SEND_APPROVAL_PENDING_MESSAGE_ONLY],
  }),
  transition({
    id: 'approval_approved',
    dimension: 'business_approval',
    from: ['pending'],
    trigger: WORKFLOW_TRIGGER.APPROVAL_GRANTED,
    to: 'approved',
    guard: WORKFLOW_GUARD.APPROVAL_SCOPE_VALID,
    sideEffects: [WORKFLOW_SIDE_EFFECT.QUEUE_BOOKING_INSTRUCTIONS_ONCE],
  }),
  transition({
    id: 'approval_revoked',
    dimension: 'business_approval',
    from: ['approved'],
    trigger: WORKFLOW_TRIGGER.APPROVAL_REVOKED,
    to: 'revoked',
    guard: WORKFLOW_GUARD.AUTHORIZED_APPROVAL_REVOCATION,
    sideEffects: [WORKFLOW_SIDE_EFFECT.STOP_AUTOMATION_AND_CREATE_REVIEW],
  }),
  transition({
    id: 'shipping_address_received',
    dimension: 'shipping',
    from: ['address_requested'],
    trigger: WORKFLOW_TRIGGER.SHIPPING_ADDRESS_SUBMITTED,
    to: 'address_received',
    guard: WORKFLOW_GUARD.SUBMISSION_OWNERSHIP_VERIFIED,
    sideEffects: [WORKFLOW_SIDE_EFFECT.VALIDATE_SHIPPING_FIELDS],
  }),
  transition({
    id: 'shipping_address_valid',
    dimension: 'shipping',
    from: ['address_received'],
    trigger: WORKFLOW_TRIGGER.SHIPPING_ADDRESS_VALIDATED,
    to: 'address_valid',
    guard: WORKFLOW_GUARD.SHIPPING_FIELDS_VALID,
    sideEffects: [WORKFLOW_SIDE_EFFECT.EVALUATE_GUIDELINE_READINESS],
  }),
  transition({
    id: 'reservation_instructions_sent',
    dimension: 'reservation',
    from: ['not_started'],
    trigger: WORKFLOW_TRIGGER.RESERVATION_INSTRUCTIONS_AUTHORIZED,
    to: 'instructions_sent',
    guard: WORKFLOW_GUARD.SELECTION_AND_VISIT_APPROVAL_COMPLETE,
    sideEffects: [WORKFLOW_SIDE_EFFECT.SEND_RESERVATION_INSTRUCTIONS_ONCE],
  }),
  transition({
    id: 'reservation_extraction_pending',
    dimension: 'reservation',
    from: ['screenshot_received'],
    trigger: WORKFLOW_TRIGGER.RESERVATION_FILE_ACCEPTED,
    to: 'extraction_pending',
    guard: WORKFLOW_GUARD.RESERVATION_FILE_SAFE,
    sideEffects: [WORKFLOW_SIDE_EFFECT.QUEUE_OCR],
  }),
  transition({
    id: 'reservation_validation_pending',
    dimension: 'reservation',
    from: ['extraction_pending'],
    trigger: WORKFLOW_TRIGGER.RESERVATION_EXTRACTION_RETURNED,
    to: 'validation_pending',
    guard: WORKFLOW_GUARD.EXTRACTION_SCHEMA_VALID,
    sideEffects: [WORKFLOW_SIDE_EFFECT.RUN_RESERVATION_RULES],
  }),
  transition({
    id: 'reservation_valid',
    dimension: 'reservation',
    from: ['validation_pending'],
    trigger: WORKFLOW_TRIGGER.RESERVATION_RULES_PASSED,
    to: 'valid',
    guard: WORKFLOW_GUARD.RESERVATION_RULES_VALID,
    sideEffects: [WORKFLOW_SIDE_EFFECT.EVALUATE_GUIDELINE_READINESS],
  }),
  transition({
    id: 'reservation_correction_required',
    dimension: 'reservation',
    from: ['validation_pending'],
    trigger: WORKFLOW_TRIGGER.RESERVATION_CORRECTABLE_FAILURE,
    to: 'correction_required',
    guard: WORKFLOW_GUARD.RESERVATION_RETRY_ALLOWED,
    sideEffects: [WORKFLOW_SIDE_EFFECT.SEND_RESERVATION_CORRECTION],
  }),
  transition({
    id: 'reservation_cancelled',
    dimension: 'reservation',
    from: [
      'not_started',
      'instructions_sent',
      'awaiting_participant',
      'information_received',
      'screenshot_received',
      'extraction_pending',
      'validation_pending',
      'valid',
      'correction_required',
      'rescheduled',
      'human_review_required',
    ],
    trigger: WORKFLOW_TRIGGER.RESERVATION_CANCELLED,
    to: 'cancelled',
    guard: WORKFLOW_GUARD.CURRENT_RESERVATION_IDENTIFIED,
    sideEffects: [WORKFLOW_SIDE_EFFECT.REVOKE_GUIDELINE_READINESS],
  }),
  transition({
    id: 'reservation_rescheduled',
    dimension: 'reservation',
    from: ['valid'],
    trigger: WORKFLOW_TRIGGER.RESERVATION_RESCHEDULED,
    to: 'rescheduled',
    guard: WORKFLOW_GUARD.RESCHEDULE_VERSION_VALID,
    sideEffects: [WORKFLOW_SIDE_EFFECT.REVALIDATE_AND_REVOKE_PRIOR_READINESS],
  }),
  transition({
    id: 'guideline_ready',
    dimension: 'guideline',
    from: ['not_ready'],
    trigger: WORKFLOW_TRIGGER.GUIDELINE_READINESS_PASSED,
    to: 'ready',
    guard: WORKFLOW_GUARD.GUIDELINE_READINESS_CURRENT,
    sideEffects: [WORKFLOW_SIDE_EFFECT.CREATE_OUTBOX_INTENT],
  }),
  transition({
    id: 'guideline_delivery_queued',
    dimension: 'guideline',
    from: ['ready'],
    trigger: WORKFLOW_TRIGGER.GUIDELINE_DELIVERY_QUEUED,
    to: 'delivery_queued',
    guard: WORKFLOW_GUARD.UNIQUE_DEDUPE_KEY_INSERTED,
    sideEffects: [WORKFLOW_SIDE_EFFECT.SEND_MESSAGE],
  }),
  transition({
    id: 'guideline_delivered',
    dimension: 'guideline',
    from: ['delivery_queued'],
    trigger: WORKFLOW_TRIGGER.GUIDELINE_DELIVERED,
    to: 'delivered',
    guard: WORKFLOW_GUARD.PROVIDER_MESSAGE_MATCHED,
    sideEffects: [WORKFLOW_SIDE_EFFECT.RECORD_DELIVERY],
  }),
  transition({
    id: 'handoff_requested',
    dimension: 'human_handoff',
    from: ['not_required'],
    trigger: WORKFLOW_TRIGGER.HANDOFF_REQUESTED,
    to: 'requested',
    guard: WORKFLOW_GUARD.HANDOFF_REASON_PRESENT,
    sideEffects: [WORKFLOW_SIDE_EFFECT.PAUSE_AUTOMATION],
  }),
  transition({
    id: 'handoff_queued',
    dimension: 'human_handoff',
    from: ['requested'],
    trigger: WORKFLOW_TRIGGER.HANDOFF_TASK_PERSISTED,
    to: 'queued',
    guard: WORKFLOW_GUARD.HANDOFF_CASE_PACKET_COMPLETE,
    sideEffects: [WORKFLOW_SIDE_EFFECT.SEND_HOLDING_MESSAGE],
  }),
  transition({
    id: 'handoff_returned',
    dimension: 'human_handoff',
    from: ['in_progress'],
    trigger: WORKFLOW_TRIGGER.HANDOFF_RETURNED,
    to: 'returned_to_automation',
    guard: WORKFLOW_GUARD.HANDOFF_RETURN_STATE_VALID,
    sideEffects: [WORKFLOW_SIDE_EFFECT.RESUME_FROM_CURRENT_STATE],
  }),
] as const satisfies readonly LegalTransitionDefinition[]

/**
 * Compile-time state inventory. Adding a state to any mutable dimension makes this object fail to
 * typecheck until the author classifies how that state participates in the workflow model.
 */
export const WORKFLOW_STATE_COVERAGE = {
  application: {
    not_applied: 'initial',
    application_requested: 'legal_table',
    application_pending: 'legal_table',
    application_completed: 'legal_table',
    application_matched: 'legal_table',
    match_ambiguous: 'legal_table',
    application_cancelled: 'owned_by_detailed_flow',
  },
  selection: {
    not_reviewed: 'initial',
    review_pending: 'legal_table',
    auto_selected: 'legal_table',
    manually_selected: 'legal_table',
    not_selected: 'terminal',
    human_review_required: 'legal_table',
  },
  secret_comment: {
    not_claimed: 'initial',
    claimed: 'owned_by_detailed_flow',
    screenshot_requested: 'owned_by_detailed_flow',
    screenshot_received: 'owned_by_detailed_flow',
    verified: 'owned_by_detailed_flow',
    rejected: 'owned_by_detailed_flow',
    human_review_required: 'owned_by_detailed_flow',
  },
  payback_consent: {
    not_applicable: 'initial',
    not_requested: 'initial',
    awaiting_response: 'legal_table',
    agreed: 'legal_table',
    declined: 'terminal',
    withdrawn: 'terminal',
    human_review_required: 'owned_by_detailed_flow',
  },
  business_approval: {
    not_required: 'initial',
    not_requested: 'initial',
    pending: 'legal_table',
    approved: 'legal_table',
    rejected: 'owned_by_detailed_flow',
    expired: 'owned_by_detailed_flow',
    revoked: 'legal_table',
    human_review_required: 'owned_by_detailed_flow',
  },
  shipping: {
    not_applicable: 'initial',
    address_requested: 'initial',
    address_received: 'legal_table',
    address_incomplete: 'owned_by_detailed_flow',
    address_valid: 'legal_table',
    address_change_requested: 'owned_by_detailed_flow',
    locked: 'owned_by_detailed_flow',
  },
  reservation: {
    not_applicable: 'initial',
    not_started: 'initial',
    instructions_sent: 'legal_table',
    awaiting_participant: 'owned_by_detailed_flow',
    information_received: 'owned_by_detailed_flow',
    screenshot_received: 'owned_by_detailed_flow',
    extraction_pending: 'legal_table',
    validation_pending: 'legal_table',
    valid: 'legal_table',
    correction_required: 'legal_table',
    cancelled: 'terminal',
    rescheduled: 'legal_table',
    human_review_required: 'owned_by_detailed_flow',
  },
  guideline: {
    not_ready: 'initial',
    ready: 'legal_table',
    delivery_queued: 'legal_table',
    delivered: 'terminal',
    delivery_failed: 'owned_by_detailed_flow',
    suppressed_as_duplicate: 'owned_by_detailed_flow',
    redelivery_authorized: 'owned_by_detailed_flow',
  },
  human_handoff: {
    not_required: 'initial',
    requested: 'legal_table',
    queued: 'legal_table',
    assigned: 'owned_by_detailed_flow',
    in_progress: 'owned_by_detailed_flow',
    resolved: 'owned_by_detailed_flow',
    returned_to_automation: 'legal_table',
    closed: 'terminal',
  },
  automation_mode: {
    active: 'initial',
    paused_by_rule: 'owned_by_detailed_flow',
    paused_for_human: 'owned_by_detailed_flow',
    human_owned: 'owned_by_detailed_flow',
    campaign_paused: 'owned_by_detailed_flow',
    globally_paused: 'owned_by_detailed_flow',
    closed: 'terminal',
  },
} as const satisfies {
  [Dimension in MutableWorkflowDimension]: Record<
    WorkflowStateByDimension[Dimension],
    'initial' | 'legal_table' | 'terminal' | 'owned_by_detailed_flow'
  >
}

export type WorkflowTransitionRequest = WorkflowStateChange & Readonly<{ trigger: WorkflowTrigger }>

export type WorkflowTransitionContext = Readonly<{
  campaignStatus: 'draft' | 'active' | 'paused' | 'closed'
  identityMatchCategory?: 'verified' | 'strong_match' | 'weak_match' | 'ambiguous' | 'no_match'
  guardResults: WorkflowGuardResults
  automated: boolean
  redeliveryAuthorized: boolean
  occurredAt: Date
  currentStateOriginAt: Date
  authorizedCorrection?: boolean
}>

export type WorkflowTransitionPlan =
  | Readonly<{
      approved: true
      transitionId: string
      currentState: string
      nextSnapshot: WorkflowSnapshot
      reasonCode: typeof WORKFLOW_TRANSITION_REASON.APPROVED
      sideEffects: readonly WorkflowSideEffectCode[]
      audit: Readonly<{ action: typeof WORKFLOW_AUDIT_ACTION.TRANSITIONED; result: 'success' }>
      metricKind: 'transition_success'
      retainedForReplay: false
    }>
  | Readonly<{
      approved: false
      transitionId: string | null
      currentState: string
      nextSnapshot: WorkflowSnapshot
      reasonCode: string
      failedGuard: WorkflowGuardCode | null
      sideEffects: readonly []
      audit: Readonly<{ action: typeof WORKFLOW_AUDIT_ACTION.TRANSITION_REJECTED; result: 'rejected' }>
      metricKind: 'illegal_transition' | 'guard_rejection' | 'stale_event'
      retainedForReplay: boolean
    }>

type IllegalTransitionRule = Readonly<{
  id: string
  reasonCode: string
  matches: (
    snapshot: WorkflowSnapshot,
    request: WorkflowTransitionRequest,
    context: WorkflowTransitionContext,
  ) => boolean
}>

/** The 14 prohibited bullets currently present in PRD §14.6, in document order. */
export const ILLEGAL_WORKFLOW_TRANSITIONS: readonly IllegalTransitionRule[] = [
  {
    id: 'not_applied_to_auto_selected',
    reasonCode: WORKFLOW_TRANSITION_REASON.NOT_ALLOWED,
    matches: (snapshot, request) =>
      snapshot.application === 'not_applied' && request.dimension === 'selection' && request.to === 'auto_selected',
  },
  {
    id: 'weak_match_to_application_matched',
    reasonCode: WORKFLOW_TRANSITION_REASON.WEAK_MATCH_CANNOT_BIND,
    matches: (_snapshot, request, context) =>
      context.identityMatchCategory === 'weak_match' &&
      request.dimension === 'application' &&
      request.to === 'application_matched',
  },
  {
    id: 'not_reviewed_to_guideline_ready',
    reasonCode: WORKFLOW_TRANSITION_REASON.NOT_ALLOWED,
    matches: (snapshot, request) =>
      snapshot.selection === 'not_reviewed' && request.dimension === 'guideline' && request.to === 'ready',
  },
  {
    id: 'awaiting_payback_to_guideline_ready',
    reasonCode: WORKFLOW_TRANSITION_REASON.NOT_ALLOWED,
    matches: (snapshot, request) =>
      snapshot.payback_consent === 'awaiting_response' && request.dimension === 'guideline' && request.to === 'ready',
  },
  {
    id: 'declined_payback_to_guideline_ready',
    reasonCode: WORKFLOW_TRANSITION_REASON.NOT_ALLOWED,
    matches: (snapshot, request) =>
      snapshot.payback_consent === 'declined' && request.dimension === 'guideline' && request.to === 'ready',
  },
  {
    id: 'visit_c_pending_to_instructions',
    reasonCode: WORKFLOW_TRANSITION_REASON.VISIT_C_APPROVAL_REQUIRED,
    matches: (snapshot, request) =>
      snapshot.visit_method === 'visit_c' &&
      snapshot.business_approval === 'pending' &&
      request.dimension === 'reservation' &&
      request.to === 'instructions_sent',
  },
  {
    id: 'visit_c_invalid_approval_to_instructions',
    reasonCode: WORKFLOW_TRANSITION_REASON.VISIT_C_APPROVAL_REQUIRED,
    matches: (snapshot, request) =>
      snapshot.visit_method === 'visit_c' &&
      (snapshot.business_approval === 'rejected' ||
        snapshot.business_approval === 'expired' ||
        snapshot.business_approval === 'revoked') &&
      request.dimension === 'reservation' &&
      request.to === 'instructions_sent',
  },
  {
    id: 'screenshot_direct_to_valid',
    reasonCode: WORKFLOW_TRANSITION_REASON.RESERVATION_REVALIDATION_REQUIRED,
    matches: (snapshot, request) =>
      snapshot.reservation === 'screenshot_received' && request.dimension === 'reservation' && request.to === 'valid',
  },
  {
    id: 'correction_required_to_guideline',
    reasonCode: WORKFLOW_TRANSITION_REASON.RESERVATION_REVALIDATION_REQUIRED,
    matches: (snapshot, request) =>
      snapshot.reservation === 'correction_required' && request.dimension === 'guideline' && request.to === 'ready',
  },
  {
    id: 'cancelled_to_guideline',
    reasonCode: WORKFLOW_TRANSITION_REASON.RESERVATION_REVALIDATION_REQUIRED,
    matches: (snapshot, request) =>
      snapshot.reservation === 'cancelled' && request.dimension === 'guideline' && request.to === 'ready',
  },
  {
    id: 'duplicate_guideline_without_authorization',
    reasonCode: WORKFLOW_TRANSITION_REASON.DUPLICATE_GUIDELINE_NOT_AUTHORIZED,
    matches: (snapshot, request, context) =>
      snapshot.guideline === 'delivered' &&
      request.dimension === 'guideline' &&
      request.to === 'delivery_queued' &&
      !context.redeliveryAuthorized,
  },
  {
    id: 'human_owned_automated_reply',
    reasonCode: WORKFLOW_TRANSITION_REASON.HUMAN_OWNERSHIP_ACTIVE,
    matches: (snapshot, _request, context) => snapshot.automation_mode === 'human_owned' && context.automated,
  },
  {
    id: 'closed_campaign_automatic_progression',
    reasonCode: WORKFLOW_TRANSITION_REASON.CAMPAIGN_CLOSED,
    matches: (_snapshot, _request, context) => context.campaignStatus === 'closed' && context.automated,
  },
  {
    id: 'stale_event_without_correction',
    reasonCode: WORKFLOW_TRANSITION_REASON.STALE_EVENT,
    matches: (_snapshot, _request, context) =>
      context.occurredAt.getTime() < context.currentStateOriginAt.getTime() && context.authorizedCorrection !== true,
  },
]

const rejectedPlan = (
  snapshot: WorkflowSnapshot,
  request: WorkflowTransitionRequest,
  fields: Readonly<{
    transitionId?: string
    reasonCode: string
    failedGuard?: WorkflowGuardCode
    metricKind: 'illegal_transition' | 'guard_rejection' | 'stale_event'
    retainedForReplay?: boolean
  }>,
): WorkflowTransitionPlan => ({
  approved: false,
  transitionId: fields.transitionId ?? null,
  currentState: snapshot[request.dimension],
  nextSnapshot: snapshot,
  reasonCode: fields.reasonCode,
  failedGuard: fields.failedGuard ?? null,
  sideEffects: [],
  audit: { action: WORKFLOW_AUDIT_ACTION.TRANSITION_REJECTED, result: 'rejected' },
  metricKind: fields.metricKind,
  retainedForReplay: fields.retainedForReplay ?? false,
})

export const planWorkflowTransition = (
  snapshot: WorkflowSnapshot,
  request: WorkflowTransitionRequest,
  context: WorkflowTransitionContext,
): WorkflowTransitionPlan => {
  // Freshness is evaluated before every business rule. Otherwise a delayed event that also happens
  // to violate a current-state rule would be classified as an ordinary illegal transition and lose
  // the replay/reconciliation evidence required by FR-MSG-007 and T40.
  if (context.occurredAt.getTime() < context.currentStateOriginAt.getTime() && context.authorizedCorrection !== true) {
    return rejectedPlan(snapshot, request, {
      transitionId: 'stale_event_without_correction',
      reasonCode: WORKFLOW_TRANSITION_REASON.STALE_EVENT,
      metricKind: 'stale_event',
      retainedForReplay: true,
    })
  }

  const illegalRule = ILLEGAL_WORKFLOW_TRANSITIONS.find((rule) => rule.matches(snapshot, request, context))
  if (illegalRule !== undefined) {
    const stale = illegalRule.id === 'stale_event_without_correction'
    return rejectedPlan(snapshot, request, {
      transitionId: illegalRule.id,
      reasonCode: illegalRule.reasonCode,
      metricKind: stale ? 'stale_event' : 'illegal_transition',
      retainedForReplay: stale,
    })
  }

  const currentState = snapshot[request.dimension]
  const definition = LEGAL_WORKFLOW_TRANSITIONS.find(
    (candidate) =>
      candidate.dimension === request.dimension &&
      candidate.trigger === request.trigger &&
      candidate.to === request.to &&
      candidate.from.some((state) => state === currentState),
  )
  if (definition === undefined) {
    return rejectedPlan(snapshot, request, {
      reasonCode: WORKFLOW_TRANSITION_REASON.NOT_ALLOWED,
      metricKind: 'illegal_transition',
    })
  }
  if (context.guardResults[definition.guard] !== true) {
    return rejectedPlan(snapshot, request, {
      transitionId: definition.id,
      reasonCode: WORKFLOW_TRANSITION_REASON.GUARD_FAILED,
      failedGuard: definition.guard,
      metricKind: 'guard_rejection',
    })
  }

  return {
    approved: true,
    transitionId: definition.id,
    currentState,
    nextSnapshot: applyWorkflowStateChange(snapshot, request),
    reasonCode: WORKFLOW_TRANSITION_REASON.APPROVED,
    sideEffects: definition.sideEffects,
    audit: { action: WORKFLOW_AUDIT_ACTION.TRANSITIONED, result: 'success' },
    metricKind: 'transition_success',
    retainedForReplay: false,
  }
}
