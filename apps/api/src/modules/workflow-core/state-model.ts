// Keep the API import surface stable while the state model lives beside the shared transactional
// workflow bootstrap used by both deployables.
export {
  WORKFLOW_STATES,
  MUTABLE_WORKFLOW_DIMENSIONS,
  applyWorkflowStateChange,
  initialWorkflowSnapshot,
  isStateForDimension,
  stateForDimension,
} from '@helloreview/workflow-runtime'
export type {
  CampaignType,
  MutableWorkflowDimension,
  VisitMethod,
  WorkflowDimension,
  WorkflowSnapshot,
  WorkflowStateByDimension,
  WorkflowStateChange,
} from '@helloreview/workflow-runtime'
