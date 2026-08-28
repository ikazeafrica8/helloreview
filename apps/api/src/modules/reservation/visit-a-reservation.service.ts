import { Inject, Injectable } from '@nestjs/common'
import { MESSAGE_PURPOSES, composePurpose } from '@helloreview/contracts'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { KoreanDateTimePipeline, type KoreanDateTimeDecision } from '../ai-orchestration/index.js'
import { normalizeBusinessName } from '../campaign-config/index.js'
import { OutboundIntentService, type EnqueuedOutboundIntent } from '../messaging/index.js'
import {
  RESERVATION_CORRECTION,
  evaluateReservationRules,
  parseReservationRuleConfiguration,
  type ReservationEvidence,
  type ReservationValidation,
} from '../rules-engine/index.js'
import { reservationCorrectionVariables, type ReservationCorrectionVariables } from './correction-values.js'
import {
  ReservationService,
  ReservationServiceError,
  type RecordedReservationVersion,
  type ReservationVersionSnapshot,
} from './reservation.service.js'

export type VisitAReservationIntakeInput = Readonly<{
  workflowId: string
  participantId: string
  sourceEventId: string
  text: string
  messageTimestamp: Date | null
  businessName: string
  businessBranch: string | null
  recipientReference: string
  correctionTemplateVersion: number
  participantReference: string
  automationActorId: string
  capacityAvailable?: boolean
  occurredAt: Date
}>

export type VisitAReservationIntakeResult = Readonly<{
  route: 'clarification' | 'human_review' | 'correction_required' | 'ready'
  extraction: KoreanDateTimeDecision
  recorded: RecordedReservationVersion
  validation?: ReservationValidation
  notification?: EnqueuedOutboundIntent
}>

export type VisitAReservationLifecycleInput = Readonly<{
  workflowId: string
  participantId: string
  sourceEventId: string
  recipientReference: string
  templateVersion: number
  participantReference: string
  automationActorId: string
  occurredAt: Date
}>

export type CancelVisitAReservationInput = VisitAReservationLifecycleInput & Readonly<{ reasonCode: string }>

type WorkflowContext = Readonly<{
  campaignId: string
  campaignStatus: ReservationEvidence['campaignStatus']
  ruleVersion: number
  ruleConfiguration: unknown
}>

const rowText = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`Visit A reservation query returned invalid ${column}`)
}

const rowInteger = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw new Error(`Visit A reservation query returned invalid ${column}`)
}

const campaignStatus = (value: unknown): ReservationEvidence['campaignStatus'] => {
  if (value === 'draft' || value === 'active' || value === 'paused' || value === 'closed') return value
  throw new Error('Visit A reservation query returned invalid campaign status')
}

const candidateFrom = (decision: KoreanDateTimeDecision) => decision.evidence.candidates[0]

const extractionProvenance = (decision: KoreanDateTimeDecision): Readonly<Record<string, unknown>> => ({
  source: decision.source,
  reasonCode: decision.reasonCode,
  referenceTimestamp: decision.referenceTimestamp,
  provenance: decision.provenance,
  preprocessing: {
    inputHash: decision.preprocessing.inputHash,
    normalizedLength: decision.preprocessing.normalizedText.length,
    injectionSignals: decision.preprocessing.injectionSignals,
  },
  evidence: decision.evidence,
})

@Injectable()
export class VisitAReservationService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly dateTimes: KoreanDateTimePipeline,
    private readonly reservations: ReservationService,
    private readonly intents: OutboundIntentService,
  ) {}

  async intake(input: VisitAReservationIntakeInput): Promise<VisitAReservationIntakeResult> {
    if (input.sourceEventId.trim() === '') throw new ReservationServiceError('RESERVATION_SOURCE_REQUIRED')
    await this.assertEligibleWorkflow(input)
    const extraction = await this.dateTimes.extract({
      requestId: input.sourceEventId,
      budgetScope: input.workflowId,
      text: input.text,
      messageTimestamp: input.messageTimestamp,
      campaignTimezone: 'Asia/Seoul',
      schemaVersion: '1.0.0',
      promptVersion: '1.0.0',
      inputVersion: '1.0.0',
    })

    return runInTransaction(this.pool, async (tx) => {
      const context = await this.context(tx, input)
      const candidate = candidateFrom(extraction)
      if (extraction.route !== 'deterministic_validation' || candidate === undefined) {
        const humanReview = extraction.route === 'human_review'
        const recorded = await this.reservations.recordVersionInTransaction(tx, {
          workflowId: input.workflowId,
          participantId: input.participantId,
          source: 'participant',
          sourceReference: input.sourceEventId,
          extractionProvenance: extractionProvenance(extraction),
          reservedDate: candidate?.normalizedDate ?? null,
          reservedTime:
            candidate?.normalizedTime === null || candidate === undefined ? null : `${candidate.normalizedTime}:00`,
          timezone: 'Asia/Seoul',
          businessReference: input.businessName,
          visitMethod: 'visit_a',
          status: 'pending',
          cancellationReason: null,
          validationState: humanReview ? 'human_review' : 'pending',
          validationAuthority: 'none',
          ruleVersion: null,
          validationEvidence: { route: extraction.route, ambiguities: extraction.evidence.ambiguities },
          actorType: 'participant',
          actorReference: input.participantReference,
          authorized: true,
          occurredAt: input.occurredAt,
        })
        if (humanReview) {
          await this.createReview(tx, input, extraction.reasonCode, extraction.evidence.ambiguities)
          return { route: 'human_review', extraction, recorded }
        }
        // Extraction never reached deterministic validation, so there is no failed rule and no
        // normalized evidence. The clarification asks for the date and time again; it deliberately
        // does not echo the participant's own message back at them.
        const notification = await this.correction(
          tx,
          input,
          RESERVATION_CORRECTION.DATE_TIME_CLARIFICATION,
          `extraction_${input.sourceEventId}`,
          reservationCorrectionVariables({ failure: null, evidence: null, configuration: undefined }),
        )
        return { route: 'clarification', extraction, recorded, notification }
      }

      const configuration = parseReservationRuleConfiguration(context.ruleConfiguration)
      const evidence: ReservationEvidence = {
        campaignId: context.campaignId,
        normalizedBusinessName: normalizeBusinessName(input.businessName),
        normalizedBranchName: normalizeBusinessName(input.businessBranch ?? ''),
        localDate: candidate.normalizedDate ?? '',
        localTime: candidate.normalizedTime === null ? '' : `${candidate.normalizedTime}:00`,
        timezone: candidate.timezone,
        bookingMethod: 'visit_a',
        businessApprovalState: 'not_required',
        reservationStatus: 'completed',
        campaignStatus: context.campaignStatus,
        ...(input.capacityAvailable === undefined ? {} : { capacityAvailable: input.capacityAvailable }),
      }
      const validation = evaluateReservationRules(
        evidence,
        { version: context.ruleVersion, ...(configuration === undefined ? {} : { configuration }) },
        input.occurredAt,
      )
      const valid = validation.outcome === 'pass'
      const configurationReview = validation.outcome === 'configuration_error'
      const recorded = await this.reservations.recordVersionInTransaction(tx, {
        workflowId: input.workflowId,
        participantId: input.participantId,
        source: extraction.source === 'ai_provider' ? 'ai_assisted' : 'participant',
        sourceReference: input.sourceEventId,
        extractionProvenance: extractionProvenance(extraction),
        reservedDate: evidence.localDate,
        reservedTime: evidence.localTime,
        timezone: evidence.timezone,
        businessReference: input.businessName,
        visitMethod: 'visit_a',
        status: 'confirmed',
        cancellationReason: null,
        validationState: valid ? 'valid' : configurationReview ? 'human_review' : 'invalid',
        validationAuthority: 'deterministic_rules',
        ruleVersion: String(context.ruleVersion),
        validationEvidence: { evidence, validation },
        actorType: 'participant',
        actorReference: input.participantReference,
        authorized: true,
        occurredAt: input.occurredAt,
      })
      if (valid) return { route: 'ready', extraction, recorded, validation }
      if (configurationReview) {
        await this.createReview(
          tx,
          input,
          'RESERVATION_RULE_CONFIGURATION_INVALID',
          validation.failures.map((failure) => failure.ruleCode),
        )
        return { route: 'human_review', extraction, recorded, validation }
      }

      const firstFailure = validation.failures[0]
      if (firstFailure === undefined || firstFailure.outcome === 'pass')
        throw new Error('failed reservation validation has no failure evidence')
      const notification = await this.correction(
        tx,
        input,
        firstFailure.correction,
        `rule_v${String(firstFailure.ruleVersion)}:${input.sourceEventId}`,
        reservationCorrectionVariables({ failure: firstFailure, evidence, configuration }),
      )
      return { route: 'correction_required', extraction, recorded, validation, notification }
    })
  }

  async cancel(input: CancelVisitAReservationInput): Promise<RecordedReservationVersion> {
    if (!/^[A-Z][A-Z0-9_]*$/.test(input.reasonCode))
      throw new ReservationServiceError('RESERVATION_CANCELLATION_REASON_INVALID')
    return this.lifecycle(input, 'cancelled', input.reasonCode, MESSAGE_PURPOSES.RESERVATION_CANCELLATION_ACK)
  }

  async reschedule(input: VisitAReservationLifecycleInput): Promise<RecordedReservationVersion> {
    return this.lifecycle(input, 'rescheduled', null, MESSAGE_PURPOSES.RESERVATION_RESCHEDULE_ACK)
  }

  private async lifecycle(
    input: VisitAReservationLifecycleInput,
    status: 'cancelled' | 'rescheduled',
    cancellationReason: string | null,
    purpose: typeof MESSAGE_PURPOSES.RESERVATION_CANCELLATION_ACK | typeof MESSAGE_PURPOSES.RESERVATION_RESCHEDULE_ACK,
  ): Promise<RecordedReservationVersion> {
    return runInTransaction(this.pool, async (tx) => {
      const current = await this.reservations.currentInTransaction(tx, input.workflowId, input.participantId)
      if (current === null) throw new ReservationServiceError('RESERVATION_CURRENT_REQUIRED')
      const recorded = await this.reservations.recordVersionInTransaction(tx, {
        workflowId: input.workflowId,
        participantId: input.participantId,
        source: 'participant',
        sourceReference: input.sourceEventId,
        extractionProvenance: { lifecycle: status, priorVersionId: current.versionId },
        reservedDate: current.reservedDate,
        reservedTime: current.reservedTime,
        timezone: current.timezone,
        businessReference: current.businessReference,
        visitMethod: current.visitMethod,
        status,
        cancellationReason,
        validationState: status === 'cancelled' ? 'invalid' : 'pending',
        validationAuthority: 'none',
        ruleVersion: null,
        validationEvidence: { lifecycle: status, priorValidationState: current.validationState },
        actorType: 'participant',
        actorReference: input.participantReference,
        authorized: true,
        occurredAt: input.occurredAt,
      })
      await this.intents.enqueueIntent(tx, {
        workflowId: input.workflowId,
        channel: 'KAKAO',
        recipientReference: input.recipientReference,
        purpose,
        templatePurposeCode: purpose,
        templateVersion: input.templateVersion,
        contentVersion: status,
        businessEventVersion: input.sourceEventId,
        variables: {},
        source: 'automated',
        actorId: input.automationActorId,
        occurredAt: input.occurredAt,
      })
      if (!recorded.deduplicated) await this.auditLifecycle(tx, input, recorded.reservation, status)
      return recorded
    })
  }

  private async context(tx: DbTransaction, input: VisitAReservationIntakeInput): Promise<WorkflowContext> {
    const result = await tx.query(
      `SELECT w.campaign_id, c.status AS campaign_status, r.version AS rule_version, r.configuration
         FROM workflow_instances w
         JOIN campaigns c ON c.id = w.campaign_id
         LEFT JOIN LATERAL (
           SELECT version, configuration FROM campaign_rules
            WHERE campaign_id = w.campaign_id AND rule_type = 'reservation'
              AND status IN ('published','superseded')
              AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)
            ORDER BY effective_from DESC, version DESC LIMIT 1
         ) r ON true
        WHERE w.id = $1 AND w.participant_id = $2 AND w.campaign_type = 'visit' AND w.visit_method = 'visit_a'
          AND w.selection_state = 'manually_selected'
        FOR UPDATE OF w`,
      [input.workflowId, input.participantId, input.occurredAt],
    )
    const row = result.rows[0]
    if (row === undefined) throw new ReservationServiceError('VISIT_A_WORKFLOW_REQUIRED')
    if (row.rule_version === null || row.rule_version === undefined)
      throw new ReservationServiceError('RESERVATION_RULE_VERSION_REQUIRED')
    return {
      campaignId: rowText(row, 'campaign_id'),
      campaignStatus: campaignStatus(row.campaign_status),
      ruleVersion: rowInteger(row, 'rule_version'),
      ruleConfiguration: row.configuration,
    }
  }

  private async assertEligibleWorkflow(input: VisitAReservationIntakeInput): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM workflow_instances
        WHERE id = $1 AND participant_id = $2 AND campaign_type = 'visit'
          AND visit_method = 'visit_a' AND selection_state = 'manually_selected'`,
      [input.workflowId, input.participantId],
    )
    if (result.rows[0] === undefined) throw new ReservationServiceError('VISIT_A_MANUAL_SELECTION_REQUIRED')
  }

  /**
   * A correction names the failed rule AND what to change.
   *
   * `variables` carries the participant-safe Korean submitted and expected values built by
   * `reservationCorrectionVariables`. The rule evaluation's own `submittedValue` and
   * `expectedCondition` are engineering evidence - campaign identifiers, state codes, English
   * condition text - and are never passed through to a participant message.
   */
  private async correction(
    tx: DbTransaction,
    input: VisitAReservationIntakeInput,
    correctionCode: string,
    contentVersion: string,
    variables: ReservationCorrectionVariables,
  ): Promise<EnqueuedOutboundIntent> {
    const purpose = composePurpose(MESSAGE_PURPOSES.RESERVATION_CORRECTION, correctionCode)
    return this.intents.enqueueIntent(tx, {
      workflowId: input.workflowId,
      channel: 'KAKAO',
      recipientReference: input.recipientReference,
      purpose,
      templatePurposeCode: purpose,
      templateVersion: input.correctionTemplateVersion,
      contentVersion,
      businessEventVersion: input.sourceEventId,
      variables: { ...variables },
      source: 'automated',
      actorId: input.automationActorId,
      occurredAt: input.occurredAt,
    })
  }

  private async createReview(
    tx: DbTransaction,
    input: VisitAReservationIntakeInput,
    summaryCode: string,
    evidenceCodes: readonly string[],
  ): Promise<void> {
    await tx.query(
      `UPDATE workflow_instances
          SET human_handoff_state = CASE WHEN human_handoff_state IN ('not_required','requested') THEN 'queued' ELSE human_handoff_state END,
              human_handoff_origin_at = CASE WHEN human_handoff_state IN ('not_required','requested') THEN $2 ELSE human_handoff_origin_at END,
              automation_mode_state = CASE WHEN automation_mode_state = 'active' THEN 'paused_for_human' ELSE automation_mode_state END,
              automation_mode_origin_at = CASE WHEN automation_mode_state = 'active' THEN $2 ELSE automation_mode_origin_at END,
              version = version + 1, updated_at = $2 WHERE id = $1`,
      [input.workflowId, input.occurredAt],
    )
    await tx.query(
      `INSERT INTO human_review_tasks (
         workflow_reference, reason_code, priority, status, case_packet,
         automation_paused, deduplication_key, created_at, updated_at
       ) VALUES ($1,'RESERVATION_EXTRACTION_REVIEW','normal','open',$2::jsonb,true,$3,$4,$4)
       ON CONFLICT (deduplication_key) DO NOTHING`,
      [
        input.workflowId,
        JSON.stringify({
          stateCode: 'human_review_required',
          summaryCode,
          evidenceCodes,
          allowedActionCodes: ['REVIEW_RESERVATION_EVIDENCE', 'REQUEST_PARTICIPANT_CLARIFICATION'],
          recommendationCode: 'REVIEW_RESERVATION_EVIDENCE',
        }),
        `visit-a-extraction:${input.workflowId}:${input.sourceEventId}`,
        input.occurredAt,
      ],
    )
  }

  private async auditLifecycle(
    tx: DbTransaction,
    input: VisitAReservationLifecycleInput,
    reservation: ReservationVersionSnapshot,
    status: 'cancelled' | 'rescheduled',
  ): Promise<void> {
    await tx.query(
      `INSERT INTO audit_logs (
         actor_type, actor_id, action, target_type, target_id, result,
         reason, protected_action, detail, occurred_at
       ) VALUES ('participant',$1,'CORRECTION_APPLIED','reservation',$2,'success',$3,'yes',$4::jsonb,$5)`,
      [
        input.participantReference,
        reservation.reservationId,
        status === 'cancelled' ? 'RESERVATION_CANCELLED' : 'RESERVATION_RESCHEDULE_REQUESTED',
        JSON.stringify({ source_event_id: input.sourceEventId, reservation_version: reservation.version }),
        input.occurredAt,
      ],
    )
  }
}
