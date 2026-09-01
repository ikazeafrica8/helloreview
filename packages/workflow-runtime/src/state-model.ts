export const WORKFLOW_STATES = {
  application: [
    'not_applied',
    'application_requested',
    'application_pending',
    'application_completed',
    'application_matched',
    'match_ambiguous',
    'application_cancelled',
  ],
  selection: [
    'not_reviewed',
    'review_pending',
    'auto_selected',
    'manually_selected',
    'not_selected',
    'human_review_required',
  ],
  campaign_type: ['shipping', 'payback', 'visit'],
  visit_method: ['not_applicable', 'visit_a', 'visit_b', 'visit_c'],
  secret_comment: [
    'not_claimed',
    'claimed',
    'screenshot_requested',
    'screenshot_received',
    'verified',
    'rejected',
    'human_review_required',
  ],
  payback_consent: [
    'not_applicable',
    'not_requested',
    'awaiting_response',
    'agreed',
    'declined',
    'withdrawn',
    'human_review_required',
  ],
  business_approval: [
    'not_required',
    'not_requested',
    'pending',
    'approved',
    'rejected',
    'expired',
    'revoked',
    'human_review_required',
  ],
  shipping: [
    'not_applicable',
    'address_requested',
    'address_received',
    'address_incomplete',
    'address_valid',
    'address_change_requested',
    'locked',
  ],
  reservation: [
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
  ],
  guideline: [
    'not_ready',
    'ready',
    'delivery_queued',
    'delivered',
    'delivery_failed',
    'suppressed_as_duplicate',
    'redelivery_authorized',
  ],
  human_handoff: [
    'not_required',
    'requested',
    'queued',
    'assigned',
    'in_progress',
    'resolved',
    'returned_to_automation',
    'closed',
  ],
  automation_mode: [
    'active',
    'paused_by_rule',
    'paused_for_human',
    'human_owned',
    'campaign_paused',
    'globally_paused',
    'closed',
  ],
} as const

export type WorkflowDimension = keyof typeof WORKFLOW_STATES
export type WorkflowStateByDimension = {
  [Dimension in WorkflowDimension]: (typeof WORKFLOW_STATES)[Dimension][number]
}

export const MUTABLE_WORKFLOW_DIMENSIONS = [
  'application',
  'selection',
  'secret_comment',
  'payback_consent',
  'business_approval',
  'shipping',
  'reservation',
  'guideline',
  'human_handoff',
  'automation_mode',
] as const

export type MutableWorkflowDimension = (typeof MUTABLE_WORKFLOW_DIMENSIONS)[number]
export type CampaignType = WorkflowStateByDimension['campaign_type']
export type VisitMethod = WorkflowStateByDimension['visit_method']

export type WorkflowSnapshot = Readonly<{
  application: WorkflowStateByDimension['application']
  selection: WorkflowStateByDimension['selection']
  campaign_type: CampaignType
  visit_method: VisitMethod
  secret_comment: WorkflowStateByDimension['secret_comment']
  payback_consent: WorkflowStateByDimension['payback_consent']
  business_approval: WorkflowStateByDimension['business_approval']
  shipping: WorkflowStateByDimension['shipping']
  reservation: WorkflowStateByDimension['reservation']
  guideline: WorkflowStateByDimension['guideline']
  human_handoff: WorkflowStateByDimension['human_handoff']
  automation_mode: WorkflowStateByDimension['automation_mode']
}>

export type WorkflowStateChange = {
  [Dimension in MutableWorkflowDimension]: Readonly<{
    dimension: Dimension
    to: WorkflowStateByDimension[Dimension]
  }>
}[MutableWorkflowDimension]

export const initialWorkflowSnapshot = (
  input: Readonly<{ campaignType: CampaignType; visitMethod: VisitMethod }>,
): WorkflowSnapshot => {
  if (input.campaignType === 'visit' && input.visitMethod === 'not_applicable') {
    throw new Error('visit workflows require an explicit visit method')
  }
  if (input.campaignType !== 'visit' && input.visitMethod !== 'not_applicable') {
    throw new Error('non-visit workflows require visit_method=not_applicable')
  }

  return {
    application: 'not_applied',
    selection: 'not_reviewed',
    campaign_type: input.campaignType,
    visit_method: input.visitMethod,
    secret_comment: 'not_claimed',
    payback_consent: input.campaignType === 'payback' ? 'not_requested' : 'not_applicable',
    business_approval: input.visitMethod === 'visit_c' ? 'not_requested' : 'not_required',
    shipping: input.campaignType === 'shipping' ? 'address_requested' : 'not_applicable',
    reservation: input.campaignType === 'visit' ? 'not_started' : 'not_applicable',
    guideline: 'not_ready',
    human_handoff: 'not_required',
    automation_mode: 'active',
  }
}

export const stateForDimension = <Dimension extends WorkflowDimension>(
  snapshot: WorkflowSnapshot,
  dimension: Dimension,
): WorkflowStateByDimension[Dimension] => snapshot[dimension]

export const isStateForDimension = <Dimension extends WorkflowDimension>(
  dimension: Dimension,
  value: string,
): value is WorkflowStateByDimension[Dimension] => {
  const states: readonly string[] = WORKFLOW_STATES[dimension]
  return states.includes(value)
}

export const applyWorkflowStateChange = (snapshot: WorkflowSnapshot, change: WorkflowStateChange): WorkflowSnapshot => {
  switch (change.dimension) {
    case 'application':
      return { ...snapshot, application: change.to }
    case 'selection':
      return { ...snapshot, selection: change.to }
    case 'secret_comment':
      return { ...snapshot, secret_comment: change.to }
    case 'payback_consent':
      return { ...snapshot, payback_consent: change.to }
    case 'business_approval':
      return { ...snapshot, business_approval: change.to }
    case 'shipping':
      return { ...snapshot, shipping: change.to }
    case 'reservation':
      return { ...snapshot, reservation: change.to }
    case 'guideline':
      return { ...snapshot, guideline: change.to }
    case 'human_handoff':
      return { ...snapshot, human_handoff: change.to }
    case 'automation_mode':
      return { ...snapshot, automation_mode: change.to }
  }
}
