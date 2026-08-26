import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import {
  PRIVACY_REQUEST_TYPES,
  PrivacyRequestContractError,
  assertPseudonymousPrivacyReference,
  parsePrivacyRequestIntakeEvidence,
  parsePrivacyRequestScope,
  type PrivacyRequestIntakeEvidence,
  type PrivacyRequestScope,
  type PrivacyRequestType,
} from './privacy-request-contract.js'
import {
  PrivacyAffectedProcessingScope,
  PrivacyIdentityVerificationEvidence,
  PrivacyIdentityVerificationPolicy,
  parsePrivacyAffectedProcessingScopes,
  parsePrivacyIdentityVerificationEvidence,
  parsePrivacyIdentityVerificationPolicy,
} from './privacy-identity-verification.js'

export type PrivacyRequestActorType = 'system' | 'operator' | 'participant'
export type PrivacyIdentityVerificationState = 'unverified' | 'pending' | 'verified' | 'failed'
export type PrivacyRequestStatus =
  'received' | 'identity_verification' | 'in_review' | 'blocked' | 'completed' | 'denied' | 'cancelled'

export type IntakePrivacyRequestInput = Readonly<{
  requestReference: string
  requesterReference: string
  claimedParticipantId: string | null
  requestType: PrivacyRequestType
  scope: PrivacyRequestScope
  deadlinePolicy: Readonly<{ reference: string; deadlineAt: Date }> | null
  assigneeId: string | null
  evidence: PrivacyRequestIntakeEvidence
  actorType: PrivacyRequestActorType
  actorReference: string
  sourceAuthorized: boolean
  correlationId: string
  occurredAt: Date
}>

export type PrivacyRequestSnapshot = Readonly<{
  id: string
  requestReference: string
  requesterReference: string
  claimedParticipantId: string | null
  requestType: PrivacyRequestType
  identityVerificationState: PrivacyIdentityVerificationState
  verificationPolicyReference: string | null
  verificationMethod: string | null
  verifiedAt: Date | null
  scope: PrivacyRequestScope
  status: PrivacyRequestStatus
  deadlinePolicyReference: string | null
  deadlineAt: Date | null
  assigneeId: string | null
  createdAt: Date
  updatedAt: Date
}>

export type PrivacyRequestIntakeResult = Readonly<{
  request: PrivacyRequestSnapshot
  deduplicated: boolean
}>

type PrivacyReviewerAction = Readonly<{
  requestId: string
  operationReference: string
  actorReference: string
  reviewerAuthorized: boolean
  correlationId: string
  occurredAt: Date
}>

export type BeginPrivacyIdentityVerificationInput = PrivacyReviewerAction &
  Readonly<{ affectedScopes: readonly PrivacyAffectedProcessingScope[] }>

export type CompletePrivacyIdentityVerificationInput = PrivacyReviewerAction &
  Readonly<{
    policy: PrivacyIdentityVerificationPolicy
    evidence: PrivacyIdentityVerificationEvidence
  }>

export type PrivacyProcessingPauseSnapshot = PrivacyAffectedProcessingScope & Readonly<{ pauseId: string }>

export type BeginPrivacyIdentityVerificationResult = Readonly<{
  request: PrivacyRequestSnapshot
  pauses: readonly PrivacyProcessingPauseSnapshot[]
  deduplicated: boolean
}>

export type CompletePrivacyIdentityVerificationResult = Readonly<{
  request: PrivacyRequestSnapshot
  verified: boolean
  deduplicated: boolean
}>

export class PrivacyRequestServiceError extends Error {
  override readonly name = 'PrivacyRequestServiceError'
  constructor(readonly reasonCode: string) {
    super(`privacy request action rejected: ${reasonCode}`)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTOR_TYPES = ['system', 'operator', 'participant'] as const
const VERIFICATION_STATES = ['unverified', 'pending', 'verified', 'failed'] as const
const STATUSES = [
  'received',
  'identity_verification',
  'in_review',
  'blocked',
  'completed',
  'denied',
  'cancelled',
] as const

const rowText = (row: Record<string, unknown>, field: string): string => {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`privacy request query returned invalid ${field}`)
  return value
}

const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const rowDate = (row: Record<string, unknown>, field: string): Date => {
  const value = row[field]
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new Error(`privacy request query returned invalid ${field}`)
  return value
}

const nullableDate = (value: unknown): Date | null => {
  if (value === null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error('privacy request query returned invalid nullable date')
}

const member = <Values extends readonly string[]>(values: Values, value: unknown, field: string): Values[number] => {
  const found = values.find((candidate) => candidate === value)
  if (found === undefined) throw new Error(`privacy request query returned invalid ${field}`)
  return found
}

const snapshot = (row: Record<string, unknown>): PrivacyRequestSnapshot => ({
  id: rowText(row, 'id'),
  requestReference: rowText(row, 'request_reference'),
  requesterReference: rowText(row, 'requester_reference'),
  claimedParticipantId: nullableText(row.claimed_participant_id),
  requestType: member(PRIVACY_REQUEST_TYPES, row.request_type, 'request_type'),
  identityVerificationState: member(
    VERIFICATION_STATES,
    row.identity_verification_state,
    'identity_verification_state',
  ),
  verificationPolicyReference: nullableText(row.verification_policy_reference),
  verificationMethod: nullableText(row.verification_method),
  verifiedAt: nullableDate(row.verified_at),
  scope: parsePrivacyRequestScope(row.scope),
  status: member(STATUSES, row.status, 'status'),
  deadlinePolicyReference: nullableText(row.deadline_policy_reference),
  deadlineAt: nullableDate(row.deadline_at),
  assigneeId: nullableText(row.assignee_id),
  createdAt: rowDate(row, 'created_at'),
  updatedAt: rowDate(row, 'updated_at'),
})

const SELECT_COLUMNS = `
  id, request_reference, requester_reference, claimed_participant_id, request_type,
  identity_verification_state, verification_policy_reference, verification_method, verified_at,
  scope, status, deadline_policy_reference, deadline_at,
  assignee_id, input_digest, created_at, updated_at`

const digestInput = (
  input: IntakePrivacyRequestInput,
  scope: PrivacyRequestScope,
  evidence: PrivacyRequestIntakeEvidence,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        requestReference: input.requestReference,
        requesterReference: input.requesterReference,
        claimedParticipantId: input.claimedParticipantId,
        requestType: input.requestType,
        scope,
        deadlinePolicy:
          input.deadlinePolicy === null
            ? null
            : { reference: input.deadlinePolicy.reference, deadlineAt: input.deadlinePolicy.deadlineAt.toISOString() },
        assigneeId: input.assigneeId,
        evidence,
      }),
    )
    .digest('hex')

const digestObject = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const privacyReferenceId = (reference: string, prefix: 'campaign' | 'workflow'): string | null => {
  const match = new RegExp(
    `^${prefix}:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`,
    'i',
  ).exec(reference)
  return match?.[1]?.toLowerCase() ?? null
}

const pauseDetail = (scope: PrivacyAffectedProcessingScope): Record<string, string> => {
  switch (scope.scope) {
    case 'participant':
      return { scope: scope.scope, participant_id: scope.participantId }
    case 'participant_campaign':
      return { scope: scope.scope, participant_id: scope.participantId, campaign_id: scope.campaignId }
    case 'workflow':
      return { scope: scope.scope, workflow_id: scope.workflowId }
  }
}

@Injectable()
export class PrivacyRequestService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async intake(input: IntakePrivacyRequestInput): Promise<PrivacyRequestIntakeResult> {
    const validated = this.validateIntake(input)
    return runInTransaction(this.pool, async (tx) => this.intakeInTransaction(tx, input, validated))
  }

  async beginIdentityVerification(
    input: BeginPrivacyIdentityVerificationInput,
  ): Promise<BeginPrivacyIdentityVerificationResult> {
    const scopes = this.validateBeginVerification(input)
    const digest = digestObject({ requestId: input.requestId, operationReference: input.operationReference, scopes })
    return runInTransaction(this.pool, async (tx) => {
      const row = await this.lockRequest(tx, input.requestId)
      const replay = await this.verificationReplay(
        tx,
        `privacy-identity-verification-start:${input.operationReference}`,
        digest,
      )
      if (replay)
        return { request: snapshot(row), pauses: await this.pauseSnapshots(tx, input.requestId), deduplicated: true }
      const claimedParticipantId = nullableText(row.claimed_participant_id)
      const fromVerificationState = member(
        VERIFICATION_STATES,
        row.identity_verification_state,
        'identity_verification_state',
      )
      const fromStatus = member(STATUSES, row.status, 'status')
      if (
        claimedParticipantId === null ||
        (fromVerificationState !== 'unverified' && fromVerificationState !== 'failed') ||
        (fromStatus !== 'received' && fromStatus !== 'blocked')
      )
        throw new PrivacyRequestServiceError('PRIVACY_IDENTITY_VERIFICATION_STATE_INVALID')

      const requestScope = parsePrivacyRequestScope(row.scope)
      await this.assertAffectedScopes(tx, claimedParticipantId, requestScope, scopes)
      const pauses: PrivacyProcessingPauseSnapshot[] = []
      for (const scope of scopes) {
        const pauseId = await this.ensurePrivacyPause(tx, scope, input)
        await tx.query(
          `INSERT INTO privacy_request_processing_pauses (
             request_id, pause_id, scope, participant_id, campaign_id, workflow_id, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (request_id, pause_id) DO NOTHING`,
          [
            input.requestId,
            pauseId,
            scope.scope,
            scope.scope === 'participant' || scope.scope === 'participant_campaign' ? scope.participantId : null,
            scope.scope === 'participant_campaign' ? scope.campaignId : null,
            scope.scope === 'workflow' ? scope.workflowId : null,
            input.occurredAt,
          ],
        )
        pauses.push({ ...scope, pauseId })
      }
      const updated = await tx.query(
        `UPDATE privacy_requests
            SET identity_verification_state = 'pending', status = 'identity_verification',
                verification_policy_reference = null, verification_method = null, verified_at = null,
                updated_at = $2
          WHERE id = $1
          RETURNING ${SELECT_COLUMNS}`,
        [input.requestId, input.occurredAt],
      )
      const next = updated.rows[0]
      if (next === undefined) throw new Error('privacy verification start update did not return a row')
      await this.appendVerificationEvent(tx, {
        requestId: input.requestId,
        fromStatus,
        toStatus: 'identity_verification',
        fromVerificationState,
        toVerificationState: 'pending',
        actorReference: input.actorReference,
        reasonCode: 'PRIVACY_IDENTITY_VERIFICATION_STARTED',
        evidenceReference: input.operationReference,
        correlationId: input.correlationId,
        deduplicationKey: `privacy-identity-verification-start:${input.operationReference}`,
        occurredAt: input.occurredAt,
        detail: {
          input_digest: digest,
          affected_processing: pauses.map(({ pauseId: _pauseId, ...scope }) => pauseDetail(scope)),
        },
      })
      await this.appendVerificationAudit(tx, input, 'PRIVACY_IDENTITY_VERIFICATION_STARTED', 'success', {
        affected_pause_ids: pauses.map(({ pauseId }) => pauseId),
      })
      return { request: snapshot(next), pauses, deduplicated: false }
    })
  }

  async completeIdentityVerification(
    input: CompletePrivacyIdentityVerificationInput,
  ): Promise<CompletePrivacyIdentityVerificationResult> {
    const validated = this.validateCompleteVerification(input)
    const digest = digestObject({
      requestId: input.requestId,
      operationReference: input.operationReference,
      policy: { ...validated.policy, approvedAt: validated.policy.approvedAt.toISOString() },
      evidence: validated.evidence,
    })
    return runInTransaction(this.pool, async (tx) => {
      const row = await this.lockRequest(tx, input.requestId)
      const replay = await this.verificationReplay(
        tx,
        `privacy-identity-verification-complete:${input.operationReference}`,
        digest,
      )
      if (replay)
        return {
          request: snapshot(row),
          verified: row.identity_verification_state === 'verified',
          deduplicated: true,
        }
      if (
        row.claimed_participant_id === null ||
        row.identity_verification_state !== 'pending' ||
        row.status !== 'identity_verification'
      )
        throw new PrivacyRequestServiceError('PRIVACY_IDENTITY_VERIFICATION_STATE_INVALID')

      const identity = await tx.query(
        `SELECT 1
           FROM channel_identities
          WHERE id = $1 AND participant_id = $2 AND verification_state = 'verified'
          LIMIT 1`,
        [validated.evidence.channelIdentityId, row.claimed_participant_id],
      )
      const verified = identity.rows[0] !== undefined
      const nextStatus: PrivacyRequestStatus = verified ? 'in_review' : 'blocked'
      const nextVerification: PrivacyIdentityVerificationState = verified ? 'verified' : 'failed'
      const reasonCode = verified ? 'PRIVACY_IDENTITY_VERIFIED' : 'PRIVACY_IDENTITY_VERIFICATION_FAILED'
      const updated = await tx.query(
        `UPDATE privacy_requests
            SET identity_verification_state = $2, status = $3,
                verification_policy_reference = $4, verification_method = $5, verified_at = $6,
                updated_at = $7
          WHERE id = $1
          RETURNING ${SELECT_COLUMNS}`,
        [
          input.requestId,
          nextVerification,
          nextStatus,
          verified ? validated.policy.policyVersion : null,
          verified ? validated.policy.method : null,
          verified ? input.occurredAt : null,
          input.occurredAt,
        ],
      )
      const next = updated.rows[0]
      if (next === undefined) throw new Error('privacy verification completion update did not return a row')
      await this.appendVerificationEvent(tx, {
        requestId: input.requestId,
        fromStatus: 'identity_verification',
        toStatus: nextStatus,
        fromVerificationState: 'pending',
        toVerificationState: nextVerification,
        actorReference: input.actorReference,
        reasonCode,
        evidenceReference: validated.evidence.reference,
        correlationId: input.correlationId,
        deduplicationKey: `privacy-identity-verification-complete:${input.operationReference}`,
        occurredAt: input.occurredAt,
        detail: {
          input_digest: digest,
          policy_version: validated.policy.policyVersion,
          policy_approved_by_reference: validated.policy.approvedByReference,
          method: validated.evidence.method,
          outcome: verified ? 'verified' : 'failed',
        },
      })
      await this.appendVerificationAudit(tx, input, reasonCode, verified ? 'success' : 'rejected', {
        policy_version: validated.policy.policyVersion,
        verification_method: validated.evidence.method,
      })
      return { request: snapshot(next), verified, deduplicated: false }
    })
  }

  private validateReviewerAction(input: PrivacyReviewerAction): void {
    if (!input.reviewerAuthorized || input.actorReference.length === 0)
      throw new PrivacyRequestServiceError('PRIVACY_REVIEWER_NOT_AUTHORIZED')
    if (!UUID.test(input.requestId)) throw new PrivacyRequestServiceError('PRIVACY_REQUEST_ID_INVALID')
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))
      throw new PrivacyRequestServiceError('PRIVACY_IDENTITY_VERIFICATION_TIME_INVALID')
    try {
      assertPseudonymousPrivacyReference(input.operationReference, 'PRIVACY_IDENTITY_OPERATION_REFERENCE_INVALID')
      assertPseudonymousPrivacyReference(input.actorReference, 'PRIVACY_IDENTITY_ACTOR_REFERENCE_INVALID')
      assertPseudonymousPrivacyReference(input.correlationId, 'PRIVACY_IDENTITY_CORRELATION_INVALID')
    } catch (error) {
      if (error instanceof PrivacyRequestContractError) throw new PrivacyRequestServiceError(error.reasonCode)
      throw error
    }
  }

  private validateBeginVerification(
    input: BeginPrivacyIdentityVerificationInput,
  ): readonly PrivacyAffectedProcessingScope[] {
    this.validateReviewerAction(input)
    try {
      return parsePrivacyAffectedProcessingScopes(input.affectedScopes)
    } catch (error) {
      if (error instanceof PrivacyRequestContractError) throw new PrivacyRequestServiceError(error.reasonCode)
      throw error
    }
  }

  private validateCompleteVerification(input: CompletePrivacyIdentityVerificationInput): Readonly<{
    policy: PrivacyIdentityVerificationPolicy
    evidence: PrivacyIdentityVerificationEvidence
  }> {
    this.validateReviewerAction(input)
    try {
      const policy = parsePrivacyIdentityVerificationPolicy(input.policy)
      const evidence = parsePrivacyIdentityVerificationEvidence(input.evidence)
      if (policy.approvedAt.getTime() > input.occurredAt.getTime())
        throw new PrivacyRequestContractError('PRIVACY_IDENTITY_POLICY_APPROVAL_IN_FUTURE')
      return { policy, evidence }
    } catch (error) {
      if (error instanceof PrivacyRequestContractError) throw new PrivacyRequestServiceError(error.reasonCode)
      throw error
    }
  }

  private async lockRequest(tx: DbTransaction, requestId: string): Promise<Record<string, unknown>> {
    const result = await tx.query(`SELECT ${SELECT_COLUMNS} FROM privacy_requests WHERE id = $1 FOR UPDATE`, [
      requestId,
    ])
    const row = result.rows[0]
    if (row === undefined) throw new PrivacyRequestServiceError('PRIVACY_REQUEST_NOT_FOUND')
    return row
  }

  private async verificationReplay(tx: DbTransaction, deduplicationKey: string, digest: string): Promise<boolean> {
    const existing = await tx.query(
      `SELECT detail->>'input_digest' AS input_digest
         FROM privacy_request_events
        WHERE deduplication_key = $1`,
      [deduplicationKey],
    )
    const row = existing.rows[0]
    if (row === undefined) return false
    if (row.input_digest !== digest)
      throw new PrivacyRequestServiceError('PRIVACY_IDENTITY_OPERATION_REFERENCE_CONFLICT')
    return true
  }

  private async assertAffectedScopes(
    tx: DbTransaction,
    claimedParticipantId: string,
    requestScope: PrivacyRequestScope,
    scopes: readonly PrivacyAffectedProcessingScope[],
  ): Promise<void> {
    const fail = (): never => {
      throw new PrivacyRequestServiceError('PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID')
    }
    if (
      scopes.some(
        (scope) =>
          (scope.scope === 'participant' || scope.scope === 'participant_campaign') &&
          scope.participantId !== claimedParticipantId,
      )
    )
      fail()

    let expected: readonly PrivacyAffectedProcessingScope[]
    if (requestScope.state === 'unconfirmed') {
      expected = [{ scope: 'participant', participantId: claimedParticipantId }]
    } else {
      const parsedCampaignIds = requestScope.campaignReferences.map((reference) =>
        privacyReferenceId(reference, 'campaign'),
      )
      const parsedWorkflowIds = requestScope.workflowReferences.map((reference) =>
        privacyReferenceId(reference, 'workflow'),
      )
      if (parsedCampaignIds.some((id) => id === null) || parsedWorkflowIds.some((id) => id === null)) fail()
      const campaignIds = parsedCampaignIds.filter((id): id is string => id !== null)
      const workflowIds = parsedWorkflowIds.filter((id): id is string => id !== null)
      expected = [
        ...campaignIds.map((campaignId): PrivacyAffectedProcessingScope => ({
          scope: 'participant_campaign',
          participantId: claimedParticipantId,
          campaignId,
        })),
        ...workflowIds.map((workflowId): PrivacyAffectedProcessingScope => ({ scope: 'workflow', workflowId })),
      ]
      if (expected.length === 0) expected = [{ scope: 'participant', participantId: claimedParticipantId }]
    }
    const keys = (values: readonly PrivacyAffectedProcessingScope[]): readonly string[] =>
      values.map((value) => JSON.stringify(value)).sort()
    if (JSON.stringify(keys(scopes)) !== JSON.stringify(keys(expected))) fail()

    const campaignIds = scopes
      .filter(
        (scope): scope is Extract<PrivacyAffectedProcessingScope, { scope: 'participant_campaign' }> =>
          scope.scope === 'participant_campaign',
      )
      .map((scope) => scope.campaignId)
    if (campaignIds.length > 0) {
      const campaigns = await tx.query(`SELECT id FROM campaigns WHERE id = ANY($1::uuid[])`, [campaignIds])
      if (campaigns.rows.length !== campaignIds.length) fail()
    }
    const workflowIds = scopes
      .filter(
        (scope): scope is Extract<PrivacyAffectedProcessingScope, { scope: 'workflow' }> => scope.scope === 'workflow',
      )
      .map((scope) => scope.workflowId)
    if (workflowIds.length > 0) {
      const workflows = await tx.query(
        `SELECT id FROM workflow_instances WHERE id = ANY($1::uuid[]) AND participant_id = $2`,
        [workflowIds, claimedParticipantId],
      )
      if (workflows.rows.length !== workflowIds.length) fail()
    }
  }

  private async ensurePrivacyPause(
    tx: DbTransaction,
    scope: PrivacyAffectedProcessingScope,
    input: PrivacyReviewerAction,
  ): Promise<string> {
    const participantId =
      scope.scope === 'participant' || scope.scope === 'participant_campaign' ? scope.participantId : null
    const campaignId = scope.scope === 'participant_campaign' ? scope.campaignId : null
    const workflowId = scope.scope === 'workflow' ? scope.workflowId : null
    const inserted = await tx.query(
      `INSERT INTO automation_pauses (
         scope, kind, campaign_id, workflow_type, participant_id, workflow_id, reason_code,
         activated_by_type, activated_by_id, activated_at, created_at, updated_at
       ) VALUES ($1,'privacy_request',$2,null,$3,$4,'PRIVACY_REQUEST_AFFECTED_PROCESSING',
                 'operator',$5,$6,$6,$6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [scope.scope, campaignId, participantId, workflowId, input.actorReference, input.occurredAt],
    )
    const insertedId = inserted.rows[0]?.id
    if (typeof insertedId === 'string') return insertedId
    const existing = await tx.query(
      `SELECT id
         FROM automation_pauses
        WHERE kind = 'privacy_request' AND scope = $1 AND deactivated_at IS NULL
          AND campaign_id IS NOT DISTINCT FROM $2::uuid
          AND participant_id IS NOT DISTINCT FROM $3::uuid
          AND workflow_id IS NOT DISTINCT FROM $4::uuid
        FOR SHARE`,
      [scope.scope, campaignId, participantId, workflowId],
    )
    const existingId = existing.rows[0]?.id
    if (typeof existingId !== 'string') throw new Error('privacy pause conflict was not visible')
    return existingId
  }

  private async pauseSnapshots(
    tx: DbTransaction,
    requestId: string,
  ): Promise<readonly PrivacyProcessingPauseSnapshot[]> {
    const result = await tx.query(
      `SELECT pause_id, scope, participant_id, campaign_id, workflow_id
         FROM privacy_request_processing_pauses
        WHERE request_id = $1
        ORDER BY created_at, id`,
      [requestId],
    )
    return result.rows.map((row): PrivacyProcessingPauseSnapshot => {
      if (typeof row.pause_id !== 'string') throw new Error('privacy pause link returned invalid pause id')
      if (row.scope === 'participant' && typeof row.participant_id === 'string')
        return { pauseId: row.pause_id, scope: 'participant', participantId: row.participant_id }
      if (
        row.scope === 'participant_campaign' &&
        typeof row.participant_id === 'string' &&
        typeof row.campaign_id === 'string'
      )
        return {
          pauseId: row.pause_id,
          scope: 'participant_campaign',
          participantId: row.participant_id,
          campaignId: row.campaign_id,
        }
      if (row.scope === 'workflow' && typeof row.workflow_id === 'string')
        return { pauseId: row.pause_id, scope: 'workflow', workflowId: row.workflow_id }
      throw new Error('privacy pause link returned an incoherent target')
    })
  }

  private appendVerificationEvent(
    tx: DbTransaction,
    input: Readonly<{
      requestId: string
      fromStatus: PrivacyRequestStatus
      toStatus: PrivacyRequestStatus
      fromVerificationState: PrivacyIdentityVerificationState
      toVerificationState: PrivacyIdentityVerificationState
      actorReference: string
      reasonCode: string
      evidenceReference: string
      correlationId: string
      detail: Readonly<Record<string, unknown>>
      deduplicationKey: string
      occurredAt: Date
    }>,
  ): Promise<unknown> {
    return tx.query(
      `INSERT INTO privacy_request_events (
         request_id, event_type, from_status, to_status, from_verification_state,
         to_verification_state, actor_type, actor_reference, reason_code, evidence_reference,
         correlation_id, detail, deduplication_key, occurred_at
       ) VALUES ($1,'identity_verification_changed',$2,$3,$4,$5,'operator',$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [
        input.requestId,
        input.fromStatus,
        input.toStatus,
        input.fromVerificationState,
        input.toVerificationState,
        input.actorReference,
        input.reasonCode,
        input.evidenceReference,
        input.correlationId,
        JSON.stringify(input.detail),
        input.deduplicationKey,
        input.occurredAt,
      ],
    )
  }

  private appendVerificationAudit(
    tx: DbTransaction,
    input: PrivacyReviewerAction,
    reason: string,
    result: 'success' | 'rejected',
    detail: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return tx.query(
      `INSERT INTO audit_logs (
         actor_type, actor_id, action, target_type, target_id, result, reason,
         correlation_id, protected_action, detail, occurred_at
       ) VALUES ('operator',$1,'PRIVACY_IDENTITY_VERIFICATION','privacy_request',$2,$3,$4,$5,'yes',$6::jsonb,$7)`,
      [
        input.actorReference,
        input.requestId,
        result,
        reason,
        input.correlationId,
        JSON.stringify(detail),
        input.occurredAt,
      ],
    )
  }

  private validateIntake(input: IntakePrivacyRequestInput): Readonly<{
    scope: PrivacyRequestScope
    evidence: PrivacyRequestIntakeEvidence
    digest: string
  }> {
    if (!input.sourceAuthorized) throw new PrivacyRequestServiceError('PRIVACY_REQUEST_SOURCE_NOT_AUTHORIZED')
    if (PRIVACY_REQUEST_TYPES.find((candidate) => candidate === input.requestType) === undefined)
      throw new PrivacyRequestServiceError('PRIVACY_REQUEST_TYPE_INVALID')
    if (ACTOR_TYPES.find((candidate) => candidate === input.actorType) === undefined)
      throw new PrivacyRequestServiceError('PRIVACY_REQUEST_ACTOR_TYPE_INVALID')
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))
      throw new PrivacyRequestServiceError('PRIVACY_REQUEST_OCCURRED_AT_INVALID')
    if (input.claimedParticipantId !== null && !UUID.test(input.claimedParticipantId))
      throw new PrivacyRequestServiceError('PRIVACY_REQUEST_CLAIMED_PARTICIPANT_INVALID')
    try {
      assertPseudonymousPrivacyReference(input.requestReference, 'PRIVACY_REQUEST_REFERENCE_INVALID')
      assertPseudonymousPrivacyReference(input.requesterReference, 'PRIVACY_REQUEST_REQUESTER_REFERENCE_INVALID')
      assertPseudonymousPrivacyReference(input.actorReference, 'PRIVACY_REQUEST_ACTOR_REFERENCE_INVALID')
      assertPseudonymousPrivacyReference(input.correlationId, 'PRIVACY_REQUEST_CORRELATION_INVALID')
      if (input.assigneeId !== null)
        assertPseudonymousPrivacyReference(input.assigneeId, 'PRIVACY_REQUEST_ASSIGNEE_INVALID')
      const scope = parsePrivacyRequestScope(input.scope)
      const evidence = parsePrivacyRequestIntakeEvidence(input.evidence)
      if (input.deadlinePolicy !== null) {
        assertPseudonymousPrivacyReference(
          input.deadlinePolicy.reference,
          'PRIVACY_REQUEST_DEADLINE_POLICY_REFERENCE_INVALID',
        )
        if (
          !(input.deadlinePolicy.deadlineAt instanceof Date) ||
          Number.isNaN(input.deadlinePolicy.deadlineAt.getTime()) ||
          input.deadlinePolicy.deadlineAt.getTime() < input.occurredAt.getTime()
        )
          throw new PrivacyRequestServiceError('PRIVACY_REQUEST_DEADLINE_INVALID')
      }
      return { scope, evidence, digest: digestInput(input, scope, evidence) }
    } catch (error) {
      if (error instanceof PrivacyRequestContractError) throw new PrivacyRequestServiceError(error.reasonCode)
      throw error
    }
  }

  private async intakeInTransaction(
    tx: DbTransaction,
    input: IntakePrivacyRequestInput,
    validated: Readonly<{
      scope: PrivacyRequestScope
      evidence: PrivacyRequestIntakeEvidence
      digest: string
    }>,
  ): Promise<PrivacyRequestIntakeResult> {
    if (input.claimedParticipantId !== null) {
      const participant = await tx.query(`SELECT id FROM participants WHERE id = $1 FOR SHARE`, [
        input.claimedParticipantId,
      ])
      if (participant.rows[0] === undefined)
        throw new PrivacyRequestServiceError('PRIVACY_REQUEST_CLAIMED_PARTICIPANT_NOT_FOUND')
    }

    const inserted = await tx.query(
      `INSERT INTO privacy_requests (
         request_reference, requester_reference, claimed_participant_id, request_type,
         identity_verification_state, scope_version, scope, status, deadline_policy_reference,
         deadline_at, assignee_id, input_digest, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'unverified',$5,$6::jsonb,'received',$7,$8,$9,$10,$11,$11)
       ON CONFLICT (request_reference) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.requestReference,
        input.requesterReference,
        input.claimedParticipantId,
        input.requestType,
        validated.scope.schemaVersion,
        JSON.stringify(validated.scope),
        input.deadlinePolicy?.reference ?? null,
        input.deadlinePolicy?.deadlineAt ?? null,
        input.assigneeId,
        validated.digest,
        input.occurredAt,
      ],
    )

    const newRow = inserted.rows[0]
    if (newRow === undefined) {
      const existing = await tx.query(`SELECT ${SELECT_COLUMNS} FROM privacy_requests WHERE request_reference = $1`, [
        input.requestReference,
      ])
      const row = existing.rows[0]
      if (row === undefined) throw new Error('privacy request conflict was not visible')
      if (row.input_digest !== validated.digest)
        throw new PrivacyRequestServiceError('PRIVACY_REQUEST_REFERENCE_CONFLICT')
      return { request: snapshot(row), deduplicated: true }
    }

    const request = snapshot(newRow)
    const detail = {
      scope: validated.scope,
      evidence_schema_version: validated.evidence.schemaVersion,
      evidence_channel: validated.evidence.channel,
      deadline_state: input.deadlinePolicy === null ? 'policy_missing' : 'policy_applied',
      deadline_policy_reference: input.deadlinePolicy?.reference ?? null,
      deadline_at: input.deadlinePolicy?.deadlineAt.toISOString() ?? null,
      assignee_reference: input.assigneeId,
    }
    await tx.query(
      `INSERT INTO privacy_request_events (
         request_id, event_type, from_status, to_status, from_verification_state,
         to_verification_state, actor_type, actor_reference, reason_code, evidence_reference,
         correlation_id, detail, deduplication_key, occurred_at
       ) VALUES ($1,'intake_recorded',null,'received',null,'unverified',$2,$3,
                 'PRIVACY_REQUEST_INTAKE_RECORDED',$4,$5,$6::jsonb,$7,$8)`,
      [
        request.id,
        input.actorType,
        input.actorReference,
        validated.evidence.reference,
        input.correlationId,
        JSON.stringify(detail),
        `privacy-request-intake:${input.requestReference}`,
        input.occurredAt,
      ],
    )
    await tx.query(
      `INSERT INTO audit_logs (
         actor_type, actor_id, action, target_type, target_id, result, reason,
         correlation_id, protected_action, detail, occurred_at
       ) VALUES ($1,$2,'PRIVACY_REQUEST_RECEIVED','privacy_request',$3,'success',
                 'PRIVACY_REQUEST_INTAKE_RECORDED',$4,'yes',$5::jsonb,$6)`,
      [
        input.actorType,
        input.actorReference,
        request.id,
        input.correlationId,
        JSON.stringify({
          request_reference: input.requestReference,
          request_type: input.requestType,
          scope_version: validated.scope.schemaVersion,
          scope_state: validated.scope.state,
          evidence_reference: validated.evidence.reference,
          deadline_policy_reference: input.deadlinePolicy?.reference ?? null,
        }),
        input.occurredAt,
      ],
    )
    return { request, deduplicated: false }
  }
}
