import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import {
  PrivacyRequestContractError,
  PRIVACY_DATA_CLASSES,
  assertPseudonymousPrivacyReference,
  type PrivacyDataClass,
} from './privacy-request-contract.js'
import {
  PrivacyLegalHoldScope,
  PrivacyRetentionSchedule,
  PrivacyRetentionSubject,
  parsePrivacyLegalHoldScope,
  parsePrivacyRetentionSchedule,
  parsePrivacyRetentionSubject,
  type PrivacyRetentionDisposition,
} from './privacy-retention-contract.js'

export const PRIVACY_RETENTION_REASON = {
  SCHEDULE_PUBLISHED: 'PRIVACY_RETENTION_SCHEDULE_PUBLISHED',
  POLICY_MISSING: 'PRIVACY_RETENTION_POLICY_MISSING',
  RETENTION_ACTIVE: 'PRIVACY_RETENTION_ACTIVE',
  LEGAL_HOLD_ACTIVE: 'PRIVACY_LEGAL_HOLD_ACTIVE',
  DELETION_ELIGIBLE: 'PRIVACY_DELETION_ELIGIBLE',
  LEGAL_HOLD_APPLIED: 'PRIVACY_LEGAL_HOLD_APPLIED',
  LEGAL_HOLD_RELEASED: 'PRIVACY_LEGAL_HOLD_RELEASED',
} as const

type PrivacyReviewerAction = Readonly<{
  actorReference: string
  privacyReviewerAuthorized: boolean
  correlationId: string
  occurredAt: Date
}>

export type PublishPrivacyRetentionScheduleInput = PrivacyReviewerAction &
  Readonly<{ schedule: PrivacyRetentionSchedule }>

export type ApplyPrivacyLegalHoldInput = PrivacyReviewerAction &
  Readonly<{
    holdReference: string
    scope: PrivacyLegalHoldScope
    reasonReference: string
  }>

export type ReleasePrivacyLegalHoldInput = PrivacyReviewerAction &
  Readonly<{
    holdReference: string
    operationReference: string
    reasonReference: string
  }>

export type EvaluatePrivacyDeletionEligibilityInput = Omit<PrivacyReviewerAction, 'occurredAt'> &
  Readonly<{
    evaluationReference: string
    subject: PrivacyRetentionSubject
    evaluatedAt: Date
  }>

export type PrivacyRetentionScheduleSnapshot = Readonly<{
  id: string
  schedule: PrivacyRetentionSchedule
  publishedByReference: string
  createdAt: Date
}>

export type PrivacyLegalHoldSnapshot = Readonly<{
  id: string
  holdReference: string
  scope: PrivacyLegalHoldScope
  reasonReference: string
  appliedByReference: string
  appliedAt: Date
  releasedAt: Date | null
}>

export type PrivacyDeletionEligibilityDecision =
  | Readonly<{
      decision: 'legal_hold_active'
      reasonCode: typeof PRIVACY_RETENTION_REASON.LEGAL_HOLD_ACTIVE
      policyVersion: null
      eligibleAt: null
      disposition: null
      activeHoldReferences: readonly string[]
    }>
  | Readonly<{
      decision: 'policy_missing'
      reasonCode: typeof PRIVACY_RETENTION_REASON.POLICY_MISSING
      policyVersion: null
      eligibleAt: null
      disposition: null
      activeHoldReferences: readonly []
    }>
  | Readonly<{
      decision: 'retention_active' | 'eligible'
      reasonCode: typeof PRIVACY_RETENTION_REASON.RETENTION_ACTIVE | typeof PRIVACY_RETENTION_REASON.DELETION_ELIGIBLE
      policyVersion: string
      eligibleAt: Date
      disposition: PrivacyRetentionDisposition
      activeHoldReferences: readonly []
    }>

export type PrivacyDeletionEligibilityResult = Readonly<{
  id: string
  evaluationReference: string
  subject: PrivacyRetentionSubject
  evaluatedAt: Date
  result: PrivacyDeletionEligibilityDecision
  deduplicated: boolean
}>

export class PrivacyRetentionServiceError extends Error {
  override readonly name = 'PrivacyRetentionServiceError'
  constructor(readonly reasonCode: string) {
    super(`privacy retention action rejected: ${reasonCode}`)
  }
}

const DAY_MS = 86_400_000

const digestObject = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const canonicalScheduleDigest = (schedule: PrivacyRetentionSchedule): string =>
  digestObject({
    ...schedule,
    approvedAt: schedule.approvedAt.toISOString(),
    effectiveFrom: schedule.effectiveFrom.toISOString(),
  })

const rowText = (row: Record<string, unknown>, field: string): string => {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`privacy retention query returned invalid ${field}`)
  return value
}

const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const rowDate = (row: Record<string, unknown>, field: string): Date => {
  const value = row[field]
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new Error(`privacy retention query returned invalid ${field}`)
  return value
}

const nullableDate = (value: unknown): Date | null => {
  if (value === null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error('privacy retention query returned invalid nullable date')
}

const rowDataClass = (row: Record<string, unknown>, field: string): PrivacyDataClass => {
  const value = row[field]
  const found = PRIVACY_DATA_CLASSES.find((candidate) => candidate === value)
  if (found === undefined) throw new Error(`privacy retention query returned invalid ${field}`)
  return found
}

@Injectable()
export class PrivacyRetentionService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async publishSchedule(
    input: PublishPrivacyRetentionScheduleInput,
  ): Promise<Readonly<{ schedule: PrivacyRetentionScheduleSnapshot; deduplicated: boolean }>> {
    this.validateReviewer(input)
    const schedule = this.parseSchedule(input.schedule)
    if (input.occurredAt.getTime() < schedule.approvedAt.getTime())
      throw new PrivacyRetentionServiceError('PRIVACY_RETENTION_PUBLICATION_BEFORE_APPROVAL')
    const digest = canonicalScheduleDigest(schedule)
    return runInTransaction(this.pool, async (tx) => {
      // Serialize registry publication even when the table is empty. A row lock alone cannot stop
      // two concurrent first versions from both observing no predecessor and creating a fork.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('privacy_retention_schedule_registry'))`)
      const existing = await tx.query(
        `SELECT id, input_digest FROM privacy_retention_schedules WHERE policy_version = $1 FOR SHARE`,
        [schedule.policyVersion],
      )
      if (existing.rows[0] !== undefined) {
        if (existing.rows[0].input_digest !== digest)
          throw new PrivacyRetentionServiceError('PRIVACY_RETENTION_POLICY_VERSION_CONFLICT')
        return {
          schedule: await this.scheduleSnapshot(tx, rowText(existing.rows[0], 'id')),
          deduplicated: true,
        }
      }

      const latest = await tx.query(
        `SELECT policy_version, effective_from
           FROM privacy_retention_schedules
          ORDER BY effective_from DESC, created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
      )
      const current = latest.rows[0]
      if (current === undefined) {
        if (schedule.supersedesPolicyVersion !== null)
          throw new PrivacyRetentionServiceError('PRIVACY_RETENTION_SUPERSEDES_MISMATCH')
      } else if (
        schedule.supersedesPolicyVersion !== current.policy_version ||
        schedule.effectiveFrom.getTime() <= rowDate(current, 'effective_from').getTime()
      ) {
        throw new PrivacyRetentionServiceError('PRIVACY_RETENTION_SUPERSEDES_MISMATCH')
      }

      const inserted = await tx.query(
        `INSERT INTO privacy_retention_schedules (
           schema_version, policy_version, supersedes_policy_version,
           company_approval_reference, legal_approval_reference, approved_at, effective_from,
           input_digest, published_by_reference, correlation_id, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          schedule.schemaVersion,
          schedule.policyVersion,
          schedule.supersedesPolicyVersion,
          schedule.companyApprovalReference,
          schedule.legalApprovalReference,
          schedule.approvedAt,
          schedule.effectiveFrom,
          digest,
          input.actorReference,
          input.correlationId,
          input.occurredAt,
        ],
      )
      const scheduleId = rowText(inserted.rows[0] ?? {}, 'id')
      for (const entry of schedule.entries) {
        await tx.query(
          `INSERT INTO privacy_retention_schedule_entries (
             schedule_id, data_class, retention_days, disposition, created_at
           ) VALUES ($1,$2,$3,$4,$5)`,
          [scheduleId, entry.dataClass, entry.retentionDays, entry.disposition, input.occurredAt],
        )
      }
      await this.appendAudit(tx, input, 'PRIVACY_RETENTION_SCHEDULE_PUBLISHED', scheduleId, 'success', {
        policy_version: schedule.policyVersion,
        supersedes_policy_version: schedule.supersedesPolicyVersion,
        effective_from: schedule.effectiveFrom.toISOString(),
        company_approval_reference: schedule.companyApprovalReference,
        legal_approval_reference: schedule.legalApprovalReference,
        data_class_count: schedule.entries.length,
      })
      return { schedule: await this.scheduleSnapshot(tx, scheduleId), deduplicated: false }
    })
  }

  async applyLegalHold(
    input: ApplyPrivacyLegalHoldInput,
  ): Promise<Readonly<{ hold: PrivacyLegalHoldSnapshot; deduplicated: boolean }>> {
    this.validateReviewer(input)
    const scope = this.parseHoldScope(input.scope)
    this.validateReferences([
      [input.holdReference, 'PRIVACY_LEGAL_HOLD_REFERENCE_INVALID'],
      [input.reasonReference, 'PRIVACY_LEGAL_HOLD_REASON_REFERENCE_INVALID'],
    ])
    const digest = digestObject({ holdReference: input.holdReference, scope, reasonReference: input.reasonReference })
    return runInTransaction(this.pool, async (tx) => {
      const participant = await tx.query(`SELECT id FROM participants WHERE id = $1 FOR SHARE`, [scope.participantId])
      if (participant.rows[0] === undefined)
        throw new PrivacyRetentionServiceError('PRIVACY_LEGAL_HOLD_PARTICIPANT_NOT_FOUND')
      const inserted = await tx.query(
        `INSERT INTO privacy_legal_holds (
           hold_reference, scope, participant_id, data_class, record_reference, reason_reference,
           applied_by_reference, correlation_id, input_digest, applied_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
         ON CONFLICT (hold_reference) DO NOTHING
         RETURNING id`,
        [
          input.holdReference,
          scope.scope,
          scope.participantId,
          'dataClass' in scope ? scope.dataClass : null,
          'recordReference' in scope ? scope.recordReference : null,
          input.reasonReference,
          input.actorReference,
          input.correlationId,
          digest,
          input.occurredAt,
        ],
      )
      const newRow = inserted.rows[0]
      if (newRow === undefined) {
        const existing = await tx.query(
          `SELECT id, input_digest FROM privacy_legal_holds WHERE hold_reference = $1 FOR SHARE`,
          [input.holdReference],
        )
        const row = existing.rows[0]
        if (row === undefined) throw new Error('privacy legal hold conflict was not visible')
        if (row.input_digest !== digest) throw new PrivacyRetentionServiceError('PRIVACY_LEGAL_HOLD_REFERENCE_CONFLICT')
        return { hold: await this.holdSnapshot(tx, rowText(row, 'id')), deduplicated: true }
      }
      const holdId = rowText(newRow, 'id')
      await tx.query(
        `INSERT INTO privacy_legal_hold_events (
           hold_id, event_type, actor_reference, reason_reference, correlation_id,
           deduplication_key, input_digest, occurred_at
         ) VALUES ($1,'applied',$2,$3,$4,$5,$6,$7)`,
        [
          holdId,
          input.actorReference,
          input.reasonReference,
          input.correlationId,
          `privacy-legal-hold-apply:${input.holdReference}`,
          digest,
          input.occurredAt,
        ],
      )
      await this.appendAudit(tx, input, 'PRIVACY_LEGAL_HOLD_APPLIED', holdId, 'success', {
        hold_reference: input.holdReference,
        scope: scope.scope,
        data_class: 'dataClass' in scope ? scope.dataClass : null,
        record_reference: 'recordReference' in scope ? scope.recordReference : null,
        reason_reference: input.reasonReference,
      })
      return { hold: await this.holdSnapshot(tx, holdId), deduplicated: false }
    })
  }

  async releaseLegalHold(
    input: ReleasePrivacyLegalHoldInput,
  ): Promise<Readonly<{ hold: PrivacyLegalHoldSnapshot; deduplicated: boolean }>> {
    this.validateReviewer(input)
    this.validateReferences([
      [input.holdReference, 'PRIVACY_LEGAL_HOLD_REFERENCE_INVALID'],
      [input.operationReference, 'PRIVACY_LEGAL_HOLD_OPERATION_REFERENCE_INVALID'],
      [input.reasonReference, 'PRIVACY_LEGAL_HOLD_REASON_REFERENCE_INVALID'],
    ])
    const digest = digestObject({
      holdReference: input.holdReference,
      operationReference: input.operationReference,
      reasonReference: input.reasonReference,
    })
    return runInTransaction(this.pool, async (tx) => {
      const current = await tx.query(
        `SELECT id, applied_at FROM privacy_legal_holds WHERE hold_reference = $1 FOR UPDATE`,
        [input.holdReference],
      )
      const row = current.rows[0]
      if (row === undefined) throw new PrivacyRetentionServiceError('PRIVACY_LEGAL_HOLD_NOT_FOUND')
      const holdId = rowText(row, 'id')
      const replay = await tx.query(
        `SELECT hold_id, input_digest FROM privacy_legal_hold_events WHERE deduplication_key = $1`,
        [`privacy-legal-hold-release:${input.operationReference}`],
      )
      if (replay.rows[0] !== undefined) {
        if (replay.rows[0].hold_id !== holdId || replay.rows[0].input_digest !== digest)
          throw new PrivacyRetentionServiceError('PRIVACY_LEGAL_HOLD_OPERATION_REFERENCE_CONFLICT')
        return { hold: await this.holdSnapshot(tx, holdId), deduplicated: true }
      }
      const released = await tx.query(
        `SELECT 1 FROM privacy_legal_hold_events WHERE hold_id = $1 AND event_type = 'released'`,
        [holdId],
      )
      if (released.rows[0] !== undefined) throw new PrivacyRetentionServiceError('PRIVACY_LEGAL_HOLD_ALREADY_RELEASED')
      if (input.occurredAt.getTime() < rowDate(row, 'applied_at').getTime())
        throw new PrivacyRetentionServiceError('PRIVACY_LEGAL_HOLD_RELEASE_TIME_INVALID')
      await tx.query(
        `INSERT INTO privacy_legal_hold_events (
           hold_id, event_type, actor_reference, reason_reference, correlation_id,
           deduplication_key, input_digest, occurred_at
         ) VALUES ($1,'released',$2,$3,$4,$5,$6,$7)`,
        [
          holdId,
          input.actorReference,
          input.reasonReference,
          input.correlationId,
          `privacy-legal-hold-release:${input.operationReference}`,
          digest,
          input.occurredAt,
        ],
      )
      await this.appendAudit(tx, input, 'PRIVACY_LEGAL_HOLD_RELEASED', holdId, 'success', {
        hold_reference: input.holdReference,
        operation_reference: input.operationReference,
        reason_reference: input.reasonReference,
      })
      return { hold: await this.holdSnapshot(tx, holdId), deduplicated: false }
    })
  }

  async evaluateDeletionEligibility(
    input: EvaluatePrivacyDeletionEligibilityInput,
  ): Promise<PrivacyDeletionEligibilityResult> {
    this.validateReviewer({ ...input, occurredAt: input.evaluatedAt })
    this.validateReferences([[input.evaluationReference, 'PRIVACY_ELIGIBILITY_REFERENCE_INVALID']])
    const subject = this.parseSubject(input.subject)
    if (subject.retentionAnchorAt.getTime() > input.evaluatedAt.getTime())
      throw new PrivacyRetentionServiceError('PRIVACY_RETENTION_ANCHOR_IN_FUTURE')
    const digest = digestObject({
      evaluationReference: input.evaluationReference,
      subject: { ...subject, retentionAnchorAt: subject.retentionAnchorAt.toISOString() },
      evaluatedAt: input.evaluatedAt.toISOString(),
    })
    return runInTransaction(this.pool, async (tx) => {
      const existing = await tx.query(
        `SELECT id, input_digest FROM privacy_deletion_eligibility_evaluations
          WHERE evaluation_reference = $1 FOR SHARE`,
        [input.evaluationReference],
      )
      if (existing.rows[0] !== undefined) {
        if (existing.rows[0].input_digest !== digest)
          throw new PrivacyRetentionServiceError('PRIVACY_ELIGIBILITY_REFERENCE_CONFLICT')
        const replay = await this.eligibilitySnapshot(tx, rowText(existing.rows[0], 'id'), subject)
        return { ...replay, deduplicated: true }
      }
      const participant = await tx.query(`SELECT id FROM participants WHERE id = $1 FOR SHARE`, [subject.participantId])
      if (participant.rows[0] === undefined)
        throw new PrivacyRetentionServiceError('PRIVACY_RETENTION_PARTICIPANT_NOT_FOUND')

      const activeHolds = await tx.query(
        `SELECT h.id, h.hold_reference
           FROM privacy_legal_holds h
          WHERE h.participant_id = $1
            AND h.applied_at <= $4
            AND (
              h.scope = 'participant'
              OR (h.scope = 'participant_data_class' AND h.data_class = $2)
              OR (h.scope = 'record' AND h.data_class = $2 AND h.record_reference = $3)
            )
            AND NOT EXISTS (
              SELECT 1 FROM privacy_legal_hold_events event
               WHERE event.hold_id = h.id AND event.event_type = 'released' AND event.occurred_at <= $4
            )
          ORDER BY h.applied_at, h.id
          FOR SHARE`,
        [subject.participantId, subject.dataClass, subject.recordReference, input.evaluatedAt],
      )
      const holdReferences = activeHolds.rows.map((row) => rowText(row, 'hold_reference'))
      let scheduleId: string | null = null
      let eligibleAt: Date | null = null
      let disposition: PrivacyRetentionDisposition | null = null
      let decision: 'legal_hold_active' | 'policy_missing' | 'retention_active' | 'eligible'
      if (holdReferences.length > 0) {
        decision = 'legal_hold_active'
      } else {
        const schedule = await tx.query(
          `SELECT schedule.id, schedule.policy_version, entry.retention_days, entry.disposition
             FROM privacy_retention_schedules schedule
             JOIN privacy_retention_schedule_entries entry ON entry.schedule_id = schedule.id
            WHERE schedule.effective_from <= $1 AND entry.data_class = $2
            ORDER BY schedule.effective_from DESC, schedule.created_at DESC, schedule.id DESC
            LIMIT 1
            FOR SHARE OF schedule, entry`,
          [input.evaluatedAt, subject.dataClass],
        )
        const policy = schedule.rows[0]
        if (policy === undefined) {
          decision = 'policy_missing'
        } else {
          scheduleId = rowText(policy, 'id')
          const retentionDays = policy.retention_days
          if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays))
            throw new Error('privacy retention query returned invalid retention_days')
          if (policy.disposition !== 'delete' && policy.disposition !== 'irreversible_mask')
            throw new Error('privacy retention query returned invalid disposition')
          disposition = policy.disposition
          eligibleAt = new Date(subject.retentionAnchorAt.getTime() + retentionDays * DAY_MS)
          decision = input.evaluatedAt.getTime() >= eligibleAt.getTime() ? 'eligible' : 'retention_active'
        }
      }
      const inserted = await tx.query(
        `INSERT INTO privacy_deletion_eligibility_evaluations (
           evaluation_reference, participant_id, data_class, record_reference, retention_anchor_at,
           decision, schedule_id, eligible_at, active_hold_references, input_digest,
           actor_reference, correlation_id, evaluated_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$13)
         RETURNING id`,
        [
          input.evaluationReference,
          subject.participantId,
          subject.dataClass,
          subject.recordReference,
          subject.retentionAnchorAt,
          decision,
          scheduleId,
          eligibleAt,
          JSON.stringify(holdReferences),
          digest,
          input.actorReference,
          input.correlationId,
          input.evaluatedAt,
        ],
      )
      const evaluationId = rowText(inserted.rows[0] ?? {}, 'id')
      await this.appendAudit(
        tx,
        { ...input, occurredAt: input.evaluatedAt },
        'PRIVACY_DELETION_ELIGIBILITY_EVALUATED',
        evaluationId,
        'success',
        {
          evaluation_reference: input.evaluationReference,
          data_class: subject.dataClass,
          record_reference: subject.recordReference,
          decision,
          schedule_id: scheduleId,
          active_hold_references: holdReferences,
          eligible_at: eligibleAt?.toISOString() ?? null,
          disposition,
          deletion_executed: false,
        },
      )
      const result = await this.eligibilitySnapshot(tx, evaluationId, subject)
      return { ...result, deduplicated: false }
    })
  }

  private validateReviewer(input: PrivacyReviewerAction): void {
    if (!input.privacyReviewerAuthorized) throw new PrivacyRetentionServiceError('PRIVACY_REVIEWER_NOT_AUTHORIZED')
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))
      throw new PrivacyRetentionServiceError('PRIVACY_RETENTION_TIME_INVALID')
    this.validateReferences([
      [input.actorReference, 'PRIVACY_RETENTION_ACTOR_REFERENCE_INVALID'],
      [input.correlationId, 'PRIVACY_RETENTION_CORRELATION_INVALID'],
    ])
  }

  private validateReferences(values: readonly (readonly [string, string])[]): void {
    try {
      for (const [value, reasonCode] of values) assertPseudonymousPrivacyReference(value, reasonCode)
    } catch (error) {
      if (error instanceof PrivacyRequestContractError) throw new PrivacyRetentionServiceError(error.reasonCode)
      throw error
    }
  }

  private parseSchedule(value: unknown): PrivacyRetentionSchedule {
    try {
      return parsePrivacyRetentionSchedule(value)
    } catch (error) {
      if (error instanceof PrivacyRequestContractError) throw new PrivacyRetentionServiceError(error.reasonCode)
      throw error
    }
  }

  private parseHoldScope(value: unknown): PrivacyLegalHoldScope {
    try {
      return parsePrivacyLegalHoldScope(value)
    } catch (error) {
      if (error instanceof PrivacyRequestContractError) throw new PrivacyRetentionServiceError(error.reasonCode)
      throw error
    }
  }

  private parseSubject(value: unknown): PrivacyRetentionSubject {
    try {
      return parsePrivacyRetentionSubject(value)
    } catch (error) {
      if (error instanceof PrivacyRequestContractError) throw new PrivacyRetentionServiceError(error.reasonCode)
      throw error
    }
  }

  private async scheduleSnapshot(tx: DbTransaction, scheduleId: string): Promise<PrivacyRetentionScheduleSnapshot> {
    const scheduleResult = await tx.query(
      `SELECT id, schema_version, policy_version, supersedes_policy_version,
              company_approval_reference, legal_approval_reference, approved_at, effective_from,
              published_by_reference, created_at
         FROM privacy_retention_schedules WHERE id = $1`,
      [scheduleId],
    )
    const row = scheduleResult.rows[0]
    if (row === undefined) throw new Error('privacy retention schedule does not exist')
    const entries = await tx.query(
      `SELECT data_class, retention_days, disposition
         FROM privacy_retention_schedule_entries WHERE schedule_id = $1 ORDER BY data_class`,
      [scheduleId],
    )
    return {
      id: scheduleId,
      schedule: this.parseSchedule({
        schemaVersion: rowText(row, 'schema_version'),
        policyVersion: rowText(row, 'policy_version'),
        supersedesPolicyVersion: nullableText(row.supersedes_policy_version),
        approved: true,
        companyApprovalReference: rowText(row, 'company_approval_reference'),
        legalApprovalReference: rowText(row, 'legal_approval_reference'),
        approvedAt: rowDate(row, 'approved_at'),
        effectiveFrom: rowDate(row, 'effective_from'),
        entries: entries.rows.map((entry) => ({
          dataClass: rowText(entry, 'data_class'),
          retentionDays: entry.retention_days,
          disposition: entry.disposition,
        })),
      }),
      publishedByReference: rowText(row, 'published_by_reference'),
      createdAt: rowDate(row, 'created_at'),
    }
  }

  private async holdSnapshot(tx: DbTransaction, holdId: string): Promise<PrivacyLegalHoldSnapshot> {
    const result = await tx.query(
      `SELECT hold.id, hold.hold_reference, hold.scope, hold.participant_id, hold.data_class,
              hold.record_reference, hold.reason_reference, hold.applied_by_reference, hold.applied_at,
              release.occurred_at AS released_at
         FROM privacy_legal_holds hold
         LEFT JOIN privacy_legal_hold_events release
           ON release.hold_id = hold.id AND release.event_type = 'released'
        WHERE hold.id = $1`,
      [holdId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('privacy legal hold does not exist')
    const base = {
      schemaVersion: 'privacy-legal-hold-scope-v1' as const,
      participantId: rowText(row, 'participant_id'),
    }
    let scope: PrivacyLegalHoldScope
    if (row.scope === 'participant') scope = { ...base, scope: 'participant' }
    else if (row.scope === 'participant_data_class')
      scope = {
        ...base,
        scope: 'participant_data_class',
        dataClass: rowDataClass(row, 'data_class'),
      }
    else if (row.scope === 'record')
      scope = {
        ...base,
        scope: 'record',
        dataClass: rowDataClass(row, 'data_class'),
        recordReference: rowText(row, 'record_reference'),
      }
    else throw new Error('privacy legal hold returned invalid scope')
    return {
      id: holdId,
      holdReference: rowText(row, 'hold_reference'),
      scope: this.parseHoldScope(scope),
      reasonReference: rowText(row, 'reason_reference'),
      appliedByReference: rowText(row, 'applied_by_reference'),
      appliedAt: rowDate(row, 'applied_at'),
      releasedAt: nullableDate(row.released_at),
    }
  }

  private async eligibilitySnapshot(
    tx: DbTransaction,
    evaluationId: string,
    subject: PrivacyRetentionSubject,
  ): Promise<Omit<PrivacyDeletionEligibilityResult, 'deduplicated'>> {
    const result = await tx.query(
      `SELECT evaluation.id, evaluation.evaluation_reference, evaluation.decision,
              evaluation.eligible_at, evaluation.active_hold_references, evaluation.evaluated_at,
              schedule.policy_version, entry.disposition
         FROM privacy_deletion_eligibility_evaluations evaluation
         LEFT JOIN privacy_retention_schedules schedule ON schedule.id = evaluation.schedule_id
         LEFT JOIN privacy_retention_schedule_entries entry
           ON entry.schedule_id = schedule.id AND entry.data_class = evaluation.data_class
        WHERE evaluation.id = $1`,
      [evaluationId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('privacy eligibility evaluation does not exist')
    if (
      !Array.isArray(row.active_hold_references) ||
      row.active_hold_references.some((value) => typeof value !== 'string')
    )
      throw new Error('privacy eligibility evaluation returned invalid holds')
    let decision: PrivacyDeletionEligibilityDecision
    if (row.decision === 'legal_hold_active') {
      decision = {
        decision: 'legal_hold_active',
        reasonCode: PRIVACY_RETENTION_REASON.LEGAL_HOLD_ACTIVE,
        policyVersion: null,
        eligibleAt: null,
        disposition: null,
        activeHoldReferences: row.active_hold_references,
      }
    } else if (row.decision === 'policy_missing') {
      decision = {
        decision: 'policy_missing',
        reasonCode: PRIVACY_RETENTION_REASON.POLICY_MISSING,
        policyVersion: null,
        eligibleAt: null,
        disposition: null,
        activeHoldReferences: [],
      }
    } else if (row.decision === 'retention_active' || row.decision === 'eligible') {
      if (row.disposition !== 'delete' && row.disposition !== 'irreversible_mask')
        throw new Error('privacy eligibility evaluation returned invalid disposition')
      decision = {
        decision: row.decision,
        reasonCode:
          row.decision === 'eligible'
            ? PRIVACY_RETENTION_REASON.DELETION_ELIGIBLE
            : PRIVACY_RETENTION_REASON.RETENTION_ACTIVE,
        policyVersion: rowText(row, 'policy_version'),
        eligibleAt: rowDate(row, 'eligible_at'),
        disposition: row.disposition,
        activeHoldReferences: [],
      }
    } else throw new Error('privacy eligibility evaluation returned invalid decision')
    return {
      id: evaluationId,
      evaluationReference: rowText(row, 'evaluation_reference'),
      subject,
      evaluatedAt: rowDate(row, 'evaluated_at'),
      result: decision,
    }
  }

  private appendAudit(
    tx: DbTransaction,
    input: PrivacyReviewerAction,
    action: string,
    targetId: string,
    result: 'success' | 'rejected',
    detail: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return tx.query(
      `INSERT INTO audit_logs (
         actor_type, actor_id, action, target_type, target_id, result, reason,
         correlation_id, protected_action, detail, occurred_at
       ) VALUES ('operator',$1,$2,'privacy_retention',$3,$4,$2,$5,'yes',$6::jsonb,$7)`,
      [input.actorReference, action, targetId, result, input.correlationId, JSON.stringify(detail), input.occurredAt],
    )
  }
}
