export { WorkflowCoreModule } from './workflow-core.module.js'
export { WorkflowInstanceService, WORKFLOW_ORIGIN_DIMENSIONS } from './workflow-instance.service.js'
export type { CreateWorkflowInput } from './workflow-instance.service.js'
export { WorkflowTransitionService, isPauseBlockingTransition } from './workflow-transition.service.js'
export type { ApplyWorkflowTransitionInput, WorkflowTransitionOutcome } from './workflow-transition.service.js'
export {
  HUMAN_HANDOFF_PROJECTION_REASON,
  HumanHandoffProjectionError,
  HumanHandoffProjectionService,
} from './human-handoff-projection.service.js'
export type { HumanHandoffProjection } from './human-handoff-projection.service.js'
export { WorkflowCorrectionService } from './workflow-correction.service.js'
export { planWorkflowCorrection } from './correction-plan.js'
export type { CorrectionPriorEvent, WorkflowCorrectionPlan } from './correction-plan.js'
export type {
  ApplyWorkflowCorrectionInput,
  CurrentWorkflowEvent,
  WorkflowCorrectionOutcome,
} from './workflow-correction.service.js'
export {
  buildSensitiveOverrideEvidence,
  isProtectedWorkflowPromotion,
  SENSITIVE_OVERRIDE_EVIDENCE_VERSION,
} from './sensitive-override-evidence.js'
export type { BuildSensitiveOverrideEvidenceInput, SensitiveOverrideEvidence } from './sensitive-override-evidence.js'
export { AutomationPauseService, pauseAppliesToWorkflow } from './automation-pause.service.js'
export type {
  ActivatePauseInput,
  AutomationPauseKind,
  AutomationPauseRecord,
  AutomationPauseScope,
  AutomationPauseTarget,
  AutomationPauseWorkflowScope,
  DeactivatePauseInput,
  EmergencyKillSwitchStatus,
  EmergencyResumeValidation,
} from './automation-pause.service.js'
export {
  WORKFLOW_STATES,
  MUTABLE_WORKFLOW_DIMENSIONS,
  applyWorkflowStateChange,
  initialWorkflowSnapshot,
  isStateForDimension,
  stateForDimension,
} from './state-model.js'
export type {
  CampaignType,
  MutableWorkflowDimension,
  VisitMethod,
  WorkflowDimension,
  WorkflowSnapshot,
  WorkflowStateByDimension,
  WorkflowStateChange,
} from './state-model.js'
export {
  ILLEGAL_WORKFLOW_TRANSITIONS,
  LEGAL_WORKFLOW_TRANSITIONS,
  WORKFLOW_GUARD,
  WORKFLOW_SIDE_EFFECT,
  WORKFLOW_STATE_COVERAGE,
  WORKFLOW_TRIGGER,
  planWorkflowTransition,
} from './transition-table.js'
export type {
  WorkflowGuardCode,
  WorkflowGuardResults,
  WorkflowSideEffectCode,
  WorkflowTransitionContext,
  WorkflowTransitionPlan,
  WorkflowTransitionRequest,
  WorkflowTrigger,
} from './transition-table.js'
export { WORKFLOW_AUDIT_ACTION, WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
export {
  AutomationPausedError,
  EmergencyKillSwitchValidationError,
  EmergencyResumeValidationError,
  PauseAuthorizationError,
  StaleWorkflowEventError,
  StaleWorkflowVersionError,
  WorkflowCorrectionAuthorizationError,
  WorkflowCorrectionRejectedError,
  WorkflowNotFoundError,
  WorkflowScopeConflictError,
  WorkflowTransitionRejectedError,
} from './errors.js'
