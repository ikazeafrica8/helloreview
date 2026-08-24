import { Injectable } from '@nestjs/common'
import type { PoolClient } from 'pg'
import { humanReviewPriority, type HumanReviewPriority } from './handoff-priority.js'
import type { HumanReviewReasonCode } from './reason-codes.js'

export type MaskedCasePacket = Readonly<{
  stateCode: string
  summaryCode: HumanReviewReasonCode
  evidenceCodes: readonly string[]
  allowedActionCodes: readonly string[]
  recommendationCode: string
}>

export type HumanReviewTask = Readonly<{
  id: string
  workflowReference: string
  identityResolutionId: string | null
  reasonCode: HumanReviewReasonCode
  priority: HumanReviewPriority
  status: 'open' | 'in_progress' | 'resolved' | 'cancelled'
  casePacket: MaskedCasePacket
  automationPaused: boolean
  createdAt: Date
}>

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`human review task query returned an invalid ${column}`)
}

const taskFromRow = (
  row: Record<string, unknown>,
  expected: Readonly<{
    reasonCode: HumanReviewReasonCode
    priority: HumanReviewPriority
    casePacket: MaskedCasePacket
  }>,
): HumanReviewTask => {
  const priority = stringColumn(row, 'priority')
  if (priority !== 'normal' && priority !== 'high' && priority !== 'critical') {
    throw new Error('human review task query returned an invalid priority')
  }
  if (priority !== expected.priority || stringColumn(row, 'reason_code') !== expected.reasonCode) {
    throw new Error('human review task replay did not match the requested reason and priority')
  }
  const status = stringColumn(row, 'status')
  if (status !== 'open' && status !== 'in_progress' && status !== 'resolved' && status !== 'cancelled') {
    throw new Error('human review task query returned an invalid status')
  }
  const createdAt = row.created_at
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new Error('human review task query returned an invalid created_at')
  }
  const identityResolutionId = row.identity_resolution_id
  if (identityResolutionId !== null && typeof identityResolutionId !== 'string') {
    throw new Error('human review task query returned an invalid identity_resolution_id')
  }
  const automationPaused = row.automation_paused
  if (typeof automationPaused !== 'boolean') {
    throw new Error('human review task query returned an invalid automation_paused')
  }
  return {
    id: stringColumn(row, 'id'),
    workflowReference: stringColumn(row, 'workflow_reference'),
    identityResolutionId,
    reasonCode: expected.reasonCode,
    priority,
    status,
    casePacket: expected.casePacket,
    automationPaused,
    createdAt,
  }
}

@Injectable()
export class HumanReviewTaskService {
  async createIdentityReviewTask(
    client: PoolClient,
    input: Readonly<{
      workflowReference: string
      identityResolutionId: string
      reasonCode: HumanReviewReasonCode
      stateCode: string
      evidenceCodes: readonly string[]
      recommendationCode: string
      createdAt: Date
    }>,
  ): Promise<HumanReviewTask> {
    const priority = humanReviewPriority(input.reasonCode)
    const casePacket: MaskedCasePacket = {
      stateCode: input.stateCode,
      summaryCode: input.reasonCode,
      evidenceCodes: [...input.evidenceCodes],
      allowedActionCodes: ['VERIFY_IDENTITY', 'KEEP_AUTOMATION_PAUSED'],
      recommendationCode: input.recommendationCode,
    }
    const deduplicationKey = `identity-resolution:${input.identityResolutionId}`
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO human_review_tasks (
         workflow_reference, identity_resolution_id, reason_code, priority, status,
         case_packet, automation_paused, deduplication_key, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'open',$5::jsonb,true,$6,$7,$7)
       ON CONFLICT (deduplication_key) DO NOTHING
       RETURNING id, workflow_reference, identity_resolution_id, reason_code, priority,
                 status, case_packet, automation_paused, created_at`,
      [
        input.workflowReference,
        input.identityResolutionId,
        input.reasonCode,
        priority,
        JSON.stringify(casePacket),
        deduplicationKey,
        input.createdAt,
      ],
    )
    const insertedRow = inserted.rows[0]
    const expected = { reasonCode: input.reasonCode, priority, casePacket }
    if (insertedRow !== undefined) return taskFromRow(insertedRow, expected)

    const existing = await client.query<Record<string, unknown>>(
      `SELECT id, workflow_reference, identity_resolution_id, reason_code, priority,
              status, case_packet, automation_paused, created_at
         FROM human_review_tasks WHERE deduplication_key = $1`,
      [deduplicationKey],
    )
    const existingRow = existing.rows[0]
    if (existingRow === undefined) throw new Error('human review task replay was not visible')
    return taskFromRow(existingRow, expected)
  }
}
