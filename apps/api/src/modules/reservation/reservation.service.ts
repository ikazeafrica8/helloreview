import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'

export type ReservationVersionSource = 'participant' | 'operator' | 'ai_assisted' | 'imported'
export type ReservationValidationState = 'pending' | 'valid' | 'invalid' | 'human_review'
export type ReservationValidationAuthority = 'none' | 'deterministic_rules'
export type ReservationStatus = 'pending' | 'confirmed' | 'cancelled' | 'rescheduled'

export type ReservationVersionInput = Readonly<{
  workflowId: string
  participantId: string
  source: ReservationVersionSource
  sourceReference: string
  extractionProvenance: Readonly<Record<string, unknown>>
  reservedDate: string | null
  reservedTime: string | null
  timezone: string | null
  businessReference: string | null
  visitMethod: string | null
  status: ReservationStatus
  cancellationReason: string | null
  validationState: ReservationValidationState
  validationAuthority: ReservationValidationAuthority
  ruleVersion: string | null
  validationEvidence: Readonly<Record<string, unknown>>
  actorType: 'system' | 'operator' | 'participant'
  actorReference: string
  authorized: boolean
  occurredAt: Date
}>

export type ReservationVersionSnapshot = Readonly<{
  reservationId: string
  versionId: string
  workflowId: string
  version: number
  source: ReservationVersionSource
  sourceReference: string
  extractionProvenance: unknown
  reservedDate: string | null
  reservedTime: string | null
  timezone: string | null
  businessReference: string | null
  visitMethod: string | null
  status: ReservationStatus
  cancellationReason: string | null
  validationState: ReservationValidationState
  validationAuthority: ReservationValidationAuthority
  ruleVersion: string | null
  validationEvidence: unknown
  supersedesVersionId: string | null
  actorReference: string
  occurredAt: Date
}>

export type RecordedReservationVersion = Readonly<{
  reservation: ReservationVersionSnapshot
  deduplicated: boolean
}>

export class ReservationServiceError extends Error {
  override readonly name = 'ReservationServiceError'
  constructor(readonly reasonCode: string) {
    super(`reservation action rejected: ${reasonCode}`)
  }
}

const SOURCES: readonly ReservationVersionSource[] = ['participant', 'operator', 'ai_assisted', 'imported']
const VALIDATIONS: readonly ReservationValidationState[] = ['pending', 'valid', 'invalid', 'human_review']
const AUTHORITIES: readonly ReservationValidationAuthority[] = ['none', 'deterministic_rules']
const STATUSES: readonly ReservationStatus[] = ['pending', 'confirmed', 'cancelled', 'rescheduled']

const rowText = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`reservation query returned invalid ${column}`)
}

const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const rowInteger = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw new Error(`reservation query returned invalid ${column}`)
}

const member = <Value extends string>(values: readonly Value[], value: unknown, field: string): Value => {
  const found = values.find((candidate) => candidate === value)
  if (found === undefined) throw new Error(`reservation query returned invalid ${field}`)
  return found
}

const snapshot = (row: Record<string, unknown>): ReservationVersionSnapshot => {
  if (!(row.occurred_at instanceof Date)) throw new Error('reservation query returned invalid occurred_at')
  return {
    reservationId: rowText(row, 'reservation_id'),
    versionId: rowText(row, 'version_id'),
    workflowId: rowText(row, 'workflow_id'),
    version: rowInteger(row, 'version'),
    source: member(SOURCES, row.source, 'source'),
    sourceReference: rowText(row, 'source_reference'),
    extractionProvenance: row.extraction_provenance,
    reservedDate: nullableText(row.reserved_date),
    reservedTime: nullableText(row.reserved_time),
    timezone: nullableText(row.timezone),
    businessReference: nullableText(row.business_reference),
    visitMethod: nullableText(row.visit_method),
    status: member(STATUSES, row.status, 'status'),
    cancellationReason: nullableText(row.cancellation_reason),
    validationState: member(VALIDATIONS, row.validation_state, 'validation_state'),
    validationAuthority: member(AUTHORITIES, row.validation_authority, 'validation_authority'),
    ruleVersion: nullableText(row.rule_version),
    validationEvidence: row.validation_evidence,
    supersedesVersionId: nullableText(row.supersedes_version_id),
    actorReference: rowText(row, 'actor_reference'),
    occurredAt: row.occurred_at,
  }
}

const VERSION_COLUMNS = `
  r.id AS reservation_id, v.id AS version_id, v.workflow_id, v.version, v.source,
  v.source_reference, v.extraction_provenance, v.reserved_date, v.reserved_time,
  v.timezone, v.business_reference, v.visit_method, v.status, v.cancellation_reason,
  v.validation_state, v.validation_authority, v.rule_version, v.validation_evidence,
  v.supersedes_version_id, v.actor_reference, v.occurred_at`

const workflowState = (input: ReservationVersionInput): string => {
  if (input.status === 'cancelled') return 'cancelled'
  if (input.status === 'rescheduled') return 'rescheduled'
  if (input.validationState === 'valid') return 'valid'
  if (input.validationState === 'invalid') return 'correction_required'
  if (input.validationState === 'human_review') return 'human_review_required'
  return 'validation_pending'
}

@Injectable()
export class ReservationService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async recordVersion(input: ReservationVersionInput): Promise<RecordedReservationVersion> {
    this.authorize(input)
    if (input.sourceReference.trim() === '') throw new ReservationServiceError('RESERVATION_SOURCE_REQUIRED')
    if (
      input.validationState === 'valid' &&
      (input.validationAuthority !== 'deterministic_rules' || input.ruleVersion === null)
    )
      throw new ReservationServiceError('RESERVATION_RULE_VALIDATION_REQUIRED')
    if (input.validationAuthority === 'deterministic_rules' && input.ruleVersion === null)
      throw new ReservationServiceError('RESERVATION_RULE_VERSION_REQUIRED')
    if (input.status === 'cancelled' && input.cancellationReason === null)
      throw new ReservationServiceError('RESERVATION_CANCELLATION_REASON_REQUIRED')

    return runInTransaction(this.pool, async (tx) => {
      const workflow = await tx.query(
        `SELECT id, participant_id, campaign_id, campaign_type, visit_method
           FROM workflow_instances WHERE id = $1 AND participant_id = $2 FOR UPDATE`,
        [input.workflowId, input.participantId],
      )
      const workflowRow = workflow.rows[0]
      if (workflowRow === undefined) throw new ReservationServiceError('RESERVATION_WORKFLOW_NOT_FOUND')
      if (workflowRow.campaign_type !== 'visit' || workflowRow.visit_method !== 'visit_a')
        throw new ReservationServiceError('VISIT_A_WORKFLOW_REQUIRED')
      const reservationId = await this.ensureAggregate(tx, workflowRow, input)
      const duplicate = await tx.query(
        `SELECT ${VERSION_COLUMNS}
           FROM reservations r JOIN reservation_versions v ON v.reservation_id = r.id
          WHERE r.id = $1 AND v.source_reference = $2`,
        [reservationId, input.sourceReference],
      )
      if (duplicate.rows[0] !== undefined) return { reservation: snapshot(duplicate.rows[0]), deduplicated: true }
      const currentResult = await tx.query(
        `SELECT ${VERSION_COLUMNS}
           FROM reservations r
           JOIN reservation_heads h ON h.reservation_id = r.id
           JOIN reservation_versions v ON v.id = h.version_id
          WHERE r.id = $1`,
        [reservationId],
      )
      const current = currentResult.rows[0]
      const version = current === undefined ? 1 : rowInteger(current, 'version') + 1
      const supersedesVersionId = current === undefined ? null : rowText(current, 'version_id')
      const inserted = await tx.query(
        `INSERT INTO reservation_versions (
           reservation_id, workflow_id, version, source, source_reference,
           extraction_provenance, reserved_date, reserved_time, timezone, business_reference,
           visit_method, status, cancellation_reason, validation_state, validation_authority,
           rule_version, validation_evidence, supersedes_version_id, actor_reference, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20)
         RETURNING id`,
        [
          reservationId,
          input.workflowId,
          version,
          input.source,
          input.sourceReference,
          JSON.stringify(input.extractionProvenance),
          input.reservedDate,
          input.reservedTime,
          input.timezone,
          input.businessReference,
          input.visitMethod,
          input.status,
          input.cancellationReason,
          input.validationState,
          input.validationAuthority,
          input.ruleVersion,
          JSON.stringify(input.validationEvidence),
          supersedesVersionId,
          input.actorReference,
          input.occurredAt,
        ],
      )
      const versionId = rowText(inserted.rows[0] ?? {}, 'id')
      await tx.query(
        `INSERT INTO reservation_heads (reservation_id, version_id, updated_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (reservation_id) DO UPDATE SET version_id = EXCLUDED.version_id, updated_at = EXCLUDED.updated_at`,
        [reservationId, versionId, input.occurredAt],
      )
      await tx.query(
        `UPDATE workflow_instances
            SET reservation_state = $2, reservation_origin_at = $3,
                version = version + 1, updated_at = $3 WHERE id = $1`,
        [input.workflowId, workflowState(input), input.occurredAt],
      )
      const recorded = await this.byVersionId(tx, versionId)
      return { reservation: recorded, deduplicated: false }
    })
  }

  async current(workflowId: string, participantId: string): Promise<ReservationVersionSnapshot | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS}
         FROM reservations r
         JOIN reservation_heads h ON h.reservation_id = r.id
         JOIN reservation_versions v ON v.id = h.version_id
        WHERE r.workflow_id = $1 AND r.participant_id = $2`,
      [workflowId, participantId],
    )
    return result.rows[0] === undefined ? null : snapshot(result.rows[0])
  }

  async history(workflowId: string, participantId: string): Promise<readonly ReservationVersionSnapshot[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS}
         FROM reservations r JOIN reservation_versions v ON v.reservation_id = r.id
        WHERE r.workflow_id = $1 AND r.participant_id = $2 ORDER BY v.version ASC`,
      [workflowId, participantId],
    )
    return result.rows.map(snapshot)
  }

  private authorize(input: ReservationVersionInput): void {
    const participantSource = input.source === 'participant' || input.source === 'ai_assisted'
    if (participantSource && input.actorType !== 'participant')
      throw new ReservationServiceError('RESERVATION_SOURCE_NOT_AUTHORIZED')
    if (!participantSource && (input.actorType === 'participant' || !input.authorized))
      throw new ReservationServiceError('RESERVATION_SOURCE_NOT_AUTHORIZED')
  }

  private async ensureAggregate(
    tx: DbTransaction,
    workflow: Record<string, unknown>,
    input: ReservationVersionInput,
  ): Promise<string> {
    const existing = await tx.query(`SELECT id FROM reservations WHERE workflow_id = $1`, [input.workflowId])
    if (existing.rows[0] !== undefined) return rowText(existing.rows[0], 'id')
    const inserted = await tx.query(
      `INSERT INTO reservations (workflow_id, participant_id, campaign_id, created_at)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.workflowId, input.participantId, rowText(workflow, 'campaign_id'), input.occurredAt],
    )
    return rowText(inserted.rows[0] ?? {}, 'id')
  }

  private async byVersionId(tx: DbTransaction, versionId: string): Promise<ReservationVersionSnapshot> {
    const result = await tx.query(
      `SELECT ${VERSION_COLUMNS}
         FROM reservations r JOIN reservation_versions v ON v.reservation_id = r.id
        WHERE v.id = $1`,
      [versionId],
    )
    if (result.rows[0] === undefined) throw new Error('reservation version was not visible')
    return snapshot(result.rows[0])
  }
}
