import { ForbiddenError, StaleVersionError, UnprocessableCommandError } from '@helloreview/contracts'

export class StaleWorkflowVersionError extends StaleVersionError {
  override readonly name = 'StaleWorkflowVersionError'
}

export class StaleWorkflowEventError extends StaleVersionError {
  override readonly name = 'StaleWorkflowEventError'
}

export class WorkflowTransitionRejectedError extends UnprocessableCommandError {
  override readonly name = 'WorkflowTransitionRejectedError'
}

export class WorkflowNotFoundError extends UnprocessableCommandError {
  override readonly name = 'WorkflowNotFoundError'
}

export class WorkflowScopeConflictError extends UnprocessableCommandError {
  override readonly name = 'WorkflowScopeConflictError'
}

export class AutomationPausedError extends UnprocessableCommandError {
  override readonly name = 'AutomationPausedError'
}

export class PauseAuthorizationError extends ForbiddenError {
  override readonly name = 'PauseAuthorizationError'
}

export class EmergencyKillSwitchValidationError extends UnprocessableCommandError {
  override readonly name = 'EmergencyKillSwitchValidationError'
}

export class EmergencyResumeValidationError extends UnprocessableCommandError {
  override readonly name = 'EmergencyResumeValidationError'
}

export class WorkflowCorrectionAuthorizationError extends ForbiddenError {
  override readonly name = 'WorkflowCorrectionAuthorizationError'
}

export class WorkflowCorrectionRejectedError extends UnprocessableCommandError {
  override readonly name = 'WorkflowCorrectionRejectedError'
}
