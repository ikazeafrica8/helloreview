import { Inject, Injectable } from '@nestjs/common'
import { MESSAGE_PURPOSES } from '@helloreview/contracts'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { OutboundIntentService, type EnqueuedOutboundIntent } from '../messaging/index.js'
import {
  classifyPaybackConsentResponse,
  type PaybackConsentResponseClassification,
} from './payback-consent-classifier.js'

export type PaybackConsentState =
  'not_requested' | 'awaiting_response' | 'agreed' | 'declined' | 'withdrawn' | 'human_review_required'

export type PaybackConsentSnapshot = Readonly<{
  aggregateId: string
  versionId: string
  version: number
  state: PaybackConsentState
  termsVersion: number | null
  requestId: string | null
  evidenceMessageId: string | null
  channel: string | null
  classification: string | null
  actorType: 'system' | 'operator' | 'participant'
  actorReference: string
  reasonCode: string
  occurredAt: Date
}>

export type RequestPaybackConsentInput = Readonly<{
  workflowId: string
  participantId: string
  requestId: string
  channel: 'KAKAO'
  recipientReference: string
  templateVersion: number
  actorId: string
  occurredAt: Date
}>

export type RequestedPaybackConsent = Readonly<{
  consent: PaybackConsentSnapshot
  notification: EnqueuedOutboundIntent
  deduplicated: boolean
}>

export type PaybackConsentResponseOutcome =
  | 'agreed'
  | 'declined'
  | 'clarification_sent'
  | 'human_review_required'
  | 'current_request_required'
  | 'ignored_no_active_request'

export type RecordPaybackConsentResponseInput = Readonly<{
  workflowId: string
  participantId: string
  requestId: string
  termsVersion: number
  responseText: string
  evidenceMessageId: string
  channel: 'KAKAO'
  recipientReference: string
  clarificationTemplateVersion: number
  participantReference: string
  automationActorId: string
  occurredAt: Date
}>

export type RecordedPaybackConsentResponse = Readonly<{
  responseEventId: string
  outcome: PaybackConsentResponseOutcome
  classification: PaybackConsentResponseClassification
  consent: PaybackConsentSnapshot
  notification?: EnqueuedOutboundIntent
  deduplicated: boolean
}>

export class PaybackConsentError extends Error {
  override readonly name = 'PaybackConsentError'
  constructor(readonly reasonCode: string) {
    super(`payback consent action rejected: ${reasonCode}`)
  }
}

const CONSENT_STATES: readonly PaybackConsentState[] = [
  'not_requested',
  'awaiting_response',
  'agreed',
  'declined',
  'withdrawn',
  'human_review_required',
]

const RESPONSE_OUTCOMES: readonly PaybackConsentResponseOutcome[] = [
  'agreed',
  'declined',
  'clarification_sent',
  'human_review_required',
  'current_request_required',
  'ignored_no_active_request',
]

const rowText = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`payback consent query returned invalid ${column}`)
}

const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const rowInteger = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw new Error(`payback consent query returned invalid ${column}`)
}

const nullableInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

const responseOutcome = (value: unknown): PaybackConsentResponseOutcome => {
  const outcome = RESPONSE_OUTCOMES.find((candidate) => candidate === value)
  if (outcome === undefined) throw new Error('payback consent response query returned invalid outcome')
  return outcome
}

const responseClassification = (value: unknown): PaybackConsentResponseClassification => {
  if (value === 'explicit_agreement' || value === 'explicit_decline' || value === 'ambiguous') return value
  throw new Error('payback consent response query returned invalid classification')
}

const snapshot = (row: Record<string, unknown>): PaybackConsentSnapshot => {
  const stateValue = row.state
  const state = CONSENT_STATES.find((candidate) => candidate === stateValue)
  if (state === undefined) throw new Error('payback consent query returned invalid state')
  const actorTypeValue = row.actor_type
  if (actorTypeValue !== 'system' && actorTypeValue !== 'operator' && actorTypeValue !== 'participant')
    throw new Error('payback consent query returned invalid actor type')
  if (!(row.occurred_at instanceof Date)) throw new Error('payback consent query returned invalid occurred_at')
  return {
    aggregateId: rowText(row, 'aggregate_id'),
    versionId: rowText(row, 'version_id'),
    version: rowInteger(row, 'version'),
    state,
    termsVersion: nullableInteger(row.terms_version),
    requestId: nullableText(row.request_id),
    evidenceMessageId: nullableText(row.evidence_message_id),
    channel: nullableText(row.channel),
    classification: nullableText(row.classification),
    actorType: actorTypeValue,
    actorReference: rowText(row, 'actor_reference'),
    reasonCode: rowText(row, 'reason_code'),
    occurredAt: row.occurred_at,
  }
}

const termsText = (configuration: unknown): string => {
  if (typeof configuration !== 'object' || configuration === null)
    throw new PaybackConsentError('PAYBACK_TERMS_CONFIGURATION_INVALID')
  const terms = 'terms' in configuration ? configuration.terms : undefined
  const termsAlternate = 'termsText' in configuration ? configuration.termsText : undefined
  const value = typeof terms === 'string' ? terms : typeof termsAlternate === 'string' ? termsAlternate : null
  if (value === null || value.trim() === '') throw new PaybackConsentError('PAYBACK_TERMS_CONFIGURATION_INVALID')
  return value
}

const VERSION_COLUMNS = `
  a.id AS aggregate_id, v.id AS version_id, v.version, v.state, v.terms_version,
  v.request_id, v.evidence_message_id, v.channel, v.classification,
  v.actor_type, v.actor_reference, v.reason_code, v.occurred_at`

@Injectable()
export class PaybackConsentService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly intents: OutboundIntentService,
  ) {}

  async current(workflowId: string, participantId: string): Promise<PaybackConsentSnapshot | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS}
         FROM payback_consent_aggregates a
         JOIN payback_consent_heads h ON h.aggregate_id = a.id
         JOIN payback_consent_versions v ON v.id = h.version_id
        WHERE a.workflow_id = $1 AND a.participant_id = $2`,
      [workflowId, participantId],
    )
    return result.rows[0] === undefined ? null : snapshot(result.rows[0])
  }

  async history(workflowId: string, participantId: string): Promise<readonly PaybackConsentSnapshot[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS}
         FROM payback_consent_aggregates a
         JOIN payback_consent_versions v ON v.aggregate_id = a.id
        WHERE a.workflow_id = $1 AND a.participant_id = $2
        ORDER BY v.version ASC`,
      [workflowId, participantId],
    )
    return result.rows.map(snapshot)
  }

  async requestCurrentTerms(input: RequestPaybackConsentInput): Promise<RequestedPaybackConsent> {
    if (input.requestId.trim() === '') throw new PaybackConsentError('PAYBACK_REQUEST_ID_REQUIRED')
    return runInTransaction(this.pool, async (tx) => {
      const workflowResult = await tx.query(
        `SELECT id, participant_id, campaign_id, campaign_type, selection_state
           FROM workflow_instances WHERE id = $1 AND participant_id = $2 FOR UPDATE`,
        [input.workflowId, input.participantId],
      )
      const workflow = workflowResult.rows[0]
      if (workflow === undefined) throw new PaybackConsentError('PAYBACK_WORKFLOW_NOT_FOUND')
      if (workflow.campaign_type !== 'payback') throw new PaybackConsentError('PAYBACK_CAMPAIGN_REQUIRED')
      if (workflow.selection_state !== 'manually_selected' && workflow.selection_state !== 'auto_selected')
        throw new PaybackConsentError('PAYBACK_SELECTION_REQUIRED')
      const ruleResult = await tx.query(
        `SELECT id, version, configuration
           FROM campaign_rules
          WHERE campaign_id = $1 AND rule_type = 'payback' AND status = 'published'
            AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)
          ORDER BY version DESC LIMIT 1`,
        [rowText(workflow, 'campaign_id'), input.occurredAt],
      )
      const rule = ruleResult.rows[0]
      if (rule === undefined) throw new PaybackConsentError('PAYBACK_CURRENT_TERMS_MISSING')
      const ruleId = rowText(rule, 'id')
      const termsVersion = rowInteger(rule, 'version')
      const terms = termsText(rule.configuration)
      const aggregateId = await this.ensureAggregate(tx, workflow, input)
      const existingRequest = await tx.query(
        `SELECT r.id, r.outbound_notification_id, ${VERSION_COLUMNS}
           FROM payback_consent_requests r
           JOIN payback_consent_aggregates a ON a.id = r.aggregate_id
           JOIN payback_consent_heads h ON h.aggregate_id = a.id
           JOIN payback_consent_versions v ON v.id = h.version_id
          WHERE r.aggregate_id = $1 AND r.terms_version = $2`,
        [aggregateId, termsVersion],
      )
      if (existingRequest.rows[0] !== undefined) {
        const notificationId = existingRequest.rows[0].outbound_notification_id
        if (typeof notificationId !== 'string') throw new Error('payback request has no notification')
        const notificationResult = await tx.query(
          `SELECT id, deduplication_key, status, template_version, suppression_reason
             FROM outbound_notifications WHERE id = $1`,
          [notificationId],
        )
        const notificationRow = notificationResult.rows[0]
        if (notificationRow === undefined) throw new Error('payback request notification was not visible')
        return {
          consent: snapshot(existingRequest.rows[0]),
          notification: this.notification(notificationRow, true),
          deduplicated: true,
        }
      }
      const notification = await this.intents.enqueueIntent(tx, {
        workflowId: input.workflowId,
        channel: input.channel,
        recipientReference: input.recipientReference,
        purpose: MESSAGE_PURPOSES.PAYBACK_CONSENT_REQUEST,
        templatePurposeCode: MESSAGE_PURPOSES.PAYBACK_CONSENT_REQUEST,
        templateVersion: input.templateVersion,
        contentVersion: `payback_terms_v${String(termsVersion)}`,
        businessEventVersion: input.requestId,
        variables: { terms, request_id: input.requestId, terms_version: String(termsVersion) },
        source: 'automated',
        actorId: input.actorId,
        occurredAt: input.occurredAt,
      })
      await tx.query(
        `INSERT INTO payback_consent_requests (
           aggregate_id, workflow_id, request_id, terms_rule_id, terms_version,
           outbound_notification_id, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [aggregateId, input.workflowId, input.requestId, ruleId, termsVersion, notification.id, input.occurredAt],
      )
      const current = await this.currentInTransaction(tx, aggregateId)
      const version = current.version + 1
      const inserted = await tx.query(
        `INSERT INTO payback_consent_versions (
           aggregate_id, workflow_id, version, state, terms_version, request_id,
           evidence_message_id, channel, classification, actor_type, actor_reference,
           reason_code, occurred_at
         ) VALUES ($1,$2,$3,'awaiting_response',$4,$5,$6,$7,'request_sent','system',$8,'CURRENT_TERMS_REQUESTED',$9)
         RETURNING id`,
        [
          aggregateId,
          input.workflowId,
          version,
          termsVersion,
          input.requestId,
          notification.id,
          input.channel,
          input.actorId,
          input.occurredAt,
        ],
      )
      const versionId = rowText(inserted.rows[0] ?? {}, 'id')
      await tx.query(`UPDATE payback_consent_heads SET version_id = $2, updated_at = $3 WHERE aggregate_id = $1`, [
        aggregateId,
        versionId,
        input.occurredAt,
      ])
      await tx.query(
        `UPDATE workflow_instances
            SET payback_consent_state = 'awaiting_response', payback_consent_origin_at = $2,
                version = version + 1, updated_at = $2 WHERE id = $1`,
        [input.workflowId, input.occurredAt],
      )
      const consent = await this.currentInTransaction(tx, aggregateId)
      return { consent, notification, deduplicated: false }
    })
  }

  async correlatesWithCurrentRequest(
    workflowId: string,
    participantId: string,
    requestId: string,
    termsVersion: number,
  ): Promise<boolean> {
    const current = await this.current(workflowId, participantId)
    return (
      current?.state === 'awaiting_response' && current.requestId === requestId && current.termsVersion === termsVersion
    )
  }

  async recordResponse(input: RecordPaybackConsentResponseInput): Promise<RecordedPaybackConsentResponse> {
    if (input.requestId.trim() === '' || input.requestId.length > 200)
      throw new PaybackConsentError('PAYBACK_RESPONSE_REQUEST_ID_INVALID')
    if (!Number.isSafeInteger(input.termsVersion) || input.termsVersion < 1)
      throw new PaybackConsentError('PAYBACK_RESPONSE_TERMS_VERSION_INVALID')
    if (input.evidenceMessageId.trim() === '' || input.evidenceMessageId.length > 200)
      throw new PaybackConsentError('PAYBACK_RESPONSE_EVIDENCE_ID_INVALID')
    if (!Number.isSafeInteger(input.clarificationTemplateVersion) || input.clarificationTemplateVersion < 1)
      throw new PaybackConsentError('PAYBACK_CLARIFICATION_TEMPLATE_VERSION_INVALID')
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))
      throw new PaybackConsentError('PAYBACK_RESPONSE_OCCURRED_AT_INVALID')

    return runInTransaction(this.pool, async (tx) => {
      const workflowResult = await tx.query(
        `SELECT id, campaign_type FROM workflow_instances
          WHERE id = $1 AND participant_id = $2 FOR UPDATE`,
        [input.workflowId, input.participantId],
      )
      const workflow = workflowResult.rows[0]
      if (workflow === undefined) throw new PaybackConsentError('PAYBACK_WORKFLOW_NOT_FOUND')
      if (workflow.campaign_type !== 'payback') throw new PaybackConsentError('PAYBACK_CAMPAIGN_REQUIRED')

      const aggregateResult = await tx.query(
        `SELECT id FROM payback_consent_aggregates WHERE workflow_id = $1 AND participant_id = $2`,
        [input.workflowId, input.participantId],
      )
      const aggregateRow = aggregateResult.rows[0]
      if (aggregateRow === undefined) throw new PaybackConsentError('PAYBACK_CONSENT_NOT_REQUESTED')
      const aggregateId = rowText(aggregateRow, 'id')
      const current = await this.currentInTransaction(tx, aggregateId)

      const existing = await tx.query(
        `SELECT id, outcome, classification
           FROM payback_consent_response_events
          WHERE aggregate_id = $1 AND evidence_message_id = $2`,
        [aggregateId, input.evidenceMessageId],
      )
      const existingRow = existing.rows[0]
      if (existingRow !== undefined) {
        return {
          responseEventId: rowText(existingRow, 'id'),
          outcome: responseOutcome(existingRow.outcome),
          classification: responseClassification(existingRow.classification),
          consent: current,
          deduplicated: true,
        }
      }

      const classification = classifyPaybackConsentResponse(input.responseText)
      const correlated =
        current.state === 'awaiting_response' &&
        current.requestId === input.requestId &&
        current.termsVersion === input.termsVersion &&
        input.occurredAt.getTime() >= current.occurredAt.getTime()

      if (!correlated) {
        const outcome = current.state === 'awaiting_response' ? 'current_request_required' : 'ignored_no_active_request'
        const responseEventId = await this.insertResponseEvent(tx, aggregateId, input, classification, outcome)
        return { responseEventId, outcome, classification, consent: current, deduplicated: false }
      }

      if (classification === 'ambiguous') {
        const priorClarification = await tx.query(
          `SELECT id FROM payback_consent_response_events
            WHERE aggregate_id = $1 AND linked_request_id = $2
              AND linked_terms_version = $3 AND outcome = 'clarification_sent'
            LIMIT 1`,
          [aggregateId, input.requestId, input.termsVersion],
        )
        if (priorClarification.rows[0] === undefined) {
          const notification = await this.intents.enqueueIntent(tx, {
            workflowId: input.workflowId,
            channel: input.channel,
            recipientReference: input.recipientReference,
            purpose: MESSAGE_PURPOSES.PAYBACK_CONSENT_CLARIFICATION,
            templatePurposeCode: MESSAGE_PURPOSES.PAYBACK_CONSENT_CLARIFICATION,
            templateVersion: input.clarificationTemplateVersion,
            contentVersion: `payback_consent_clarification_terms_v${String(input.termsVersion)}`,
            businessEventVersion: input.requestId,
            variables: {},
            source: 'automated',
            actorId: input.automationActorId,
            occurredAt: input.occurredAt,
          })
          const outcome = 'clarification_sent'
          const responseEventId = await this.insertResponseEvent(tx, aggregateId, input, classification, outcome)
          return { responseEventId, outcome, classification, consent: current, notification, deduplicated: false }
        }

        const outcome = 'human_review_required'
        const responseEventId = await this.insertResponseEvent(tx, aggregateId, input, classification, outcome)
        const consent = await this.appendResponseVersion(tx, current, input, 'human_review_required', classification, {
          reasonCode: 'CONSENT_AMBIGUOUS_AFTER_CLARIFICATION',
          actorType: 'participant',
          actorReference: input.participantReference,
        })
        await this.routeAmbiguityToHumanReview(tx, aggregateId, input)
        return { responseEventId, outcome, classification, consent, deduplicated: false }
      }

      const outcome = classification === 'explicit_agreement' ? 'agreed' : 'declined'
      const responseEventId = await this.insertResponseEvent(tx, aggregateId, input, classification, outcome)
      const consent = await this.appendResponseVersion(tx, current, input, outcome, classification, {
        reasonCode: outcome === 'agreed' ? 'CURRENT_TERMS_EXPLICITLY_AGREED' : 'CURRENT_TERMS_EXPLICITLY_DECLINED',
        actorType: 'participant',
        actorReference: input.participantReference,
      })
      await tx.query(
        `UPDATE workflow_instances
            SET payback_consent_state = $2, payback_consent_origin_at = $3,
                version = version + 1, updated_at = $3
          WHERE id = $1`,
        [input.workflowId, outcome, input.occurredAt],
      )
      return { responseEventId, outcome, classification, consent, deduplicated: false }
    })
  }

  private async ensureAggregate(
    tx: DbTransaction,
    workflow: Record<string, unknown>,
    input: RequestPaybackConsentInput,
  ): Promise<string> {
    const existing = await tx.query(`SELECT id FROM payback_consent_aggregates WHERE workflow_id = $1`, [
      input.workflowId,
    ])
    if (existing.rows[0] !== undefined) return rowText(existing.rows[0], 'id')
    const aggregate = await tx.query(
      `INSERT INTO payback_consent_aggregates (
         workflow_id, participant_id, campaign_id, created_at
       ) VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.workflowId, input.participantId, rowText(workflow, 'campaign_id'), input.occurredAt],
    )
    const aggregateId = rowText(aggregate.rows[0] ?? {}, 'id')
    const version = await tx.query(
      `INSERT INTO payback_consent_versions (
         aggregate_id, workflow_id, version, state, actor_type, actor_reference,
         reason_code, occurred_at
       ) VALUES ($1,$2,1,'not_requested','system',$3,'CONSENT_INITIALIZED',$4)
       RETURNING id`,
      [aggregateId, input.workflowId, input.actorId, input.occurredAt],
    )
    await tx.query(`INSERT INTO payback_consent_heads (aggregate_id, version_id, updated_at) VALUES ($1,$2,$3)`, [
      aggregateId,
      rowText(version.rows[0] ?? {}, 'id'),
      input.occurredAt,
    ])
    return aggregateId
  }

  private async currentInTransaction(tx: DbTransaction, aggregateId: string): Promise<PaybackConsentSnapshot> {
    const result = await tx.query(
      `SELECT ${VERSION_COLUMNS}
         FROM payback_consent_aggregates a
         JOIN payback_consent_heads h ON h.aggregate_id = a.id
         JOIN payback_consent_versions v ON v.id = h.version_id
        WHERE a.id = $1`,
      [aggregateId],
    )
    if (result.rows[0] === undefined) throw new Error('payback consent current head was not visible')
    return snapshot(result.rows[0])
  }

  private async insertResponseEvent(
    tx: DbTransaction,
    aggregateId: string,
    input: RecordPaybackConsentResponseInput,
    classification: PaybackConsentResponseClassification,
    outcome: PaybackConsentResponseOutcome,
  ): Promise<string> {
    const inserted = await tx.query(
      `INSERT INTO payback_consent_response_events (
         aggregate_id, workflow_id, linked_request_id, linked_terms_version,
         evidence_message_id, channel, classification, outcome, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        aggregateId,
        input.workflowId,
        input.requestId,
        input.termsVersion,
        input.evidenceMessageId,
        input.channel,
        classification,
        outcome,
        input.occurredAt,
      ],
    )
    return rowText(inserted.rows[0] ?? {}, 'id')
  }

  private async appendResponseVersion(
    tx: DbTransaction,
    current: PaybackConsentSnapshot,
    input: RecordPaybackConsentResponseInput,
    state: 'agreed' | 'declined' | 'human_review_required',
    classification: PaybackConsentResponseClassification,
    actor: Readonly<{
      reasonCode: string
      actorType: 'participant'
      actorReference: string
    }>,
  ): Promise<PaybackConsentSnapshot> {
    const inserted = await tx.query(
      `INSERT INTO payback_consent_versions (
         aggregate_id, workflow_id, version, state, terms_version, request_id,
         evidence_message_id, channel, classification, actor_type, actor_reference,
         reason_code, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        current.aggregateId,
        input.workflowId,
        current.version + 1,
        state,
        input.termsVersion,
        input.requestId,
        input.evidenceMessageId,
        input.channel,
        classification,
        actor.actorType,
        actor.actorReference,
        actor.reasonCode,
        input.occurredAt,
      ],
    )
    const versionId = rowText(inserted.rows[0] ?? {}, 'id')
    await tx.query(`UPDATE payback_consent_heads SET version_id = $2, updated_at = $3 WHERE aggregate_id = $1`, [
      current.aggregateId,
      versionId,
      input.occurredAt,
    ])
    return this.currentInTransaction(tx, current.aggregateId)
  }

  private async routeAmbiguityToHumanReview(
    tx: DbTransaction,
    aggregateId: string,
    input: RecordPaybackConsentResponseInput,
  ): Promise<void> {
    await tx.query(
      `UPDATE workflow_instances
          SET payback_consent_state = 'human_review_required', payback_consent_origin_at = $2,
              human_handoff_state = CASE
                WHEN human_handoff_state IN ('not_required','requested') THEN 'queued'
                ELSE human_handoff_state
              END,
              human_handoff_origin_at = CASE
                WHEN human_handoff_state IN ('not_required','requested') THEN $2
                ELSE human_handoff_origin_at
              END,
              automation_mode_state = CASE
                WHEN automation_mode_state = 'active' THEN 'paused_for_human'
                ELSE automation_mode_state
              END,
              automation_mode_origin_at = CASE
                WHEN automation_mode_state = 'active' THEN $2
                ELSE automation_mode_origin_at
              END,
              version = version + 1, updated_at = $2
        WHERE id = $1`,
      [input.workflowId, input.occurredAt],
    )
    await tx.query(
      `INSERT INTO human_review_tasks (
         workflow_reference, reason_code, priority, status, case_packet,
         automation_paused, deduplication_key, created_at, updated_at
       ) VALUES ($1,'UNKNOWN_INTENT_AFTER_RETRIES','normal','open',$2::jsonb,true,$3,$4,$4)
       ON CONFLICT (deduplication_key) DO NOTHING`,
      [
        input.workflowId,
        JSON.stringify({
          stateCode: 'human_review_required',
          summaryCode: 'CONSENT_AMBIGUOUS_AFTER_CLARIFICATION',
          evidenceCodes: ['TWO_AMBIGUOUS_CURRENT_TERMS_RESPONSES', `TERMS_VERSION_${String(input.termsVersion)}`],
          allowedActionCodes: ['REVIEW_PAYBACK_CONSENT', 'KEEP_AUTOMATION_PAUSED'],
          recommendationCode: 'REVIEW_PAYBACK_CONSENT',
        }),
        `payback-consent-ambiguity:${aggregateId}:${String(input.termsVersion)}`,
        input.occurredAt,
      ],
    )
  }

  private notification(row: Record<string, unknown>, deduplicated: boolean): EnqueuedOutboundIntent {
    const statusValue = row.status
    if (
      statusValue !== 'pending' &&
      statusValue !== 'claimed' &&
      statusValue !== 'sending' &&
      statusValue !== 'accepted' &&
      statusValue !== 'unknown' &&
      statusValue !== 'delivered' &&
      statusValue !== 'failed' &&
      statusValue !== 'suppressed'
    )
      throw new Error('payback notification query returned invalid status')
    return {
      id: rowText(row, 'id'),
      deduplicationKey: rowText(row, 'deduplication_key'),
      status: statusValue,
      deduplicated,
      templateVersion: rowInteger(row, 'template_version'),
      ...(row.suppression_reason === 'HUMAN_OWNERSHIP_ACTIVE'
        ? { suppressionReason: 'HUMAN_OWNERSHIP_ACTIVE' as const }
        : {}),
    }
  }
}
