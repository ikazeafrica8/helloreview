import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import type { Pool } from 'pg'
import type { RankingEvidence } from './recommendation-evaluator.js'

export type ReadRankingEvidenceInput = Readonly<{
  workflowId: string
  participantId: string
  now: Date
  maximumAgeMs: number
  measurementPeriod: string | null
  regionMapping: Readonly<Record<string, string>>
}>

export class RankingEvidenceError extends Error {
  override readonly name = 'RankingEvidenceError'
  constructor(readonly reasonCode: 'RANKING_EVIDENCE_NOT_FOUND') {
    super(`ranking evidence rejected: ${reasonCode}`)
  }
}

const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const nullableInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

@Injectable()
export class RankingEvidenceAdapter {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async read(input: ReadRankingEvidenceInput): Promise<RankingEvidence> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT a.blogger_level, a.blog_daily_visitors, a.blogger_region,
              a.last_source_event_id, a.last_synchronized_at,
              f.last_successful_reconciliation_at
         FROM workflow_instances w
         JOIN applications a ON a.id = w.application_id
         LEFT JOIN application_source_freshness f ON f.source_system = a.source_system
        WHERE w.id = $1 AND w.participant_id = $2`,
      [input.workflowId, input.participantId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new RankingEvidenceError('RANKING_EVIDENCE_NOT_FOUND')
    const sourceFreshnessValue = row.last_successful_reconciliation_at ?? row.last_synchronized_at
    if (!(sourceFreshnessValue instanceof Date)) throw new Error('ranking evidence returned invalid freshness')
    const bloggerRegion = nullableText(row.blogger_region)
    return {
      bloggerLevel: nullableInteger(row.blogger_level),
      blogDailyVisitors: nullableInteger(row.blog_daily_visitors),
      bloggerRegion,
      mappedRegion: bloggerRegion === null ? null : (input.regionMapping[bloggerRegion] ?? null),
      measurementPeriod: input.measurementPeriod,
      sourceFreshnessAt: sourceFreshnessValue,
      sourceEventId: String(row.last_source_event_id),
      fresh: input.maximumAgeMs >= 0 && input.now.getTime() - sourceFreshnessValue.getTime() <= input.maximumAgeMs,
    }
  }
}
