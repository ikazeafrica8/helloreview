import { describe, expect, test } from 'vitest'
import {
  ILLEGAL_WORKFLOW_TRANSITIONS,
  WORKFLOW_TRIGGER,
  planWorkflowTransition,
} from '../../apps/api/dist/modules/workflow-core/index.js'

const current = new Date('2026-08-24T10:00:00.000Z')
const older = new Date('2026-08-24T09:59:59.000Z')

const base = () => ({
  application: 'application_matched',
  selection: 'auto_selected',
  campaign_type: 'visit',
  visit_method: 'visit_a',
  secret_comment: 'verified',
  payback_consent: 'agreed',
  business_approval: 'approved',
  shipping: 'address_valid',
  reservation: 'valid',
  guideline: 'not_ready',
  human_handoff: 'not_required',
  automation_mode: 'active',
})

const defaultContext = () => ({
  campaignStatus: 'active',
  guardResults: {},
  automated: false,
  redeliveryAuthorized: false,
  occurredAt: current,
  currentStateOriginAt: current,
})

const cases = [
  {
    id: 'not_applied_to_auto_selected',
    snapshot: { application: 'not_applied' },
    request: { dimension: 'selection', to: 'auto_selected', trigger: WORKFLOW_TRIGGER.AUTOMATIC_RULE_PASSED },
  },
  {
    id: 'weak_match_to_application_matched',
    snapshot: { application: 'application_completed' },
    request: { dimension: 'application', to: 'application_matched', trigger: WORKFLOW_TRIGGER.IDENTITY_VERIFIED },
    context: { identityMatchCategory: 'weak_match' },
  },
  {
    id: 'not_reviewed_to_guideline_ready',
    snapshot: { selection: 'not_reviewed' },
    request: { dimension: 'guideline', to: 'ready', trigger: WORKFLOW_TRIGGER.GUIDELINE_READINESS_PASSED },
  },
  {
    id: 'awaiting_payback_to_guideline_ready',
    snapshot: { payback_consent: 'awaiting_response' },
    request: { dimension: 'guideline', to: 'ready', trigger: WORKFLOW_TRIGGER.GUIDELINE_READINESS_PASSED },
  },
  {
    id: 'declined_payback_to_guideline_ready',
    snapshot: { payback_consent: 'declined' },
    request: { dimension: 'guideline', to: 'ready', trigger: WORKFLOW_TRIGGER.GUIDELINE_READINESS_PASSED },
  },
  {
    id: 'visit_c_pending_to_instructions',
    snapshot: { visit_method: 'visit_c', business_approval: 'pending', reservation: 'not_started' },
    request: {
      dimension: 'reservation',
      to: 'instructions_sent',
      trigger: WORKFLOW_TRIGGER.RESERVATION_INSTRUCTIONS_AUTHORIZED,
    },
  },
  {
    id: 'visit_c_invalid_approval_to_instructions',
    snapshot: { visit_method: 'visit_c', business_approval: 'revoked', reservation: 'not_started' },
    request: {
      dimension: 'reservation',
      to: 'instructions_sent',
      trigger: WORKFLOW_TRIGGER.RESERVATION_INSTRUCTIONS_AUTHORIZED,
    },
  },
  {
    id: 'screenshot_direct_to_valid',
    snapshot: { reservation: 'screenshot_received' },
    request: { dimension: 'reservation', to: 'valid', trigger: WORKFLOW_TRIGGER.RESERVATION_RULES_PASSED },
  },
  {
    id: 'correction_required_to_guideline',
    snapshot: { reservation: 'correction_required' },
    request: { dimension: 'guideline', to: 'ready', trigger: WORKFLOW_TRIGGER.GUIDELINE_READINESS_PASSED },
  },
  {
    id: 'cancelled_to_guideline',
    snapshot: { reservation: 'cancelled' },
    request: { dimension: 'guideline', to: 'ready', trigger: WORKFLOW_TRIGGER.GUIDELINE_READINESS_PASSED },
  },
  {
    id: 'duplicate_guideline_without_authorization',
    snapshot: { guideline: 'delivered' },
    request: { dimension: 'guideline', to: 'delivery_queued', trigger: WORKFLOW_TRIGGER.GUIDELINE_DELIVERY_QUEUED },
  },
  {
    id: 'human_owned_automated_reply',
    snapshot: { automation_mode: 'human_owned' },
    request: {
      dimension: 'application',
      to: 'application_requested',
      trigger: WORKFLOW_TRIGGER.INITIAL_APPLICANT_CONTACT,
    },
    context: { automated: true },
  },
  {
    id: 'closed_campaign_automatic_progression',
    snapshot: {},
    request: {
      dimension: 'application',
      to: 'application_requested',
      trigger: WORKFLOW_TRIGGER.INITIAL_APPLICANT_CONTACT,
    },
    context: { campaignStatus: 'closed', automated: true },
  },
  {
    id: 'stale_event_without_correction',
    snapshot: {},
    request: { dimension: 'guideline', to: 'ready', trigger: WORKFLOW_TRIGGER.GUIDELINE_READINESS_PASSED },
    context: { occurredAt: older },
  },
]

describe('PRD section 14.6 prohibited transitions', () => {
  test('enumerates all 14 current PRD bullets', () => {
    expect(ILLEGAL_WORKFLOW_TRANSITIONS.map((entry) => entry.id)).toEqual(cases.map((entry) => entry.id))
  })

  test.each(cases)('$id is rejected, unchanged, side-effect free, and auditable', (entry) => {
    const snapshot = { ...base(), ...entry.snapshot }
    const plan = planWorkflowTransition(snapshot, entry.request, { ...defaultContext(), ...entry.context })
    expect(plan).toMatchObject({
      approved: false,
      transitionId: entry.id,
      sideEffects: [],
      audit: { action: 'WORKFLOW_TRANSITION_REJECTED', result: 'rejected' },
    })
    expect(plan.metricKind).toBe(entry.id === 'stale_event_without_correction' ? 'stale_event' : 'illegal_transition')
    expect(plan.nextSnapshot).toBe(snapshot)
  })

  test('an unlisted transition is denied by default with dimension-queryable evidence', () => {
    const snapshot = base()
    const plan = planWorkflowTransition(
      snapshot,
      { dimension: 'shipping', to: 'locked', trigger: WORKFLOW_TRIGGER.SHIPPING_ADDRESS_SUBMITTED },
      defaultContext(),
    )
    expect(plan).toMatchObject({
      approved: false,
      transitionId: null,
      reasonCode: 'WORKFLOW_TRANSITION_NOT_ALLOWED',
      sideEffects: [],
      metricKind: 'illegal_transition',
    })
    expect(plan.nextSnapshot).toBe(snapshot)
  })
})
