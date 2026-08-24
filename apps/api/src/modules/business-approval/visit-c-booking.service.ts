import { Injectable } from '@nestjs/common'
import { MESSAGE_PURPOSES } from '@helloreview/contracts'
import type { DbTransaction } from '@helloreview/db'
import { OutboundIntentService, type EnqueuedOutboundIntent } from '../messaging/index.js'
import { BusinessApprovalRepository } from './business-approval.repository.js'
import { evaluateVisitCApprovalGate, type VisitCApprovalGateResult } from './visit-c-approval-gate.js'

export type RequestVisitCBookingInput = Readonly<{
  workflowId: string
  channel: 'KAKAO'
  recipientReference: string
  templateVersion: number
  triggeringEventId: string
  actorId: string
  occurredAt: Date
}>

export type RequestVisitCBookingResult = Readonly<{
  gate: VisitCApprovalGateResult
  notification?: EnqueuedOutboundIntent
  notificationPurpose?:
    typeof MESSAGE_PURPOSES.VISIT_C_APPROVAL_STATUS | typeof MESSAGE_PURPOSES.VISIT_C_BOOKING_INSTRUCTIONS
}>

@Injectable()
export class VisitCBookingService {
  constructor(
    private readonly approvals: BusinessApprovalRepository,
    private readonly intents: OutboundIntentService,
  ) {}

  /** The only Visit C booking-instruction enqueue path; the approval gate runs inside the same transaction. */
  async request(tx: DbTransaction, input: RequestVisitCBookingInput): Promise<RequestVisitCBookingResult> {
    const workflowResult = await tx.query(
      `SELECT campaign_id, application_id, visit_method
         FROM workflow_instances WHERE id = $1 FOR UPDATE`,
      [input.workflowId],
    )
    const workflow = workflowResult.rows[0]
    if (workflow === undefined) throw new Error('Visit C booking workflow was not found')
    if (workflow.visit_method !== 'visit_c') throw new Error('Visit C booking service requires visit_method=visit_c')
    if (typeof workflow.campaign_id !== 'string' || typeof workflow.application_id !== 'string') {
      throw new Error('Visit C booking workflow scope was invalid')
    }

    const approval = await this.approvals.current(tx, input.workflowId)
    const gate = evaluateVisitCApprovalGate(
      this.approvals.gateSnapshot(approval, {
        campaignId: workflow.campaign_id,
        applicationId: workflow.application_id,
      }),
      input.occurredAt,
    )
    if (!gate.allowed && gate.participantAction === 'no_automated_message') return { gate }

    const purpose = gate.allowed
      ? MESSAGE_PURPOSES.VISIT_C_BOOKING_INSTRUCTIONS
      : MESSAGE_PURPOSES.VISIT_C_APPROVAL_STATUS
    const version = approval?.version ?? 0
    const notification = await this.intents.enqueueIntent(tx, {
      workflowId: input.workflowId,
      channel: input.channel,
      recipientReference: input.recipientReference,
      purpose,
      templatePurposeCode: purpose,
      templateVersion: input.templateVersion,
      contentVersion: `approval_v${String(version)}`,
      businessEventVersion: input.triggeringEventId,
      variables: {},
      source: 'automated',
      actorId: input.actorId,
      occurredAt: input.occurredAt,
    })
    return { gate, notification, notificationPurpose: purpose }
  }
}
