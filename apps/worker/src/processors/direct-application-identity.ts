import {
  WORKFLOW_SIDE_EFFECT,
  WORKFLOW_GUARD,
  WORKFLOW_TRIGGER,
  executeGovernedWorkflowTransition,
  planWorkflowTransition,
} from '@helloreview/workflow-runtime'
import type {
  WorkflowSideEffectHandler,
  WorkflowSideEffectHandlerOutcome,
  WorkflowSideEffectHandlers,
} from './workflow-side-effects.js'

export const DIRECT_APPLICATION_IDENTITY_REASON = {
  CANDIDATE_RESOLUTION_PENDING: 'IDENTITY_MATCHING_CANDIDATE_RESOLUTION_PENDING',
} as const

export class DirectApplicationIdentityError extends Error {
  override readonly name = 'DirectApplicationIdentityError'

  constructor(readonly reasonCode: string) {
    super(`Direct application identity progression failed: ${reasonCode}`)
  }
}

/**
 * Advances only the authoritative website-import route.
 *
 * An initialized BEGIN_IDENTITY_MATCHING effect was created in the same transaction that bound the
 * imported application to its participant and campaign. That is sufficient to verify the
 * application identity, but it is deliberately not treated as Kakao channel evidence. The
 * application and selection transitions run back-to-back, which makes the intermediate
 * PERSIST_CHANNEL_LINK effect stale; the dispatcher then suppresses it instead of inventing a
 * channel identity. Non-initialized effects stay pending for the future candidate-resolution path.
 */
export const createDirectApplicationIdentityHandler =
  (now: () => Date = () => new Date()): WorkflowSideEffectHandler =>
  async (tx, effect): Promise<WorkflowSideEffectHandlerOutcome> => {
    if (effect.sourceEventKind !== 'initialized' || effect.sourceTriggerCode !== 'WORKFLOW_INITIALIZED') {
      return {
        status: 'blocked',
        reasonCode: DIRECT_APPLICATION_IDENTITY_REASON.CANDIDATE_RESOLUTION_PENDING,
      }
    }

    const occurredAt = now()
    const correlationId = `workflow-side-effect:${effect.id}`
    const matched = await executeGovernedWorkflowTransition(
      tx,
      {
        workflowId: effect.workflowId,
        expectedVersion: effect.currentWorkflowVersion,
        dimension: 'application',
        to: 'application_matched',
        trigger: WORKFLOW_TRIGGER.IDENTITY_VERIFIED,
        triggeringEventId: effect.id,
        actorType: 'system',
        actorId: 'direct-application-identity',
        preconditionCodes: ['AUTHORITATIVE_APPLICATION_PARTICIPANT_BOUND'],
        guardResults: { [WORKFLOW_GUARD.DETERMINISTIC_MATCH_APPROVED]: true },
        identityMatchCategory: 'verified',
        correlationId,
        occurredAt,
        automated: true,
      },
      planWorkflowTransition,
    )
    if (matched.status === 'rejected') throw new DirectApplicationIdentityError(matched.rejection.reasonCode)

    const selection = await executeGovernedWorkflowTransition(
      tx,
      {
        workflowId: effect.workflowId,
        expectedVersion: matched.outcome.workflowVersion,
        dimension: 'selection',
        to: 'review_pending',
        trigger: WORKFLOW_TRIGGER.APPLICATION_MATCHED,
        triggeringEventId: matched.outcome.eventId,
        actorType: 'system',
        actorId: 'direct-application-identity',
        preconditionCodes: ['AUTHORITATIVE_APPLICATION_PARTICIPANT_BOUND', 'CAMPAIGN_ACTIVE'],
        guardResults: { [WORKFLOW_GUARD.CAMPAIGN_ACTIVE]: true },
        identityMatchCategory: 'verified',
        correlationId,
        occurredAt,
        automated: true,
      },
      planWorkflowTransition,
    )
    if (selection.status === 'rejected') throw new DirectApplicationIdentityError(selection.rejection.reasonCode)
    return { status: 'completed' }
  }

export const createDirectApplicationSideEffectHandlers = (
  now: () => Date = () => new Date(),
): WorkflowSideEffectHandlers => ({
  [WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING]: createDirectApplicationIdentityHandler(now),
})
