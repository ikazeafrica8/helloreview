import {
  WEBSITE_SOURCE_FAILURES,
  WebsiteSourceError,
  type WebsiteApplicationSnapshot,
  type WebsiteApplicationSource,
} from '@helloreview/adapters'
import { Pool, type PoolClient } from 'pg'
import { ApplicationSyncService, type ApplicationSynchronizationOutcome } from './application-sync.service.js'
import { APPLICATION_SYNC_REASON, type ApplicationSyncReasonCode } from './reason-codes.js'

export type ReconciliationPolicy = Readonly<{
  retryWindowMs: number
  retryIntervalMs: number
  freshnessThresholdMs: number
}>

export type ReconciliationStatus = 'pending' | 'resolved' | 'no_match' | 'failed'

export type ReconciliationAttemptOutcome = Readonly<{
  reconciliationId: string
  status: ReconciliationStatus
  attempted: boolean
  attemptCount: number
  nextAttemptAt: Date
  resolvedApplicationId?: string
  reasonCode?: string
}>

export type ApplicationSourceFreshness = Readonly<{
  sourceSystem: string
  lastSuccessfulReconciliationAt: Date | null
  ageMs: number | null
  stale: boolean
  consecutiveFailureCount: number
  lastFailureReason: string | null
  evaluatedAt: Date
}>

export class ApplicationReconciliationError extends Error {
  override readonly name = 'ApplicationReconciliationError'

  constructor(
    readonly reasonCode: ApplicationSyncReasonCode,
    readonly reconciliationId: string,
  ) {
    super(`Application reconciliation rejected: ${reasonCode}`)
  }
}

type ReconciliationRow = Readonly<{
  id: string
  sourceSystem: string
  campaignId: string
  status: ReconciliationStatus
  claimedAt: Date
  retryDeadlineAt: Date
  nextAttemptAt: Date
  attemptCount: number
  resolvedApplicationId?: string
}>

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`reconciliation query returned a non-string ${column}`)
}

const optionalStringColumn = (row: Record<string, unknown>, column: string): string | undefined => {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  throw new Error(`reconciliation query returned an invalid ${column}`)
}

const dateColumn = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`reconciliation query returned an invalid ${column}`)
}

const RECONCILIATION_STATUSES: readonly ReconciliationStatus[] = ['pending', 'resolved', 'no_match', 'failed']

const reconciliationRow = (row: Record<string, unknown>): ReconciliationRow => {
  const statusValue = stringColumn(row, 'status')
  const status = RECONCILIATION_STATUSES.find((candidate) => candidate === statusValue)
  if (status === undefined) throw new Error('reconciliation query returned an unknown status')
  const resolvedApplicationId = optionalStringColumn(row, 'resolved_application_id')
  return {
    id: stringColumn(row, 'id'),
    sourceSystem: stringColumn(row, 'source_system'),
    campaignId: stringColumn(row, 'campaign_id'),
    status,
    claimedAt: dateColumn(row, 'claimed_at'),
    retryDeadlineAt: dateColumn(row, 'retry_deadline_at'),
    nextAttemptAt: dateColumn(row, 'next_attempt_at'),
    attemptCount: Number(row.attempt_count),
    ...(resolvedApplicationId === undefined ? {} : { resolvedApplicationId }),
  }
}

const validatePolicy = (policy: ReconciliationPolicy): void => {
  if (
    !Number.isFinite(policy.retryWindowMs) ||
    !Number.isFinite(policy.retryIntervalMs) ||
    !Number.isFinite(policy.freshnessThresholdMs) ||
    policy.retryWindowMs <= 0 ||
    policy.retryIntervalMs <= 0 ||
    policy.freshnessThresholdMs <= 0 ||
    policy.retryIntervalMs >= policy.retryWindowMs
  ) {
    throw new Error('INVALID_APPLICATION_RECONCILIATION_POLICY')
  }
}

export const reconciliationPolicyFromSeconds = (values: {
  applicationReconciliationWindowSeconds: number
  applicationReconciliationRetrySeconds: number
  applicationFreshnessThresholdSeconds: number
}): ReconciliationPolicy => ({
  retryWindowMs: values.applicationReconciliationWindowSeconds * 1_000,
  retryIntervalMs: values.applicationReconciliationRetrySeconds * 1_000,
  freshnessThresholdMs: values.applicationFreshnessThresholdSeconds * 1_000,
})

/** Bounded website read-back after a participant claim, with queryable per-source health. */
export class ApplicationReconciliationService {
  constructor(
    private readonly pool: Pool,
    private readonly synchronization: ApplicationSyncService,
    private readonly source: WebsiteApplicationSource,
    private readonly policy: ReconciliationPolicy,
  ) {
    validatePolicy(policy)
  }

  async begin(
    command: Readonly<{ sourceSystem: string; campaignId: string; claimedAt: Date }>,
  ): Promise<ReconciliationAttemptOutcome> {
    if (command.sourceSystem !== this.source.sourceSystem) {
      throw new ApplicationReconciliationError(
        APPLICATION_SYNC_REASON.RECONCILIATION_SOURCE_MISMATCH,
        command.sourceSystem,
      )
    }
    const deadline = new Date(command.claimedAt.getTime() + this.policy.retryWindowMs)
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO application_reconciliations (
         source_system, campaign_id, claimed_at, retry_deadline_at, next_attempt_at
       ) VALUES ($1,$2,$3,$4,$3)
       RETURNING id, source_system, campaign_id, status, claimed_at, retry_deadline_at,
                 next_attempt_at, attempt_count, resolved_application_id`,
      [command.sourceSystem, command.campaignId, command.claimedAt, deadline],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('reconciliation insert returned no row')
    return this.toOutcome(reconciliationRow(row), false)
  }

  async attempt(reconciliationId: string, now = new Date()): Promise<ReconciliationAttemptOutcome> {
    const client = await this.pool.connect()
    let locked = false
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        JSON.stringify(['application-reconciliation', reconciliationId]),
      ])
      locked = true

      const request = await this.load(client, reconciliationId)
      if (request.status !== 'pending') return this.toOutcome(request, false)
      if (request.sourceSystem !== this.source.sourceSystem) {
        throw new ApplicationReconciliationError(
          APPLICATION_SYNC_REASON.RECONCILIATION_SOURCE_MISMATCH,
          reconciliationId,
        )
      }
      if (request.nextAttemptAt.getTime() > now.getTime()) {
        return this.toOutcome(request, false)
      }

      let snapshots: readonly WebsiteApplicationSnapshot[]
      try {
        snapshots = await this.source.listRecentApplications({
          campaignId: request.campaignId,
          submittedSince: new Date(request.claimedAt.getTime() - this.policy.retryWindowMs),
        })
        this.validateSnapshots(request, snapshots)
      } catch (error) {
        const reasonCode =
          error instanceof WebsiteSourceError ? error.reasonCode : WEBSITE_SOURCE_FAILURES.RESPONSE_INVALID
        await this.recordSourceFailure(client, request.sourceSystem, now, reasonCode)
        return await this.recordUnsuccessfulAttempt(client, request, now, reasonCode, true)
      }

      const synchronized: ApplicationSynchronizationOutcome[] = []
      for (const snapshot of snapshots) {
        synchronized.push(await this.synchronization.synchronizeSnapshot(snapshot, now))
      }
      await this.recordSourceSuccess(client, request.sourceSystem, now)

      const first = synchronized[0]
      if (first !== undefined) {
        const result = await client.query<Record<string, unknown>>(
          `UPDATE application_reconciliations
              SET status = 'resolved', attempt_count = attempt_count + 1,
                  last_attempt_at = $2, next_attempt_at = $2,
                  last_failure_reason = NULL, resolved_application_id = $3, updated_at = $2
            WHERE id = $1
            RETURNING id, source_system, campaign_id, status, claimed_at, retry_deadline_at,
                      next_attempt_at, attempt_count, resolved_application_id`,
          [request.id, now, first.applicationId],
        )
        return this.outcomeFromResult(result, true)
      }

      return await this.recordUnsuccessfulAttempt(client, request, now, undefined, false)
    } finally {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
          JSON.stringify(['application-reconciliation', reconciliationId]),
        ])
      }
      client.release()
    }
  }

  async freshness(sourceSystem: string, evaluatedAt = new Date()): Promise<ApplicationSourceFreshness> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT last_successful_reconciliation_at, consecutive_failure_count, last_failure_reason
         FROM application_source_freshness
        WHERE source_system = $1`,
      [sourceSystem],
    )
    const row = result.rows[0]
    if (row === undefined) {
      return {
        sourceSystem,
        lastSuccessfulReconciliationAt: null,
        ageMs: null,
        stale: true,
        consecutiveFailureCount: 0,
        lastFailureReason: null,
        evaluatedAt,
      }
    }

    const lastSuccessValue = row.last_successful_reconciliation_at
    const lastSuccessfulReconciliationAt = lastSuccessValue instanceof Date ? lastSuccessValue : null
    const ageMs =
      lastSuccessfulReconciliationAt === null
        ? null
        : Math.max(0, evaluatedAt.getTime() - lastSuccessfulReconciliationAt.getTime())
    return {
      sourceSystem,
      lastSuccessfulReconciliationAt,
      ageMs,
      stale: ageMs === null || ageMs > this.policy.freshnessThresholdMs,
      consecutiveFailureCount: Number(row.consecutive_failure_count),
      lastFailureReason: typeof row.last_failure_reason === 'string' ? row.last_failure_reason : null,
      evaluatedAt,
    }
  }

  private async load(client: PoolClient, id: string): Promise<ReconciliationRow> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id, source_system, campaign_id, status, claimed_at, retry_deadline_at,
              next_attempt_at, attempt_count, resolved_application_id
         FROM application_reconciliations WHERE id = $1`,
      [id],
    )
    const row = result.rows[0]
    if (row === undefined) {
      throw new ApplicationReconciliationError(APPLICATION_SYNC_REASON.RECONCILIATION_NOT_FOUND, id)
    }
    return reconciliationRow(row)
  }

  private validateSnapshots(request: ReconciliationRow, snapshots: readonly WebsiteApplicationSnapshot[]): void {
    for (const snapshot of snapshots) {
      if (snapshot.sourceSystem !== request.sourceSystem || snapshot.campaignId !== request.campaignId) {
        throw new WebsiteSourceError(WEBSITE_SOURCE_FAILURES.RESPONSE_INVALID)
      }
    }
  }

  private async recordSourceSuccess(client: PoolClient, sourceSystem: string, now: Date): Promise<void> {
    await client.query(
      `INSERT INTO application_source_freshness (
         source_system, last_attempted_at, last_successful_reconciliation_at,
         consecutive_failure_count, last_failure_reason, updated_at
       ) VALUES ($1,$2,$2,0,NULL,$2)
       ON CONFLICT (source_system) DO UPDATE SET
         last_attempted_at = EXCLUDED.last_attempted_at,
         last_successful_reconciliation_at = EXCLUDED.last_successful_reconciliation_at,
         consecutive_failure_count = 0,
         last_failure_reason = NULL,
         updated_at = EXCLUDED.updated_at`,
      [sourceSystem, now],
    )
  }

  private async recordSourceFailure(
    client: PoolClient,
    sourceSystem: string,
    now: Date,
    reasonCode: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO application_source_freshness (
         source_system, last_attempted_at, consecutive_failure_count,
         last_failure_reason, updated_at
       ) VALUES ($1,$2,1,$3,$2)
       ON CONFLICT (source_system) DO UPDATE SET
         last_attempted_at = EXCLUDED.last_attempted_at,
         consecutive_failure_count = application_source_freshness.consecutive_failure_count + 1,
         last_failure_reason = EXCLUDED.last_failure_reason,
         updated_at = EXCLUDED.updated_at`,
      [sourceSystem, now, reasonCode],
    )
  }

  private async recordUnsuccessfulAttempt(
    client: PoolClient,
    request: ReconciliationRow,
    now: Date,
    reasonCode: string | undefined,
    sourceFailed: boolean,
  ): Promise<ReconciliationAttemptOutcome> {
    const expired = now.getTime() >= request.retryDeadlineAt.getTime()
    const status: ReconciliationStatus = expired ? (sourceFailed ? 'failed' : 'no_match') : 'pending'
    const nextAttemptAt = expired
      ? now
      : new Date(Math.min(now.getTime() + this.policy.retryIntervalMs, request.retryDeadlineAt.getTime()))
    const result = await client.query<Record<string, unknown>>(
      `UPDATE application_reconciliations
          SET status = $2, attempt_count = attempt_count + 1, last_attempt_at = $3,
              next_attempt_at = $4, last_failure_reason = $5, updated_at = $3
        WHERE id = $1
        RETURNING id, source_system, campaign_id, status, claimed_at, retry_deadline_at,
                  next_attempt_at, attempt_count, resolved_application_id`,
      [request.id, status, now, nextAttemptAt, reasonCode ?? null],
    )
    return {
      ...this.outcomeFromResult(result, true),
      ...(reasonCode === undefined ? {} : { reasonCode }),
    }
  }

  private outcomeFromResult(
    result: { rows: Record<string, unknown>[] },
    attempted: boolean,
  ): ReconciliationAttemptOutcome {
    const row = result.rows[0]
    if (row === undefined) throw new Error('reconciliation update returned no row')
    return this.toOutcome(reconciliationRow(row), attempted)
  }

  private toOutcome(row: ReconciliationRow, attempted: boolean): ReconciliationAttemptOutcome {
    return {
      reconciliationId: row.id,
      status: row.status,
      attempted,
      attemptCount: row.attemptCount,
      nextAttemptAt: row.nextAttemptAt,
      ...(row.resolvedApplicationId === undefined ? {} : { resolvedApplicationId: row.resolvedApplicationId }),
    }
  }
}
