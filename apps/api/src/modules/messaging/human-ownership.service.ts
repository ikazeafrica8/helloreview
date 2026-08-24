import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import { Pool } from 'pg'
import { MESSAGING_REASON } from './reason-codes.js'

export type OperatorOwnership = Readonly<{
  id: string
  workflowId: string
  operatorId: string
  reasonCode: string
  startedAt: Date
  endedAt?: Date
  endedBy?: string
}>

export type TakeOwnershipInput = Readonly<{
  workflowId: string
  operatorId: string
  reasonCode: string
  occurredAt: Date
}>

export class HumanOwnershipError extends Error {
  override readonly name = 'HumanOwnershipError'

  constructor(
    readonly reasonCode: typeof MESSAGING_REASON.OWNERSHIP_CONFLICT | typeof MESSAGING_REASON.WORKFLOW_NOT_FOUND,
  ) {
    super(`human ownership rejected: ${reasonCode}`)
  }
}

const ownershipFrom = (row: Record<string, unknown>): OperatorOwnership => {
  if (
    typeof row.id !== 'string' ||
    typeof row.workflow_id !== 'string' ||
    typeof row.operator_id !== 'string' ||
    typeof row.reason_code !== 'string' ||
    !(row.started_at instanceof Date)
  ) {
    throw new Error('operator assignment query returned an invalid row')
  }
  return {
    id: row.id,
    workflowId: row.workflow_id,
    operatorId: row.operator_id,
    reasonCode: row.reason_code,
    startedAt: row.started_at,
    ...(row.ended_at instanceof Date ? { endedAt: row.ended_at } : {}),
    ...(typeof row.ended_by === 'string' ? { endedBy: row.ended_by } : {}),
  }
}

@Injectable()
export class HumanOwnershipService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async takeOwnership(input: TakeOwnershipInput): Promise<OperatorOwnership> {
    return runInTransaction(this.pool, async (tx) => {
      await this.lockWorkflow(tx, input.workflowId)
      const current = await this.activeInside(tx, input.workflowId)
      if (current !== undefined) {
        if (current.operatorId === input.operatorId) return current
        throw new HumanOwnershipError(MESSAGING_REASON.OWNERSHIP_CONFLICT)
      }

      const inserted = await tx.query(
        `INSERT INTO operator_assignments (workflow_id, operator_id, reason_code, started_at)
         VALUES ($1,$2,$3,$4)
         RETURNING id, workflow_id, operator_id, reason_code, started_at, ended_at, ended_by`,
        [input.workflowId, input.operatorId, input.reasonCode, input.occurredAt],
      )
      const row = inserted.rows[0]
      if (row === undefined) throw new Error('operator assignment insert returned no row')
      return ownershipFrom(row)
    })
  }

  async releaseOwnership(workflowId: string, operatorId: string, occurredAt: Date): Promise<OperatorOwnership> {
    return runInTransaction(this.pool, async (tx) => {
      await this.lockWorkflow(tx, workflowId)
      const current = await this.activeInside(tx, workflowId)
      if (current?.operatorId !== operatorId) {
        throw new HumanOwnershipError(MESSAGING_REASON.OWNERSHIP_CONFLICT)
      }
      const updated = await tx.query(
        `UPDATE operator_assignments
            SET ended_at = $3, ended_by = $2
          WHERE id = $1
          RETURNING id, workflow_id, operator_id, reason_code, started_at, ended_at, ended_by`,
        [current.id, operatorId, occurredAt],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new Error('operator assignment release returned no row')
      return ownershipFrom(row)
    })
  }

  private async lockWorkflow(tx: DbTransaction, workflowId: string): Promise<void> {
    const result = await tx.query(`SELECT id FROM workflow_instances WHERE id = $1 FOR UPDATE`, [workflowId])
    if (result.rows[0] === undefined) throw new HumanOwnershipError(MESSAGING_REASON.WORKFLOW_NOT_FOUND)
  }

  private async activeInside(tx: DbTransaction, workflowId: string): Promise<OperatorOwnership | undefined> {
    const result = await tx.query(
      `SELECT id, workflow_id, operator_id, reason_code, started_at, ended_at, ended_by
         FROM operator_assignments
        WHERE workflow_id = $1 AND ended_at IS NULL`,
      [workflowId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : ownershipFrom(row)
  }
}
