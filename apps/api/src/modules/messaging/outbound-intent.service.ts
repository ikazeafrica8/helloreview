import { Injectable } from '@nestjs/common'
import { MESSAGE_PURPOSES, buildDedupeKey, type OutboundChannel } from '@helloreview/contracts'
import type { DbTransaction } from '@helloreview/db'
import { MessageTemplateRepository } from './message-template.repository.js'
import { MESSAGING_REASON } from './reason-codes.js'
import { renderMessageTemplate, type TemplateVariables } from './template-renderer.js'

export type OutboundIntentSource = 'automated' | 'operator' | 'system_notice'
export type OutboundNotificationStatus =
  'pending' | 'claimed' | 'sending' | 'accepted' | 'unknown' | 'delivered' | 'failed' | 'suppressed'

export type EnqueueOutboundIntent = Readonly<{
  workflowId: string
  channel: OutboundChannel
  recipientReference: string
  purpose: string
  templatePurposeCode: string
  templateVersion: number
  contentVersion: string
  businessEventVersion?: string
  authorizedRedeliveryId?: string
  variables: TemplateVariables
  source: OutboundIntentSource
  actorId: string
  occurredAt: Date
}>

export type EnqueuedOutboundIntent = Readonly<{
  id: string
  deduplicationKey: string
  status: OutboundNotificationStatus
  suppressionReason?: typeof MESSAGING_REASON.HUMAN_OWNERSHIP_ACTIVE
  deduplicated: boolean
  templateVersion: number
}>

export class OutboundIntentError extends Error {
  override readonly name = 'OutboundIntentError'

  constructor(readonly reasonCode: (typeof MESSAGING_REASON)[keyof typeof MESSAGING_REASON]) {
    super(`outbound intent rejected: ${reasonCode}`)
  }
}

/** Notices allowed to bypass active human ownership. Deliberately small and explicit. */
export const HUMAN_OWNERSHIP_SYSTEM_NOTICE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  MESSAGE_PURPOSES.SYSTEM_DELAY_NOTICE,
])

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`outbound intent query returned invalid ${column}`)
}

const OUTBOUND_NOTIFICATION_STATUSES: readonly OutboundNotificationStatus[] = [
  'pending',
  'claimed',
  'sending',
  'accepted',
  'unknown',
  'delivered',
  'failed',
  'suppressed',
]

const statusColumn = (row: Record<string, unknown>): OutboundNotificationStatus => {
  const value = row.status
  const found = OUTBOUND_NOTIFICATION_STATUSES.find((status) => status === value)
  if (found !== undefined) return found
  throw new Error('outbound intent query returned invalid status')
}

const assertVisitCBookingAuthorized = async (
  tx: DbTransaction,
  workflow: Record<string, unknown>,
  command: EnqueueOutboundIntent,
): Promise<void> => {
  if (command.purpose !== MESSAGE_PURPOSES.VISIT_C_BOOKING_INSTRUCTIONS) return
  const approval = await tx.query(
    `SELECT a.state, a.source, a.campaign_id, a.application_id, a.expires_at, w.visit_method
       FROM workflow_instances w
       LEFT JOIN business_approval_heads h ON h.workflow_id = w.id
       LEFT JOIN business_approvals a ON a.id = h.approval_id AND a.workflow_id = w.id
      WHERE w.id = $1`,
    [command.workflowId],
  )
  const row = approval.rows[0]
  const expiresAt = row?.expires_at
  const current =
    row?.visit_method === 'visit_c' &&
    row.state === 'approved' &&
    (row.source === 'authorized_operator' || row.source === 'authorized_system') &&
    row.campaign_id === workflow.campaign_id &&
    row.application_id === workflow.application_id &&
    (expiresAt === null || (expiresAt instanceof Date && expiresAt.getTime() > command.occurredAt.getTime()))
  if (!current) throw new OutboundIntentError(MESSAGING_REASON.VISIT_C_APPROVAL_REQUIRED)
}

@Injectable()
export class OutboundIntentService {
  constructor(private readonly templates: MessageTemplateRepository) {}

  /** The branded first argument makes enqueueing outside the caller's state transaction impossible. */
  async enqueueIntent(tx: DbTransaction, command: EnqueueOutboundIntent): Promise<EnqueuedOutboundIntent> {
    const workflow = await tx.query(
      `SELECT id, participant_id, application_id, campaign_id
         FROM workflow_instances
        WHERE id = $1
        FOR UPDATE`,
      [command.workflowId],
    )
    const workflowRow = workflow.rows[0]
    if (workflowRow === undefined) throw new OutboundIntentError(MESSAGING_REASON.WORKFLOW_NOT_FOUND)
    await assertVisitCBookingAuthorized(tx, workflowRow, command)

    const ownerResult = await tx.query(
      `SELECT operator_id
         FROM operator_assignments
        WHERE workflow_id = $1 AND ended_at IS NULL`,
      [command.workflowId],
    )
    const activeOperator = ownerResult.rows[0]?.operator_id
    if (activeOperator !== undefined && typeof activeOperator !== 'string') {
      throw new Error('operator assignment query returned invalid operator_id')
    }

    if (command.source === 'operator' && activeOperator !== command.actorId) {
      throw new OutboundIntentError(MESSAGING_REASON.OPERATOR_OWNERSHIP_REQUIRED)
    }
    if (command.source === 'system_notice' && !HUMAN_OWNERSHIP_SYSTEM_NOTICE_ALLOWLIST.has(command.purpose)) {
      throw new OutboundIntentError(MESSAGING_REASON.SYSTEM_NOTICE_NOT_ALLOWLISTED)
    }

    const template = await this.templates.resolve(tx, command.templatePurposeCode, command.templateVersion)
    const renderedContent = renderMessageTemplate(template.body, command.variables)
    const deduplicationKey = buildDedupeKey({
      channel: command.channel,
      workflowId: command.workflowId,
      participantId: stringColumn(workflowRow, 'participant_id'),
      applicationId: stringColumn(workflowRow, 'application_id'),
      campaignId: stringColumn(workflowRow, 'campaign_id'),
      purpose: command.purpose,
      contentVersion: command.contentVersion,
      ...(command.businessEventVersion === undefined ? {} : { businessEventVersion: command.businessEventVersion }),
      ...(command.authorizedRedeliveryId === undefined
        ? {}
        : { authorizedRedeliveryId: command.authorizedRedeliveryId }),
    })
    const suppressed = command.source === 'automated' && activeOperator !== undefined
    const status = suppressed ? 'suppressed' : 'pending'
    const suppressionReason = suppressed ? MESSAGING_REASON.HUMAN_OWNERSHIP_ACTIVE : undefined

    const inserted = await tx.query(
      `INSERT INTO outbound_notifications (
         workflow_id, channel, recipient_reference, purpose_code, content_version,
         business_event_version, authorized_redelivery_id, deduplication_key, intent_source,
         template_id, template_version, rendered_content, provider_template_code,
         status, suppression_reason, next_attempt_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$16)
       ON CONFLICT (deduplication_key) DO NOTHING
       RETURNING id`,
      [
        command.workflowId,
        command.channel,
        command.recipientReference,
        command.purpose,
        command.contentVersion,
        command.businessEventVersion ?? null,
        command.authorizedRedeliveryId ?? null,
        deduplicationKey,
        command.source,
        template.id,
        template.version,
        renderedContent,
        template.providerTemplateCode ?? null,
        status,
        suppressionReason ?? null,
        command.occurredAt,
      ],
    )

    const insertedRow = inserted.rows[0]
    if (insertedRow === undefined) {
      const existing = await tx.query(
        `SELECT id, status, suppression_reason, template_version
           FROM outbound_notifications
          WHERE deduplication_key = $1`,
        [deduplicationKey],
      )
      const row = existing.rows[0]
      if (row === undefined) throw new Error('deduplicated outbound intent could not be re-read')
      const existingStatus = statusColumn(row)
      return {
        id: stringColumn(row, 'id'),
        deduplicationKey,
        status: existingStatus,
        ...(row.suppression_reason === MESSAGING_REASON.HUMAN_OWNERSHIP_ACTIVE
          ? { suppressionReason: MESSAGING_REASON.HUMAN_OWNERSHIP_ACTIVE }
          : {}),
        deduplicated: true,
        templateVersion: Number(row.template_version),
      }
    }

    const id = stringColumn(insertedRow, 'id')
    await tx.query(
      `INSERT INTO outbound_notification_events (
         notification_id, event_type, status, reason_code, retry_count, actor_id, occurred_at
       ) VALUES ($1,$2,$3,$4,0,$5,$6)`,
      [
        id,
        suppressed ? 'suppressed' : 'created',
        status,
        suppressionReason ?? MESSAGING_REASON.OUTBOUND_INTENT_CREATED,
        command.actorId,
        command.occurredAt,
      ],
    )

    return {
      id,
      deduplicationKey,
      status,
      ...(suppressionReason === undefined ? {} : { suppressionReason }),
      deduplicated: false,
      templateVersion: template.version,
    }
  }
}
