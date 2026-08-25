import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { SHIPPING_ADDRESS_ENCRYPTION_KEY } from '@helloreview/config'
import { MESSAGE_PURPOSES } from '@helloreview/contracts'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { OutboundIntentService, type EnqueuedOutboundIntent } from '../messaging/index.js'
import {
  addressFingerprint,
  decryptShippingAddress,
  encryptShippingAddress,
  maskShippingAddress,
} from './address-crypto.js'
import {
  validateShippingAddress,
  type NormalizedShippingAddress,
  type ShippingAddressInput,
  type ShippingAddressPolicy,
  type ShippingAddressValidation,
} from './address-validation.js'

export class ShippingServiceError extends Error {
  override readonly name = 'ShippingServiceError'
  constructor(readonly reasonCode: string) {
    super(`shipping action rejected: ${reasonCode}`)
  }
}

export type IssueShippingFormInput = Readonly<{
  workflowId: string
  participantId: string
  channel: 'KAKAO'
  recipientReference: string
  formBaseUrl: string
  tokenTtlSeconds: number
  templateVersion: number
  actorId: string
  occurredAt: Date
  requestAddressChange?: boolean
}>

export type IssuedShippingForm = Readonly<{
  outcome: 'issued' | 'already_issued' | 'already_valid'
  token: string | null
  expiresAt: Date | null
  notification: EnqueuedOutboundIntent | null
}>

export type SubmitShippingAddressInput = Readonly<{
  token: string
  workflowId: string
  participantId: string
  address: ShippingAddressInput
  policy: ShippingAddressPolicy | null
  actorReference: string
  occurredAt: Date
}>

export type SubmittedShippingAddress = Readonly<{
  outcome: 'stored' | 'duplicate' | 'invalid' | 'human_review'
  addressId: string | null
  version: number | null
  maskedSummary: string | null
  validation: ShippingAddressValidation
}>

export type RevealShippingAddressInput = Readonly<{
  workflowId: string
  participantId: string
  actorType: 'operator' | 'system' | 'participant'
  actorReference: string
  authorized: boolean
  reasonCode: string
  correlationId: string
  occurredAt: Date
}>

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

const rowText = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`shipping query returned invalid ${column}`)
}

const rowInteger = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw new Error(`shipping query returned invalid ${column}`)
}

@Injectable()
export class ShippingService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(SHIPPING_ADDRESS_ENCRYPTION_KEY) private readonly encryptionKey: Buffer,
    private readonly intents: OutboundIntentService,
  ) {}

  async issueForm(input: IssueShippingFormInput): Promise<IssuedShippingForm> {
    if (input.tokenTtlSeconds < 1) throw new ShippingServiceError('SHIPPING_FORM_TTL_INVALID')
    return runInTransaction(this.pool, async (tx) => {
      const workflow = await this.lockWorkflow(tx, input.workflowId, input.participantId)
      if (workflow.campaign_type !== 'shipping') throw new ShippingServiceError('SHIPPING_CAMPAIGN_REQUIRED')
      if (workflow.selection_state !== 'manually_selected' && workflow.selection_state !== 'auto_selected')
        throw new ShippingServiceError('SHIPPING_SELECTION_REQUIRED')
      const current = await tx.query(
        `SELECT a.id, a.version, a.masked_summary
           FROM shipping_address_heads h JOIN shipping_addresses a ON a.id = h.address_id
          WHERE h.workflow_id = $1`,
        [input.workflowId],
      )
      if (current.rows[0] !== undefined && input.requestAddressChange !== true)
        return { outcome: 'already_valid', token: null, expiresAt: null, notification: null }

      const currentVersion = current.rows[0] === undefined ? 'initial' : String(current.rows[0].version)
      const deduplicationKey = digest(
        `${input.workflowId}|${String(workflow.selection_origin_at)}|SHIPPING_ADDRESS_REQUEST|${currentVersion}`,
      )
      const existing = await tx.query(
        `SELECT expires_at FROM shipping_form_grants
          WHERE deduplication_key = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
        [deduplicationKey, input.occurredAt],
      )
      if (existing.rows[0] !== undefined) {
        const expiresAt = existing.rows[0].expires_at
        if (!(expiresAt instanceof Date)) throw new Error('shipping form query returned invalid expiry')
        return { outcome: 'already_issued', token: null, expiresAt, notification: null }
      }
      const token = randomBytes(32).toString('base64url')
      const expiresAt = new Date(input.occurredAt.getTime() + input.tokenTtlSeconds * 1_000)
      const grant = await tx.query(
        `INSERT INTO shipping_form_grants (
           workflow_id, participant_id, token_digest, deduplication_key, expires_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [input.workflowId, input.participantId, digest(token), deduplicationKey, expiresAt, input.occurredAt],
      )
      const grantId = rowText(grant.rows[0] ?? {}, 'id')
      const formUrl = `${input.formBaseUrl.replace(/\/$/, '')}/${grantId}#${token}`
      const notification = await this.intents.enqueueIntent(tx, {
        workflowId: input.workflowId,
        channel: input.channel,
        recipientReference: input.recipientReference,
        purpose: MESSAGE_PURPOSES.SHIPPING_ADDRESS_REQUEST,
        templatePurposeCode: MESSAGE_PURPOSES.SHIPPING_ADDRESS_REQUEST,
        templateVersion: input.templateVersion,
        contentVersion: `shipping_form_${deduplicationKey}`,
        businessEventVersion: deduplicationKey,
        variables: { form_link: formUrl },
        source: 'automated',
        actorId: input.actorId,
        occurredAt: input.occurredAt,
      })
      await tx.query(`UPDATE shipping_form_grants SET outbound_notification_id = $2 WHERE id = $1`, [
        grantId,
        notification.id,
      ])
      await tx.query(
        `UPDATE workflow_instances
            SET shipping_state = $3, shipping_origin_at = $2,
                version = version + 1, updated_at = $2
          WHERE id = $1`,
        [
          input.workflowId,
          input.occurredAt,
          input.requestAddressChange === true ? 'address_change_requested' : 'address_requested',
        ],
      )
      return { outcome: 'issued', token, expiresAt, notification }
    })
  }

  async submit(input: SubmitShippingAddressInput): Promise<SubmittedShippingAddress> {
    const validation = validateShippingAddress(input.address, input.policy)
    return runInTransaction(this.pool, async (tx) => {
      const grantResult = await tx.query(
        `SELECT id, workflow_id, participant_id, expires_at, consumed_at, revoked_at
           FROM shipping_form_grants WHERE token_digest = $1 FOR UPDATE`,
        [digest(input.token)],
      )
      const grant = grantResult.rows[0]
      if (grant?.workflow_id !== input.workflowId || grant.participant_id !== input.participantId)
        throw new ShippingServiceError('SHIPPING_FORM_NOT_FOUND')
      if (grant.consumed_at instanceof Date || grant.revoked_at instanceof Date)
        throw new ShippingServiceError('SHIPPING_FORM_ALREADY_USED')
      if (!(grant.expires_at instanceof Date) || grant.expires_at.getTime() <= input.occurredAt.getTime())
        throw new ShippingServiceError('SHIPPING_FORM_EXPIRED')
      const workflow = await this.lockWorkflow(tx, input.workflowId, input.participantId)
      if (workflow.campaign_type !== 'shipping') throw new ShippingServiceError('SHIPPING_CAMPAIGN_REQUIRED')
      const policy = input.policy
      if (policy === null) throw new ShippingServiceError('SHIPPING_POLICY_MISSING')
      if (!validation.valid) {
        await tx.query(
          `UPDATE workflow_instances
              SET shipping_state = 'address_incomplete', shipping_origin_at = $2,
                  version = version + 1, updated_at = $2 WHERE id = $1`,
          [input.workflowId, input.occurredAt],
        )
        return { outcome: 'invalid', addressId: null, version: null, maskedSummary: null, validation }
      }
      const currentResult = await tx.query(
        `SELECT a.id, a.version, a.address_fingerprint, a.masked_summary
           FROM shipping_address_heads h JOIN shipping_addresses a ON a.id = h.address_id
          WHERE h.workflow_id = $1`,
        [input.workflowId],
      )
      const current = currentResult.rows[0]
      if (input.occurredAt.getTime() >= policy.lockAt.getTime())
        throw new ShippingServiceError('SHIPPING_ADDRESS_LOCKED')
      if (current?.id !== undefined && input.occurredAt.getTime() >= policy.changeCutoffAt.getTime()) {
        await tx.query(`UPDATE shipping_form_grants SET consumed_at = $2 WHERE id = $1`, [
          rowText(grant, 'id'),
          input.occurredAt,
        ])
        await this.routeLateChange(tx, input, rowText(current, 'id'))
        return { outcome: 'human_review', addressId: null, version: null, maskedSummary: null, validation }
      }
      const fingerprint = addressFingerprint(this.encryptionKey, validation.normalized)
      if (current?.address_fingerprint === fingerprint) {
        await tx.query(`UPDATE shipping_form_grants SET consumed_at = $2 WHERE id = $1`, [
          rowText(grant, 'id'),
          input.occurredAt,
        ])
        return {
          outcome: 'duplicate',
          addressId: rowText(current, 'id'),
          version: rowInteger(current, 'version'),
          maskedSummary: rowText(current, 'masked_summary'),
          validation,
        }
      }
      const version = current === undefined ? 1 : rowInteger(current, 'version') + 1
      const maskedSummary = maskShippingAddress(validation.normalized)
      const inserted = await tx.query(
        `INSERT INTO shipping_addresses (
           workflow_id, participant_id, campaign_id, version, encrypted_payload,
           address_fingerprint, masked_summary, validation_state, validation_evidence,
           policy_version, change_source, actor_reference, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'valid',$8::jsonb,$9,'participant_form',$10,$11)
         RETURNING id`,
        [
          input.workflowId,
          input.participantId,
          rowText(workflow, 'campaign_id'),
          version,
          encryptShippingAddress(this.encryptionKey, validation.normalized),
          fingerprint,
          maskedSummary,
          JSON.stringify(validation.corrections),
          policy.version,
          input.actorReference,
          input.occurredAt,
        ],
      )
      const addressId = rowText(inserted.rows[0] ?? {}, 'id')
      await tx.query(
        `INSERT INTO shipping_address_heads (workflow_id, address_id, updated_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (workflow_id) DO UPDATE SET address_id = EXCLUDED.address_id, updated_at = EXCLUDED.updated_at`,
        [input.workflowId, addressId, input.occurredAt],
      )
      await tx.query(`UPDATE shipping_form_grants SET consumed_at = $2 WHERE id = $1`, [
        rowText(grant, 'id'),
        input.occurredAt,
      ])
      await tx.query(
        `UPDATE workflow_instances
            SET shipping_state = 'address_valid', shipping_origin_at = $2,
                version = version + 1, updated_at = $2 WHERE id = $1`,
        [input.workflowId, input.occurredAt],
      )
      return { outcome: 'stored', addressId, version, maskedSummary, validation }
    })
  }

  async currentMasked(
    workflowId: string,
    participantId: string,
  ): Promise<Readonly<{ id: string; version: number; maskedSummary: string }> | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT a.id, a.version, a.masked_summary
         FROM workflow_instances w
         JOIN shipping_address_heads h ON h.workflow_id = w.id
         JOIN shipping_addresses a ON a.id = h.address_id
        WHERE w.id = $1 AND w.participant_id = $2 AND a.participant_id = $2`,
      [workflowId, participantId],
    )
    const row = result.rows[0]
    return row === undefined
      ? null
      : { id: rowText(row, 'id'), version: rowInteger(row, 'version'), maskedSummary: rowText(row, 'masked_summary') }
  }

  async reveal(input: RevealShippingAddressInput): Promise<NormalizedShippingAddress> {
    if (input.actorType !== 'operator' || !input.authorized)
      throw new ShippingServiceError('SHIPPING_REVEAL_NOT_AUTHORIZED')
    if (!/^[A-Z][A-Z0-9_]*$/.test(input.reasonCode)) throw new ShippingServiceError('SHIPPING_REVEAL_REASON_REQUIRED')
    return runInTransaction(this.pool, async (tx) => {
      const result = await tx.query(
        `SELECT a.id, a.encrypted_payload
           FROM workflow_instances w
           JOIN shipping_address_heads h ON h.workflow_id = w.id
           JOIN shipping_addresses a ON a.id = h.address_id
          WHERE w.id = $1 AND w.participant_id = $2 AND a.participant_id = $2`,
        [input.workflowId, input.participantId],
      )
      const row = result.rows[0]
      if (row === undefined) throw new ShippingServiceError('SHIPPING_ADDRESS_NOT_FOUND')
      await tx.query(
        `INSERT INTO shipping_address_reveals (
           address_id, workflow_id, actor_reference, reason_code, correlation_id, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          rowText(row, 'id'),
          input.workflowId,
          input.actorReference,
          input.reasonCode,
          input.correlationId,
          input.occurredAt,
        ],
      )
      return decryptShippingAddress(this.encryptionKey, rowText(row, 'encrypted_payload'))
    })
  }

  private async lockWorkflow(
    tx: DbTransaction,
    workflowId: string,
    participantId: string,
  ): Promise<Record<string, unknown>> {
    const result = await tx.query(
      `SELECT id, participant_id, campaign_id, campaign_type, selection_state,
              selection_origin_at, shipping_state
         FROM workflow_instances WHERE id = $1 AND participant_id = $2 FOR UPDATE`,
      [workflowId, participantId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new ShippingServiceError('SHIPPING_WORKFLOW_NOT_FOUND')
    return row
  }

  private async routeLateChange(
    tx: DbTransaction,
    input: SubmitShippingAddressInput,
    currentAddressId: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE workflow_instances
          SET shipping_state = 'address_change_requested', shipping_origin_at = $2,
              version = version + 1, updated_at = $2 WHERE id = $1`,
      [input.workflowId, input.occurredAt],
    )
    await tx.query(
      `INSERT INTO human_review_tasks (
         workflow_reference, reason_code, priority, status, case_packet,
         automation_paused, deduplication_key, created_at, updated_at
       ) VALUES ($1,'SHIPPING_CHANGE_AFTER_CUTOFF','normal','open',$2::jsonb,true,$3,$4,$4)
       ON CONFLICT (deduplication_key) DO NOTHING`,
      [
        input.workflowId,
        JSON.stringify({
          stateCode: 'address_change_requested',
          summaryCode: 'SHIPPING_CHANGE_AFTER_CUTOFF',
          evidenceCodes: [`CURRENT_ADDRESS_${currentAddressId}`],
          allowedActionCodes: ['APPROVE_ADDRESS_CHANGE', 'KEEP_CURRENT_ADDRESS'],
          recommendationCode: 'REVIEW_ADDRESS_CHANGE',
        }),
        `shipping-late-change:${input.workflowId}:${digest(input.token)}`,
        input.occurredAt,
      ],
    )
  }
}
