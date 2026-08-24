import { WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import { applyWorkflowStateChange, type WorkflowSnapshot, type WorkflowStateChange } from './state-model.js'
import { WORKFLOW_SIDE_EFFECT, type WorkflowSideEffectCode } from './transition-table.js'

export type CorrectionPriorEvent = Readonly<{
  dimension: string
  targetState: string
  result: string
  superseded: boolean
}>

export type WorkflowCorrectionPlan =
  | Readonly<{
      approved: false
      reasonCode:
        | typeof WORKFLOW_TRANSITION_REASON.CORRECTION_EVENT_NOT_CURRENT
        | typeof WORKFLOW_TRANSITION_REASON.CORRECTION_TARGET_INVALID
      nextSnapshot: WorkflowSnapshot
      sideEffects: readonly []
      criticalIncidentRequired: false
    }>
  | Readonly<{
      approved: true
      reasonCode: typeof WORKFLOW_TRANSITION_REASON.CORRECTION_APPLIED
      nextSnapshot: WorkflowSnapshot
      sideEffects: readonly WorkflowSideEffectCode[]
      criticalIncidentRequired: boolean
    }>

export const planWorkflowCorrection = (
  snapshot: WorkflowSnapshot,
  change: WorkflowStateChange,
  prior: CorrectionPriorEvent | undefined,
): WorkflowCorrectionPlan => {
  const currentState = snapshot[change.dimension]
  const priorIsCurrent =
    prior?.dimension === change.dimension &&
    (prior.result === 'success' || prior.result === 'corrected') &&
    !prior.superseded &&
    prior.targetState === currentState
  if (!priorIsCurrent) {
    return {
      approved: false,
      reasonCode: WORKFLOW_TRANSITION_REASON.CORRECTION_EVENT_NOT_CURRENT,
      nextSnapshot: snapshot,
      sideEffects: [],
      criticalIncidentRequired: false,
    }
  }
  if (currentState === change.to) {
    return {
      approved: false,
      reasonCode: WORKFLOW_TRANSITION_REASON.CORRECTION_TARGET_INVALID,
      nextSnapshot: snapshot,
      sideEffects: [],
      criticalIncidentRequired: false,
    }
  }

  const criticalIncidentRequired =
    snapshot.guideline === 'delivered' && !(change.dimension === 'guideline' && change.to === 'delivered')
  return {
    approved: true,
    reasonCode: WORKFLOW_TRANSITION_REASON.CORRECTION_APPLIED,
    nextSnapshot: applyWorkflowStateChange(snapshot, change),
    sideEffects: [
      WORKFLOW_SIDE_EFFECT.REEVALUATE_GUIDELINE_READINESS,
      ...(criticalIncidentRequired ? [WORKFLOW_SIDE_EFFECT.CREATE_CRITICAL_INCIDENT] : []),
    ],
    criticalIncidentRequired,
  }
}
