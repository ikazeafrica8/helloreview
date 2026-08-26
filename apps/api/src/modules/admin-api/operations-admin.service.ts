import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import type { Pool, PoolClient } from 'pg'
import {
  AutomationPauseService,
  type ActivatePauseInput,
  type AutomationPauseRecord,
  type DeactivatePauseInput,
} from '../workflow-core/index.js'
import { authorizeAdminInvocation, type AdminInvocation } from './admin-invocation.js'

export class AdminOperationsError extends Error {
  override readonly name = 'AdminOperationsError'
  constructor(readonly reasonCode: string) {
    super(`admin operations request rejected: ${reasonCode}`)
  }
}

export type FailedJob = Readonly<{
  jobId: string
  jobType: 'inbound_event' | 'outbound_notification'
  sourceCode: string
  eventCode: string
  statusCode: string
  failureCode: string | null
  attemptCount: number
  occurredAt: Date
}>

const CODE = /^[A-Z][A-Z0-9_]*$/
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const PAUSE_SCOPES = ['global', 'campaign', 'workflow_type', 'participant', 'participant_campaign', 'workflow'] as const
const PAUSE_KINDS = ['standard', 'emergency_kill_switch', 'privacy_request'] as const
const CAMPAIGN_TYPES = ['shipping', 'payback', 'visit'] as const
type DistributiveOmit<T, Keys extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, Keys>> : never

const member = <Values extends readonly string[]>(values: Values, value: unknown, field: string): Values[number] => {
  const found = values.find((candidate) => candidate === value)
  if (found === undefined) throw new Error(`operations query returned invalid ${field}`)
  return found
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const date = (value: unknown): Date => {
  if (value instanceof Date) return value
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value)
  throw new Error('operations query returned an invalid timestamp')
}

@Injectable()
export class OperationsAdminService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly pauses: AutomationPauseService,
  ) {}

  async health(invocation: AdminInvocation) {
    authorizeAdminInvocation(invocation, 'integrations.health.read', null)
    const [inbound, freshness, outbound] = await Promise.all([
      this.pool.query(`SELECT source, status, count(*)::integer AS count, max(received_at) AS last_received_at
                         FROM event_inbox GROUP BY source, status ORDER BY source, status`),
      this.pool.query(`SELECT source_system, last_attempted_at, last_successful_reconciliation_at,
                              consecutive_failure_count, last_failure_reason
                         FROM application_source_freshness ORDER BY source_system`),
      this.pool.query(`SELECT status, count(*)::integer AS count, max(updated_at) AS last_updated_at
                         FROM outbound_notifications GROUP BY status ORDER BY status`),
    ])
    return {
      checkedAt: new Date(invocation.context.evaluatedAt),
      inbound: inbound.rows,
      applicationSources: freshness.rows,
      outbound: outbound.rows,
    }
  }

  async failedJobs(invocation: AdminInvocation, limit = 100): Promise<readonly FailedJob[]> {
    authorizeAdminInvocation(invocation, 'failed_jobs.read', null)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AdminOperationsError('FAILED_JOB_LIMIT_INVALID')
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id AS job_id, 'inbound_event'::text AS job_type, source AS source_code,
              event_type AS event_code, status::text AS status_code, last_error_reason AS failure_code,
              attempt_count, received_at AS occurred_at
         FROM event_inbox WHERE status IN ('failed', 'dead_lettered')
       UNION ALL
       SELECT id, 'outbound_notification', coalesce(provider_name, channel), purpose_code, status::text,
              coalesce(last_failure_code, suppression_reason), retry_count, updated_at
         FROM outbound_notifications WHERE status IN ('failed', 'unknown')
       ORDER BY occurred_at DESC, job_id DESC LIMIT $1`,
      [limit],
    )
    return result.rows.map((row) => ({
      jobId: String(row.job_id),
      jobType: row.job_type === 'inbound_event' ? 'inbound_event' : 'outbound_notification',
      sourceCode: String(row.source_code),
      eventCode: String(row.event_code),
      statusCode: String(row.status_code),
      failureCode: typeof row.failure_code === 'string' ? row.failure_code : null,
      attemptCount: Number(row.attempt_count),
      occurredAt: date(row.occurred_at),
    }))
  }

  async notificationHistory(
    invocation: AdminInvocation,
    request: Readonly<{ campaignId: string; workflowId: string; limit?: number }>,
  ) {
    authorizeAdminInvocation(invocation, 'notifications.history.read', request.campaignId)
    await this.assertWorkflowCampaign(request.workflowId, request.campaignId)
    const limit = request.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AdminOperationsError('NOTIFICATION_HISTORY_LIMIT_INVALID')
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT n.id AS notification_id, n.purpose_code, n.template_version, n.status::text,
              n.suppression_reason, n.last_failure_code, n.retry_count, n.created_at, n.updated_at,
              e.id AS event_id, e.event_type::text, e.reason_code, e.occurred_at
         FROM outbound_notifications n
         LEFT JOIN outbound_notification_events e ON e.notification_id = n.id
        WHERE n.workflow_id = $1
        ORDER BY coalesce(e.occurred_at, n.updated_at) DESC, n.id DESC
        LIMIT $2`,
      [request.workflowId, limit],
    )
    return result.rows
  }

  async deduplicationHistory(
    invocation: AdminInvocation,
    request: Readonly<{ campaignId: string; workflowId: string; limit?: number }>,
  ) {
    authorizeAdminInvocation(invocation, 'deduplication.history.read', request.campaignId)
    await this.assertWorkflowCampaign(request.workflowId, request.campaignId)
    const limit = request.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AdminOperationsError('DEDUPLICATION_HISTORY_LIMIT_INVALID')
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id AS notification_id, purpose_code, template_version, business_event_version,
              deduplication_key, status::text, created_at
         FROM outbound_notifications WHERE workflow_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [request.workflowId, limit],
    )
    return result.rows
  }

  async retryInboundEvent(
    invocation: AdminInvocation,
    command: Readonly<{
      eventId: string
      operationReference: string
      expectedStatus: 'failed' | 'dead_lettered'
      reasonCode: string
      occurredAt: Date
    }>,
  ): Promise<Readonly<{ eventId: string; outcome: 'requeued'; deduplicated: boolean }>> {
    authorizeAdminInvocation(invocation, 'failed_jobs.retry', null)
    if (!REFERENCE.test(command.operationReference) || !CODE.test(command.reasonCode))
      throw new AdminOperationsError('FAILED_JOB_RETRY_CONTRACT_INVALID')
    const inputDigest = digest({
      eventId: command.eventId,
      expectedStatus: command.expectedStatus,
      reasonCode: command.reasonCode,
    })
    return this.transaction(async (client) => {
      const receipt = await client.query<Record<string, unknown>>(
        `SELECT target_event_id, input_digest FROM admin_retry_operations
          WHERE operation_reference = $1 FOR UPDATE`,
        [command.operationReference],
      )
      const prior = receipt.rows[0]
      if (prior !== undefined) {
        if (prior.input_digest !== inputDigest || prior.target_event_id !== command.eventId)
          throw new AdminOperationsError('FAILED_JOB_RETRY_IDEMPOTENCY_CONFLICT')
        return { eventId: command.eventId, outcome: 'requeued' as const, deduplicated: true }
      }
      const event = await client.query<Record<string, unknown>>(
        `SELECT id, status FROM event_inbox WHERE id = $1 FOR UPDATE`,
        [command.eventId],
      )
      const row = event.rows[0]
      if (row === undefined) throw new AdminOperationsError('FAILED_JOB_NOT_FOUND')
      if (row.status !== command.expectedStatus) throw new AdminOperationsError('FAILED_JOB_STATUS_STALE')
      await client.query(
        `UPDATE event_inbox SET status = 'received', processed_at = NULL, last_error_reason = NULL,
                                correlation_id = $2 WHERE id = $1`,
        [command.eventId, invocation.correlationId],
      )
      await client.query(
        `INSERT INTO admin_retry_operations (
           operation_reference, target_event_id, input_digest, prior_status, outcome_code,
           actor_reference, reason_code, correlation_id, occurred_at
         ) VALUES ($1,$2,$3,$4,'REQUEUED',$5,$6,$7,$8)`,
        [
          command.operationReference,
          command.eventId,
          inputDigest,
          command.expectedStatus,
          invocation.principal.principalReference,
          command.reasonCode,
          invocation.correlationId,
          command.occurredAt,
        ],
      )
      return { eventId: command.eventId, outcome: 'requeued' as const, deduplicated: false }
    })
  }

  async activePauses(invocation: AdminInvocation): Promise<readonly AutomationPauseRecord[]> {
    authorizeAdminInvocation(invocation, 'automation_pauses.read', null)
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id, scope, kind, campaign_id, workflow_type, participant_id, workflow_id,
              reason_code, activated_at, deactivated_at
         FROM automation_pauses WHERE deactivated_at IS NULL ORDER BY activated_at DESC`,
    )
    return result.rows.map((row) => ({
      id: String(row.id),
      scope: member(PAUSE_SCOPES, row.scope, 'scope'),
      kind: member(PAUSE_KINDS, row.kind, 'kind'),
      campaignId: typeof row.campaign_id === 'string' ? row.campaign_id : null,
      workflowType: row.workflow_type === null ? null : member(CAMPAIGN_TYPES, row.workflow_type, 'workflow_type'),
      participantId: typeof row.participant_id === 'string' ? row.participant_id : null,
      workflowId: typeof row.workflow_id === 'string' ? row.workflow_id : null,
      reasonCode: String(row.reason_code),
      activatedAt: date(row.activated_at),
    }))
  }

  async activatePause(
    invocation: AdminInvocation,
    command: DistributiveOmit<ActivatePauseInput, 'actorType' | 'actorId' | 'authorized' | 'correlationId'>,
  ): Promise<AutomationPauseRecord> {
    authorizeAdminInvocation(invocation, 'automation_pauses.activate', null)
    const input: ActivatePauseInput = {
      ...command,
      actorType: 'operator',
      actorId: invocation.principal.principalReference,
      authorized: true,
      correlationId: invocation.correlationId,
    }
    return this.pauses.activate(input)
  }

  async resumePause(
    invocation: AdminInvocation,
    command: Omit<DeactivatePauseInput, 'actorType' | 'actorId' | 'authorized' | 'correlationId'>,
  ): Promise<void> {
    authorizeAdminInvocation(invocation, 'automation_pauses.resume', null)
    await this.pauses.deactivate({
      ...command,
      actorType: 'operator',
      actorId: invocation.principal.principalReference,
      authorized: true,
      correlationId: invocation.correlationId,
    })
  }

  async aiState(invocation: AdminInvocation) {
    authorizeAdminInvocation(invocation, 'ai_cost.read', null)
    const counts = await this.pool.query<Record<string, unknown>>(
      `SELECT count(*)::integer AS workflow_decisions,
              count(*) FILTER (WHERE actor_type = 'system' AND trigger_code LIKE 'AI_%')::integer
                AS ai_attributed_decisions FROM workflow_events`,
    )
    return {
      providerMode: 'unavailable_safe_fallback' as const,
      realProviderConnected: false,
      costTracking: 'no_billable_provider_configured' as const,
      estimatedCostMicros: 0,
      workflowDecisions: Number(counts.rows[0]?.workflow_decisions ?? 0),
      aiAttributedDecisions: Number(counts.rows[0]?.ai_attributed_decisions ?? 0),
      evaluatedAt: new Date(invocation.context.evaluatedAt),
    }
  }

  private async assertWorkflowCampaign(workflowId: string, campaignId: string): Promise<void> {
    const scope = await this.pool.query(`SELECT 1 FROM workflow_instances WHERE id = $1 AND campaign_id = $2 LIMIT 1`, [
      workflowId,
      campaignId,
    ])
    if (scope.rows.length === 0) throw new AdminOperationsError('WORKFLOW_CAMPAIGN_SCOPE_MISMATCH')
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
