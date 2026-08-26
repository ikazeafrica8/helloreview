import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import type { Pool } from 'pg'
import {
  BusinessApprovalService,
  type RecordBusinessApprovalInput,
  type RecordedBusinessApproval,
} from '../business-approval/index.js'
import {
  HumanReviewOperationsService,
  type HumanReviewOperationalTask,
  type HumanReviewReturnValidation,
} from '../human-tasks/index.js'
import {
  WorkflowCorrectionService,
  type ApplyWorkflowCorrectionInput,
  type WorkflowCorrectionOutcome,
} from '../workflow-core/index.js'
import { authorizeAdminInvocation, type AdminInvocation } from './admin-invocation.js'

export class AdminCommandScopeError extends Error {
  override readonly name = 'AdminCommandScopeError'
  constructor(readonly reasonCode: string) {
    super(`admin command rejected: ${reasonCode}`)
  }
}

type DistributiveOmit<T, Keys extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, Keys>> : never

const rowScope = (row: Record<string, unknown> | undefined): Readonly<{ campaignId: string; workflowId: string }> => {
  if (row === undefined) throw new AdminCommandScopeError('ADMIN_TARGET_NOT_FOUND')
  if (typeof row.campaign_id !== 'string' || typeof row.workflow_id !== 'string')
    throw new AdminCommandScopeError('ADMIN_TARGET_SCOPE_INVALID')
  return { campaignId: row.campaign_id, workflowId: row.workflow_id }
}

@Injectable()
export class AdminCommandService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly humanTasks: HumanReviewOperationsService,
    private readonly approvals: BusinessApprovalService,
    private readonly corrections: WorkflowCorrectionService,
  ) {}

  async assignHumanTask(
    invocation: AdminInvocation,
    command: Readonly<{ taskId: string; expectedWorkflowVersion: number; reasonCode: string; occurredAt: Date }>,
  ): Promise<HumanReviewOperationalTask> {
    const scope = await this.taskScope(command.taskId)
    authorizeAdminInvocation(invocation, 'human_tasks.assign', scope.campaignId)
    return this.humanTasks.assign({
      ...command,
      operatorId: invocation.principal.principalReference,
      authorized: true,
      correlationId: invocation.correlationId,
    })
  }

  async resolveAndResumeHumanTask(
    invocation: AdminInvocation,
    command: Readonly<{
      taskId: string
      expectedWorkflowVersion: number
      resolutionCode: string
      resolutionReason: string
      validation: HumanReviewReturnValidation
      occurredAt: Date
    }>,
  ): Promise<HumanReviewOperationalTask> {
    const scope = await this.taskScope(command.taskId)
    authorizeAdminInvocation(invocation, 'human_tasks.resolve', scope.campaignId)
    authorizeAdminInvocation(invocation, 'human_tasks.resume_automation', scope.campaignId)
    return this.humanTasks.resolveAndReturn({
      ...command,
      operatorId: invocation.principal.principalReference,
      authorized: true,
      correlationId: invocation.correlationId,
    })
  }

  async applyWorkflowOverride(
    invocation: AdminInvocation,
    command: DistributiveOmit<ApplyWorkflowCorrectionInput, 'actorType' | 'actorId' | 'authorized' | 'correlationId'>,
  ): Promise<WorkflowCorrectionOutcome> {
    const scope = await this.workflowScope(command.workflowId)
    authorizeAdminInvocation(invocation, 'overrides.approve', scope.campaignId)
    const input: ApplyWorkflowCorrectionInput = {
      ...command,
      actorType: 'operator',
      actorId: invocation.principal.principalReference,
      authorized: true,
      correlationId: invocation.correlationId,
    }
    return this.corrections.apply(input)
  }

  async recordBusinessApproval(
    invocation: AdminInvocation,
    command: Omit<RecordBusinessApprovalInput, 'approverReference' | 'scopeCode'> &
      Readonly<{ expectedWorkflowVersion: number; scopeCode: string }>,
  ): Promise<RecordedBusinessApproval> {
    const scope = await this.workflowScope(command.workflowId)
    if (scope.campaignId !== command.campaignId) throw new AdminCommandScopeError('ADMIN_TARGET_CAMPAIGN_MISMATCH')
    authorizeAdminInvocation(invocation, 'business_approvals.record', scope.campaignId)
    return this.approvals.record({
      ...command,
      approverReference: invocation.principal.principalReference,
      correlationId: invocation.correlationId,
    })
  }

  private async taskScope(taskId: string): Promise<Readonly<{ campaignId: string; workflowId: string }>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT campaign_id, workflow_id FROM human_review_tasks WHERE id = $1`,
      [taskId],
    )
    return rowScope(result.rows[0])
  }

  private async workflowScope(workflowId: string): Promise<Readonly<{ campaignId: string; workflowId: string }>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT campaign_id, id AS workflow_id FROM workflow_instances WHERE id = $1`,
      [workflowId],
    )
    return rowScope(result.rows[0])
  }
}
