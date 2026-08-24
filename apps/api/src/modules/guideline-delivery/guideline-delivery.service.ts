import { Inject, Injectable } from '@nestjs/common'
import { MESSAGE_PURPOSES, composePurpose } from '@helloreview/contracts'
import { POSTGRES_POOL, runInTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { OutboundIntentService, type EnqueuedOutboundIntent } from '../messaging/index.js'
import { RESERVATION_RULE, type ReservationValidation, type RuleEvaluationResult } from '../rules-engine/index.js'
import { evaluateGuidelineReadiness, type GuidelineGateResult } from './guideline-gate.js'
import { GuidelineDeliveryRepository } from './guideline-delivery.repository.js'
import { GUIDELINE_BLOCK } from './reason-codes.js'

export type RequestGuidelineDeliveryInput = Readonly<{
  workflowId: string
  channel: 'KAKAO'
  recipientReference: string
  templateVersion: number
  triggeringEventId: string
  actorId: string
  occurredAt: Date
  consentTermsVersion: number | null
  activeTermsVersion: number | null
  safeScreenshotReceived: boolean
  criticalFieldsExtracted: boolean
  shippingPrerequisitesSatisfied: boolean
  paybackPrerequisitesSatisfied: boolean
  reservationValidation?: ReservationValidation
}>

export type GuidelineDeliveryRequestResult = Readonly<{
  outcome: 'queued' | 'suppressed' | 'blocked'
  gate: GuidelineGateResult
  deliveryId?: string
  notification?: EnqueuedOutboundIntent
  correctionNotification?: EnqueuedOutboundIntent
}>

const rowText = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`guideline delivery query returned invalid ${column}`)
}

const invalidTimeFailure = (validation: ReservationValidation | undefined): RuleEvaluationResult | undefined =>
  validation?.failures.find((result) => result.ruleCode === RESERVATION_RULE.TIME)

@Injectable()
export class GuidelineDeliveryService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly repository: GuidelineDeliveryRepository,
    private readonly intents: OutboundIntentService,
  ) {}

  async request(input: RequestGuidelineDeliveryInput): Promise<GuidelineDeliveryRequestResult> {
    return runInTransaction(this.pool, async (tx) => {
      const context = await this.repository.readiness(tx, { ...input, now: input.occurredAt })
      if (context === undefined) throw new Error('guideline workflow was not found')
      const gate = evaluateGuidelineReadiness(context.readiness, input.occurredAt)
      if (!gate.ready) {
        const activeVersion = context.readiness.campaign.activeGuidelineVersion
        const existing =
          activeVersion === null
            ? undefined
            : (
                await tx.query(
                  `SELECT id FROM guideline_deliveries WHERE workflow_id = $1 AND guideline_version = $2`,
                  [input.workflowId, activeVersion],
                )
              ).rows[0]
        const deliveryId = existing === undefined ? undefined : rowText(existing, 'id')
        const outcome = gate.reasonCode === GUIDELINE_BLOCK.VERSION_ALREADY_DELIVERED ? 'suppressed' : 'blocked'
        await tx.query(
          `INSERT INTO guideline_delivery_attempts (
             workflow_id, delivery_id, guideline_version, triggering_event_id,
             outcome, reason_code, rule_result, occurred_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [
            input.workflowId,
            deliveryId ?? null,
            activeVersion,
            input.triggeringEventId,
            outcome,
            gate.reasonCode,
            JSON.stringify(gate),
            input.occurredAt,
          ],
        )

        const timeFailure = invalidTimeFailure(input.reservationValidation)
        let correctionNotification: EnqueuedOutboundIntent | undefined
        if (gate.reasonCode === GUIDELINE_BLOCK.RESERVATION_NOT_VALID && timeFailure?.outcome === 'fail') {
          const correctionPurpose = composePurpose(MESSAGE_PURPOSES.RESERVATION_CORRECTION, timeFailure.correction)
          correctionNotification = await this.intents.enqueueIntent(tx, {
            workflowId: input.workflowId,
            channel: input.channel,
            recipientReference: input.recipientReference,
            purpose: correctionPurpose,
            templatePurposeCode: correctionPurpose,
            templateVersion: input.templateVersion,
            contentVersion: `rule_v${String(timeFailure.ruleVersion)}`,
            variables: {},
            source: 'automated',
            actorId: input.actorId,
            occurredAt: input.occurredAt,
          })
        }
        return {
          outcome,
          gate,
          ...(deliveryId === undefined ? {} : { deliveryId }),
          ...(correctionNotification === undefined ? {} : { correctionNotification }),
        }
      }

      if (context.guidelineVersionId === null || context.guidelineBody === null) {
        throw new Error('ready guideline has no immutable content version')
      }
      const purpose = composePurpose(MESSAGE_PURPOSES.GUIDELINE_DELIVERY, String(gate.guidelineVersion))
      const notification = await this.intents.enqueueIntent(tx, {
        workflowId: input.workflowId,
        channel: input.channel,
        recipientReference: input.recipientReference,
        purpose,
        templatePurposeCode: MESSAGE_PURPOSES.GUIDELINE_DELIVERY,
        templateVersion: input.templateVersion,
        contentVersion: `guideline_v${String(gate.guidelineVersion)}`,
        variables: { guideline: context.guidelineBody },
        source: 'automated',
        actorId: input.actorId,
        occurredAt: input.occurredAt,
      })
      const inserted = await tx.query(
        `INSERT INTO guideline_deliveries (
           workflow_id, participant_id, application_id, campaign_id, guideline_version_id,
           guideline_version, channel, triggering_event_id, rule_result, status,
           outbound_notification_id, provider_result, deduplication_key,
           requested_at, updated_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'queued',$10,$11::jsonb,$12,$13,$13,$13)
         RETURNING id`,
        [
          context.workflowId,
          context.participantId,
          context.applicationId,
          context.campaignId,
          context.guidelineVersionId,
          gate.guidelineVersion,
          input.channel,
          input.triggeringEventId,
          JSON.stringify(gate),
          notification.id,
          JSON.stringify({ status: notification.status }),
          notification.deduplicationKey,
          input.occurredAt,
        ],
      )
      const deliveryId = rowText(inserted.rows[0] ?? {}, 'id')
      await tx.query(
        `INSERT INTO guideline_delivery_attempts (
           workflow_id, delivery_id, guideline_version, triggering_event_id,
           outcome, reason_code, rule_result, occurred_at
         ) VALUES ($1,$2,$3,$4,'queued',$5,$6::jsonb,$7)`,
        [
          input.workflowId,
          deliveryId,
          gate.guidelineVersion,
          input.triggeringEventId,
          gate.reasonCode,
          JSON.stringify(gate),
          input.occurredAt,
        ],
      )
      await tx.query(
        `UPDATE workflow_instances
            SET guideline_state = 'delivery_queued', guideline_origin_at = $2,
                version = version + 1, updated_at = $2
          WHERE id = $1`,
        [input.workflowId, input.occurredAt],
      )
      return { outcome: 'queued', gate, deliveryId, notification }
    })
  }
}
