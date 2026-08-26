import { Inject, Injectable } from '@nestjs/common'
import { MESSAGE_PURPOSES, type OutboundChannel } from '@helloreview/contracts'
import { bindDbTransaction, POSTGRES_POOL, type DbTransaction } from '@helloreview/db'
import { Pool, type PoolClient } from 'pg'
import { HumanOwnershipError, HumanOwnershipService, OutboundIntentService } from '../messaging/index.js'
import {
  AutomationPauseService,
  HUMAN_HANDOFF_PROJECTION_REASON,
  HumanHandoffProjectionError,
  HumanHandoffProjectionService,
} from '../workflow-core/index.js'
import { HUMAN_REVIEW_CASE_PACKET_VERSION, isHumanReviewCasePacket, type HumanReviewCasePacket } from './case-packet.js'
import type { HumanReviewPriority } from './handoff-priority.js'
import type { MaskedCasePacket } from './human-review-task.service.js'
import { HUMAN_REVIEW_OPERATION_REASON, type HumanReviewOperationReasonCode } from './operation-reason-codes.js'
import { isHumanReviewReasonCode, type HumanReviewReasonCode } from './reason-codes.js'
import { scheduleHumanReviewSla, type HumanReviewSlaPolicy, type HumanReviewSlaSchedule } from './sla-policy.js'

const LEGACY_CASE_PACKET_VERSION = 'legacy-case-packet-v0' as const
const OPERATION_CODE = /^[A-Z][A-Z0-9_]*$/
const RAW_KOREAN_MOBILE = /(?:\+?82|0)[\s-]*10(?:[\s-]*\d){8}/

type StoredHumanReviewCasePacket = HumanReviewCasePacket | MaskedCasePacket

export type HumanReviewOperationalTask = Readonly<{
  id: string
  workflowId: string | null
  campaignId: string | null
  episodeNumber: number
  reasonCode: HumanReviewReasonCode
  priority: HumanReviewPriority
  status: 'open' | 'in_progress' | 'resolved' | 'cancelled'
  casePacketVersion: string
  casePacket: StoredHumanReviewCasePacket
  assigneeId: string | null
  slaPolicyVersion: string | null
  dueAt: Date | null
  escalationAt: Date | null
  createdAt: Date
}>

export type HumanReviewQueueFilters = Readonly<{
  status?: HumanReviewOperationalTask['status']
  priority?: HumanReviewPriority
  campaignId?: string
  reasonCode?: HumanReviewReasonCode
  assigneeId?: string | null
  createdBefore?: Date
  overdueAt?: Date
  limit?: number
}>

export type HumanReviewReturnValidation = Readonly<{
  optOutClear: boolean
  requiredEvidenceCurrent: boolean
  deterministicReadinessPassed: boolean
  policyVersion: string
  evaluatedAt: Date
}>

export class HumanReviewOperationError extends Error {
  override readonly name = 'HumanReviewOperationError'

  constructor(readonly reasonCode: HumanReviewOperationReasonCode) {
    super(`human review operation rejected: ${reasonCode}`)
  }
}

const textColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`human review operation query returned invalid ${column}`)
}

const nullableTextColumn = (row: Record<string, unknown>, column: string): string | null => {
  const value = row[column]
  if (value === null || typeof value === 'string') return value
  throw new Error(`human review operation query returned invalid ${column}`)
}

const nullableDateColumn = (row: Record<string, unknown>, column: string): Date | null => {
  const value = row[column]
  if (value === null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`human review operation query returned invalid ${column}`)
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const isLegacyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !RAW_KOREAN_MOBILE.test(value)

const isLegacyCasePacket = (value: unknown): value is MaskedCasePacket => {
  if (!isRecord(value)) return false
  return (
    isLegacyString(value.stateCode) &&
    typeof value.summaryCode === 'string' &&
    isHumanReviewReasonCode(value.summaryCode) &&
    Array.isArray(value.evidenceCodes) &&
    value.evidenceCodes.length > 0 &&
    value.evidenceCodes.every(isLegacyString) &&
    Array.isArray(value.allowedActionCodes) &&
    value.allowedActionCodes.length > 0 &&
    value.allowedActionCodes.every((item) => typeof item === 'string' && OPERATION_CODE.test(item)) &&
    new Set(value.allowedActionCodes).size === value.allowedActionCodes.length &&
    typeof value.recommendationCode === 'string' &&
    OPERATION_CODE.test(value.recommendationCode)
  )
}

const taskFrom = (row: Record<string, unknown>): HumanReviewOperationalTask => {
  const episodeNumber = row.episode_number
  const priority = textColumn(row, 'priority')
  const status = textColumn(row, 'status')
  const createdAt = row.created_at
  const packet = row.case_packet
  const packetVersion = textColumn(row, 'case_packet_version')
  if (typeof episodeNumber !== 'number' || !Number.isInteger(episodeNumber)) {
    throw new Error('human review operation query returned invalid episode_number')
  }
  if (priority !== 'normal' && priority !== 'high' && priority !== 'critical') {
    throw new Error('human review operation query returned invalid priority')
  }
  if (status !== 'open' && status !== 'in_progress' && status !== 'resolved' && status !== 'cancelled') {
    throw new Error('human review operation query returned invalid status')
  }
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new Error('human review operation query returned invalid created_at')
  }
  let storedPacket: StoredHumanReviewCasePacket
  if (packetVersion === HUMAN_REVIEW_CASE_PACKET_VERSION && isHumanReviewCasePacket(packet)) {
    storedPacket = packet
  } else if (packetVersion === LEGACY_CASE_PACKET_VERSION && isLegacyCasePacket(packet)) {
    storedPacket = packet
  } else {
    throw new Error('human review operation query returned an unsupported case packet')
  }
  const reasonCode = textColumn(row, 'reason_code')
  if (!isHumanReviewReasonCode(reasonCode)) throw new Error('human review operation query returned invalid reason_code')
  return {
    id: textColumn(row, 'id'),
    workflowId: nullableTextColumn(row, 'workflow_id'),
    campaignId: nullableTextColumn(row, 'campaign_id'),
    episodeNumber,
    reasonCode,
    priority,
    status,
    casePacketVersion: packetVersion,
    casePacket: storedPacket,
    assigneeId: nullableTextColumn(row, 'assignee_id'),
    slaPolicyVersion: nullableTextColumn(row, 'sla_policy_version'),
    dueAt: nullableDateColumn(row, 'due_at'),
    escalationAt: nullableDateColumn(row, 'escalation_at'),
    createdAt,
  }
}

const TASK_COLUMNS = `
  id, workflow_id, campaign_id, episode_number, reason_code, priority, status,
  case_packet, case_packet_version, assignee_id, sla_policy_version, due_at, escalation_at, created_at`

const slaFromTask = (task: HumanReviewOperationalTask): HumanReviewSlaSchedule => {
  if (task.slaPolicyVersion === null && task.dueAt === null && task.escalationAt === null) {
    return { state: 'SLA_POLICY_MISSING' }
  }
  if (task.slaPolicyVersion !== null && task.dueAt !== null && task.escalationAt !== null) {
    return {
      state: 'scheduled',
      policyVersion: task.slaPolicyVersion,
      dueAt: task.dueAt,
      escalationAt: task.escalationAt,
    }
  }
  throw new Error('human review operation query returned an incoherent SLA schedule')
}

const appendTaskEvent = async (
  tx: DbTransaction,
  input: Readonly<{
    taskId: string
    eventType:
      | 'created'
      | 'holding_queued'
      | 'assigned'
      | 'released'
      | 'resolution_recorded'
      | 'resume_rejected'
      | 'returned_to_automation'
    fromStatus: HumanReviewOperationalTask['status'] | null
    toStatus: HumanReviewOperationalTask['status'] | null
    actorId: string
    reasonCode: string
    correlationId: string
    detail: Readonly<Record<string, unknown>>
    deduplicationKey: string
    occurredAt: Date
  }>,
): Promise<void> => {
  await tx.query(
    `INSERT INTO human_review_task_events (
       task_id, event_type, from_status, to_status, actor_id, reason_code,
       correlation_id, detail, deduplication_key, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     ON CONFLICT (deduplication_key) DO NOTHING`,
    [
      input.taskId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.actorId,
      input.reasonCode,
      input.correlationId,
      JSON.stringify(input.detail),
      input.deduplicationKey,
      input.occurredAt,
    ],
  )
}

@Injectable()
export class HumanReviewOperationsService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly outbound: OutboundIntentService,
    private readonly ownership: HumanOwnershipService,
    private readonly pauses: AutomationPauseService,
    private readonly projection: HumanHandoffProjectionService,
  ) {}

  async openEpisode(
    input: Readonly<{
      workflowId: string
      expectedWorkflowVersion: number
      reasonCode: HumanReviewReasonCode
      casePacket: HumanReviewCasePacket
      recipientReference: string
      channel: OutboundChannel
      holdingTemplateVersion: number
      actorType: 'system' | 'operator'
      actorId: string
      correlationId: string
      deduplicationKey: string
      occurredAt: Date
      slaPolicy: HumanReviewSlaPolicy | null
    }>,
  ): Promise<Readonly<{ task: HumanReviewOperationalTask; sla: HumanReviewSlaSchedule; deduplicated: boolean }>> {
    if (
      !isHumanReviewCasePacket(input.casePacket) ||
      input.casePacket.workflowReference !== input.workflowId ||
      input.casePacket.summaryCode !== input.reasonCode
    ) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.RESUME_STATE_INVALID)
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const tx = bindDbTransaction(client)
      const replay = await client.query<Record<string, unknown>>(
        `SELECT ${TASK_COLUMNS} FROM human_review_tasks WHERE deduplication_key = $1`,
        [input.deduplicationKey],
      )
      const replayRow = replay.rows[0]
      if (replayRow !== undefined) {
        await client.query('COMMIT')
        const task = taskFrom(replayRow)
        return {
          task,
          sla: slaFromTask(task),
          deduplicated: true,
        }
      }

      const current = await this.projection.loadInside(client, input.workflowId)
      if (current.version !== input.expectedWorkflowVersion) {
        throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.STALE_VERSION)
      }
      const episode = await client.query<Record<string, unknown>>(
        `SELECT coalesce(max(episode_number), 0)::integer + 1 AS next_episode
           FROM human_review_tasks WHERE workflow_id = $1`,
        [input.workflowId],
      )
      const episodeNumber = episode.rows[0]?.next_episode
      if (typeof episodeNumber !== 'number' || !Number.isInteger(episodeNumber)) {
        throw new Error('human review episode query returned invalid next_episode')
      }
      const sla = scheduleHumanReviewSla(input.occurredAt, input.casePacket.priority, input.slaPolicy)
      const inserted = await client.query<Record<string, unknown>>(
        `INSERT INTO human_review_tasks (
           workflow_id, campaign_id, workflow_reference, episode_number, reason_code, priority,
           status, case_packet, case_packet_version, automation_paused,
           sla_policy_version, due_at, escalation_at, deduplication_key, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'open',$7::jsonb,$8,true,$9,$10,$11,$12,$13,$13)
         RETURNING ${TASK_COLUMNS}`,
        [
          input.workflowId,
          current.campaignId,
          input.workflowId,
          episodeNumber,
          input.reasonCode,
          input.casePacket.priority,
          JSON.stringify(input.casePacket),
          HUMAN_REVIEW_CASE_PACKET_VERSION,
          sla.state === 'scheduled' ? sla.policyVersion : null,
          sla.state === 'scheduled' ? sla.dueAt : null,
          sla.state === 'scheduled' ? sla.escalationAt : null,
          input.deduplicationKey,
          input.occurredAt,
        ],
      )
      const insertedRow = inserted.rows[0]
      if (insertedRow === undefined) throw new Error('human review task insert returned no row')
      const task = taskFrom(insertedRow)
      await appendTaskEvent(tx, {
        taskId: task.id,
        eventType: 'created',
        fromStatus: null,
        toStatus: 'open',
        actorId: input.actorId,
        reasonCode: HUMAN_REVIEW_OPERATION_REASON.EPISODE_CREATED,
        correlationId: input.correlationId,
        detail: { episode_number: episodeNumber, sla_state: sla.state },
        deduplicationKey: `${task.id}:created`,
        occurredAt: input.occurredAt,
      })
      const projected = await this.projection.applyInside(client, {
        action: 'queue',
        workflowId: input.workflowId,
        expectedVersion: input.expectedWorkflowVersion,
        taskId: task.id,
        actorType: input.actorType,
        actorId: input.actorId,
        correlationId: input.correlationId,
        occurredAt: input.occurredAt,
      })
      const holding = await this.outbound.enqueueIntent(tx, {
        workflowId: input.workflowId,
        channel: input.channel,
        recipientReference: input.recipientReference,
        purpose: MESSAGE_PURPOSES.HUMAN_HANDOFF_HOLDING,
        templatePurposeCode: MESSAGE_PURPOSES.HUMAN_HANDOFF_HOLDING,
        templateVersion: input.holdingTemplateVersion,
        contentVersion: `handoff-${task.id}-v${String(input.holdingTemplateVersion)}`,
        businessEventVersion: task.id,
        variables: {},
        source: 'automated',
        actorId: input.actorId,
        occurredAt: input.occurredAt,
      })
      await client.query(
        `INSERT INTO human_review_holding_messages (
           task_id, template_version, outbound_notification_id, created_at
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT (task_id, template_version) DO NOTHING`,
        [task.id, input.holdingTemplateVersion, holding.id, input.occurredAt],
      )
      await appendTaskEvent(tx, {
        taskId: task.id,
        eventType: 'holding_queued',
        fromStatus: 'open',
        toStatus: 'open',
        actorId: input.actorId,
        reasonCode: HUMAN_REVIEW_OPERATION_REASON.HOLDING_QUEUED,
        correlationId: input.correlationId,
        detail: {
          outbound_notification_id: holding.id,
          template_version: input.holdingTemplateVersion,
          workflow_version: projected.version,
        },
        deduplicationKey: `${task.id}:holding:${String(input.holdingTemplateVersion)}`,
        occurredAt: input.occurredAt,
      })
      await client.query('COMMIT')
      return { task, sla, deduplicated: false }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async assign(
    input: Readonly<{
      taskId: string
      operatorId: string
      authorized: boolean
      expectedWorkflowVersion: number
      reasonCode: string
      correlationId: string
      occurredAt: Date
    }>,
  ): Promise<HumanReviewOperationalTask> {
    if (!input.authorized) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.OPERATOR_NOT_AUTHORIZED)
    }
    return this.withTransaction(async (client, tx) => {
      const task = await this.taskInside(client, input.taskId)
      const workflowId = this.workflowIdForOperations(task)
      if (task.status === 'in_progress' && task.assigneeId === input.operatorId) return task
      if (task.status !== 'open' || task.assigneeId !== null) {
        throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.TASK_NOT_OPEN)
      }
      await this.projection.applyInside(client, {
        action: 'assign',
        workflowId,
        expectedVersion: input.expectedWorkflowVersion,
        taskId: task.id,
        actorType: 'operator',
        actorId: input.operatorId,
        correlationId: input.correlationId,
        occurredAt: input.occurredAt,
      })
      try {
        await this.ownership.takeOwnershipInside(tx, {
          workflowId,
          operatorId: input.operatorId,
          reasonCode: input.reasonCode,
          occurredAt: input.occurredAt,
        })
      } catch (error) {
        if (error instanceof HumanOwnershipError) {
          throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.OWNERSHIP_CONFLICT)
        }
        throw error
      }
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE human_review_tasks
            SET status = 'in_progress', assignee_id = $2, assigned_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'open'
          RETURNING ${TASK_COLUMNS}`,
        [task.id, input.operatorId, input.occurredAt],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.TASK_NOT_OPEN)
      await appendTaskEvent(tx, {
        taskId: task.id,
        eventType: 'assigned',
        fromStatus: 'open',
        toStatus: 'in_progress',
        actorId: input.operatorId,
        reasonCode: HUMAN_REVIEW_OPERATION_REASON.ASSIGNED,
        correlationId: input.correlationId,
        detail: { assignment_reason_code: input.reasonCode },
        deduplicationKey: `${task.id}:assigned:${input.operatorId}`,
        occurredAt: input.occurredAt,
      })
      return taskFrom(row)
    })
  }

  async release(
    input: Readonly<{
      taskId: string
      operatorId: string
      authorized: boolean
      expectedWorkflowVersion: number
      reasonCode: string
      correlationId: string
      occurredAt: Date
    }>,
  ): Promise<HumanReviewOperationalTask> {
    if (!input.authorized) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.OPERATOR_NOT_AUTHORIZED)
    }
    return this.withTransaction(async (client, tx) => {
      const task = await this.taskInside(client, input.taskId)
      const workflowId = this.workflowIdForOperations(task)
      this.assertOwner(task, input.operatorId)
      await this.projection.applyInside(client, {
        action: 'release',
        workflowId,
        expectedVersion: input.expectedWorkflowVersion,
        taskId: task.id,
        actorType: 'operator',
        actorId: input.operatorId,
        correlationId: input.correlationId,
        occurredAt: input.occurredAt,
      })
      await this.ownership.releaseOwnershipInside(tx, workflowId, input.operatorId, input.occurredAt)
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE human_review_tasks
            SET status = 'open', assignee_id = null, assigned_at = null, updated_at = $2
          WHERE id = $1 AND status = 'in_progress'
          RETURNING ${TASK_COLUMNS}`,
        [task.id, input.occurredAt],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.TASK_NOT_OPEN)
      await appendTaskEvent(tx, {
        taskId: task.id,
        eventType: 'released',
        fromStatus: 'in_progress',
        toStatus: 'open',
        actorId: input.operatorId,
        reasonCode: HUMAN_REVIEW_OPERATION_REASON.RELEASED,
        correlationId: input.correlationId,
        detail: { release_reason_code: input.reasonCode },
        deduplicationKey: `${task.id}:released:${input.correlationId}`,
        occurredAt: input.occurredAt,
      })
      return taskFrom(row)
    })
  }

  async resolveAndReturn(
    input: Readonly<{
      taskId: string
      operatorId: string
      authorized: boolean
      expectedWorkflowVersion: number
      resolutionCode: string
      resolutionReason: string
      validation: HumanReviewReturnValidation
      correlationId: string
      occurredAt: Date
    }>,
  ): Promise<HumanReviewOperationalTask> {
    if (!input.authorized) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.OPERATOR_NOT_AUTHORIZED)
    }
    if (!OPERATION_CODE.test(input.resolutionCode)) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.RESOLUTION_CODE_INVALID)
    }
    if (input.resolutionReason.trim().length === 0 || input.resolutionReason.length > 500) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.RESOLUTION_REASON_REQUIRED)
    }
    const validationAgeMs = input.occurredAt.getTime() - input.validation.evaluatedAt.getTime()
    if (
      Number.isNaN(input.validation.evaluatedAt.getTime()) ||
      validationAgeMs < 0 ||
      validationAgeMs > 5 * 60_000 ||
      !/^[a-z][a-z0-9-]*-v[0-9]+$/.test(input.validation.policyVersion)
    ) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.RESUME_STATE_INVALID)
    }
    const client = await this.pool.connect()
    let rejected: HumanReviewOperationError | undefined
    try {
      await client.query('BEGIN')
      const tx = bindDbTransaction(client)
      const task = await this.taskInside(client, input.taskId)
      const workflowId = this.workflowIdForOperations(task)
      this.assertOwner(task, input.operatorId)
      if (!task.casePacket.allowedActionCodes.includes('RETURN_TO_AUTOMATION')) {
        rejected = new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.RETURN_ACTION_NOT_ALLOWED)
      }
      if (
        !input.validation.optOutClear ||
        !input.validation.requiredEvidenceCurrent ||
        !input.validation.deterministicReadinessPassed
      ) {
        rejected = new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.RESUME_STATE_INVALID)
      }
      const workflow = await this.projection.loadInside(client, workflowId)
      if (workflow.version !== input.expectedWorkflowVersion) {
        rejected = new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.RESUME_STATE_INVALID)
      } else if (workflow.campaignStatus !== 'active') {
        rejected = new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.CAMPAIGN_NOT_ACTIVE)
      }
      const activePauses = await this.pauses.effectiveForRecord(client, {
        id: workflow.workflowId,
        participantId: workflow.participantId,
        campaignId: workflow.campaignId,
        campaignType: workflow.campaignType,
      })
      if (activePauses.length > 0) {
        rejected = new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.ACTIVE_PAUSE)
      }
      const otherTasks = await client.query<Record<string, unknown>>(
        `SELECT count(*)::integer AS count
           FROM human_review_tasks
          WHERE workflow_id = $1 AND id <> $2 AND status IN ('open', 'in_progress')`,
        [workflowId, task.id],
      )
      if (otherTasks.rows[0]?.count !== 0) {
        rejected = new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.OTHER_OPEN_TASK)
      }
      if (rejected !== undefined) {
        await appendTaskEvent(tx, {
          taskId: task.id,
          eventType: 'resume_rejected',
          fromStatus: 'in_progress',
          toStatus: 'in_progress',
          actorId: input.operatorId,
          reasonCode: rejected.reasonCode,
          correlationId: input.correlationId,
          detail: {
            expected_workflow_version: input.expectedWorkflowVersion,
            actual_workflow_version: workflow.version,
            validation_policy_version: input.validation.policyVersion,
            opt_out_clear: input.validation.optOutClear,
            required_evidence_current: input.validation.requiredEvidenceCurrent,
            deterministic_readiness_passed: input.validation.deterministicReadinessPassed,
          },
          deduplicationKey: `${task.id}:resume-rejected:${input.correlationId}`,
          occurredAt: input.occurredAt,
        })
        await client.query('COMMIT')
        throw rejected
      } else {
        await this.projection.applyInside(client, {
          action: 'return',
          workflowId,
          expectedVersion: input.expectedWorkflowVersion,
          taskId: task.id,
          actorType: 'operator',
          actorId: input.operatorId,
          correlationId: input.correlationId,
          occurredAt: input.occurredAt,
        })
        await this.ownership.releaseOwnershipInside(tx, workflowId, input.operatorId, input.occurredAt)
        const updated = await client.query<Record<string, unknown>>(
          `UPDATE human_review_tasks
              SET status = 'resolved', automation_paused = false,
                  resolved_at = $3, resolved_by = $2, resolution_code = $4,
                  resolution_reason = $5, returned_to_automation_at = $3, updated_at = $3
            WHERE id = $1 AND status = 'in_progress'
            RETURNING ${TASK_COLUMNS}`,
          [task.id, input.operatorId, input.occurredAt, input.resolutionCode, input.resolutionReason.trim()],
        )
        const row = updated.rows[0]
        if (row === undefined) throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.TASK_NOT_OPEN)
        await appendTaskEvent(tx, {
          taskId: task.id,
          eventType: 'resolution_recorded',
          fromStatus: 'in_progress',
          toStatus: 'resolved',
          actorId: input.operatorId,
          reasonCode: HUMAN_REVIEW_OPERATION_REASON.RESOLUTION_RECORDED,
          correlationId: input.correlationId,
          detail: { resolution_code: input.resolutionCode },
          deduplicationKey: `${task.id}:resolution:${input.resolutionCode}`,
          occurredAt: input.occurredAt,
        })
        await appendTaskEvent(tx, {
          taskId: task.id,
          eventType: 'returned_to_automation',
          fromStatus: 'resolved',
          toStatus: 'resolved',
          actorId: input.operatorId,
          reasonCode: HUMAN_REVIEW_OPERATION_REASON.RETURNED_TO_AUTOMATION,
          correlationId: input.correlationId,
          detail: {
            expected_workflow_version: input.expectedWorkflowVersion,
            validation_policy_version: input.validation.policyVersion,
            validation_evaluated_at: input.validation.evaluatedAt.toISOString(),
          },
          deduplicationKey: `${task.id}:returned-to-automation`,
          occurredAt: input.occurredAt,
        })
        await client.query('COMMIT')
        return taskFrom(row)
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    throw new Error('human review resolution completed without a result')
  }

  async queue(filters: HumanReviewQueueFilters = {}): Promise<readonly HumanReviewOperationalTask[]> {
    const values: unknown[] = []
    const conditions: string[] = []
    const add = (sql: string, value: unknown): void => {
      values.push(value)
      conditions.push(sql.replace('?', `$${String(values.length)}`))
    }
    if (filters.status !== undefined) add('status = ?', filters.status)
    if (filters.priority !== undefined) add('priority = ?', filters.priority)
    if (filters.campaignId !== undefined) add('campaign_id = ?', filters.campaignId)
    if (filters.reasonCode !== undefined) add('reason_code = ?', filters.reasonCode)
    if (filters.assigneeId === null) conditions.push('assignee_id is null')
    else if (filters.assigneeId !== undefined) add('assignee_id = ?', filters.assigneeId)
    if (filters.createdBefore !== undefined) add('created_at < ?', filters.createdBefore)
    if (filters.overdueAt !== undefined)
      add("due_at is not null AND due_at < ? AND status IN ('open', 'in_progress')", filters.overdueAt)
    const limit = filters.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('human review queue limit is invalid')
    values.push(limit)
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${TASK_COLUMNS}
         FROM human_review_tasks
        ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
        ORDER BY
          CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
          due_at NULLS LAST, created_at, id
        LIMIT $${String(values.length)}`,
      values,
    )
    return result.rows.map(taskFrom)
  }

  private async taskInside(client: PoolClient, taskId: string): Promise<HumanReviewOperationalTask> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${TASK_COLUMNS} FROM human_review_tasks WHERE id = $1 FOR UPDATE`,
      [taskId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.TASK_NOT_FOUND)
    return taskFrom(row)
  }

  private assertOwner(task: HumanReviewOperationalTask, operatorId: string): void {
    if (task.status !== 'in_progress' || task.assigneeId !== operatorId) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.OWNERSHIP_CONFLICT)
    }
  }

  private workflowIdForOperations(task: HumanReviewOperationalTask): string {
    if (
      task.workflowId === null ||
      task.campaignId === null ||
      task.casePacketVersion !== HUMAN_REVIEW_CASE_PACKET_VERSION ||
      !isHumanReviewCasePacket(task.casePacket)
    ) {
      throw new HumanReviewOperationError(HUMAN_REVIEW_OPERATION_REASON.RESUME_STATE_INVALID)
    }
    return task.workflowId
  }

  private async withTransaction<T>(operation: (client: PoolClient, tx: DbTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client, bindDbTransaction(client))
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
