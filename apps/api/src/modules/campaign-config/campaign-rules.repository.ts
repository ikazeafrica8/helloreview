import { Inject, Injectable } from '@nestjs/common'
import { Pool } from 'pg'
import { POSTGRES_POOL } from '../platform-core/index.js'

// Reading campaign rules (PRD §13.5, FR-CAM-007, T21).
//
// RESOLVING "WHICH VERSION APPLIED AT INSTANT X" IS A QUERY, NOT CALLER ARITHMETIC. That is T21's
// third acceptance criterion, and it is a correctness requirement rather than a style preference:
// a caller that fetches all versions and picks one in TypeScript has to reimplement the interval
// comparison every time, and the two subtly different implementations that result will disagree at
// the boundary — which is exactly where FR-CAM-007's "no silent retroactive rule application"
// either holds or does not.
//
// THE INTERVAL IS HALF-OPEN: [effective_from, effective_to). A reservation at the exact instant a
// new version takes effect is governed by the NEW version, and the old version's last governed
// instant is the one before. Closed-closed would make both versions apply at that instant, and
// "which rules were in force?" would have two answers precisely at the moment somebody is most
// likely to ask.

export type ResolvedRuleVersion = Readonly<{
  id: string
  campaignId: string
  ruleType: string
  version: number
  status: string
  configuration: unknown
  effectiveFrom: Date
  effectiveTo: Date | null
}>

const COLUMNS = `id, campaign_id, rule_type, version, status, configuration, effective_from, effective_to`

const asString = (value: unknown, column: string): string => {
  if (typeof value === 'string') return value
  throw new Error(`campaign_rules.${column} was not a string`)
}

const asDate = (value: unknown, column: string): Date => {
  if (value instanceof Date) return value
  if (typeof value === 'string') return new Date(value)
  throw new Error(`campaign_rules.${column} was not a timestamp`)
}

const toResolved = (row: Record<string, unknown>): ResolvedRuleVersion => ({
  id: asString(row.id, 'id'),
  campaignId: asString(row.campaign_id, 'campaign_id'),
  ruleType: asString(row.rule_type, 'rule_type'),
  version: Number(row.version),
  status: asString(row.status, 'status'),
  configuration: row.configuration,
  effectiveFrom: asDate(row.effective_from, 'effective_from'),
  effectiveTo:
    row.effective_to === null || row.effective_to === undefined ? null : asDate(row.effective_to, 'effective_to'),
})

@Injectable()
export class CampaignRulesRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * The rule version of `ruleType` that governed `campaignId` at `at`.
   *
   * `at` is a PARAMETER, never `now()` inside the SQL. Two reasons, and the second is the one that
   * matters: a test cannot pin a clock inside the database, and — more importantly — replaying an
   * event (§22.3) has to resolve the rules that applied at the event's ORIGINAL occurred_at, not at
   * the moment of replay. A query that read the clock itself would silently apply today's rules to
   * yesterday's decision, which is the retroactive application FR-CAM-007 forbids.
   *
   * DRAFTS ARE EXCLUDED. A draft has no effective period in any meaningful sense; treating one as
   * current would let unreviewed configuration govern a live participant.
   */
  async resolveEffectiveVersion(
    campaignId: string,
    ruleType: string,
    at: Date,
  ): Promise<ResolvedRuleVersion | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM campaign_rules
        WHERE campaign_id = $1
          AND rule_type = $2
          AND status IN ('published', 'superseded')
          AND effective_from <= $3
          AND (effective_to IS NULL OR effective_to > $3)
        ORDER BY effective_from DESC, version DESC
        LIMIT 1`,
      [campaignId, ruleType, at],
    )

    const row = result.rows[0]
    return row === undefined ? undefined : toResolved(row)
  }

  /**
   * The version in force right now.
   *
   * A distinct query rather than `resolveEffectiveVersion(id, type, new Date())`, because "current"
   * has a stricter definition: it is the OPEN-ENDED published version, which the partial unique
   * index guarantees there is at most one of. Resolving by timestamp would also return a version
   * whose window happens to contain now — the same row in the ordinary case, but not if a version
   * was closed with a future `effective_to`.
   */
  async currentVersion(campaignId: string, ruleType: string): Promise<ResolvedRuleVersion | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM campaign_rules
        WHERE campaign_id = $1 AND rule_type = $2 AND status = 'published' AND effective_to IS NULL
        LIMIT 1`,
      [campaignId, ruleType],
    )

    const row = result.rows[0]
    return row === undefined ? undefined : toResolved(row)
  }

  /** Every version of a rule type, newest first. For an operator reconstructing a decision. */
  async versionHistory(campaignId: string, ruleType: string): Promise<readonly ResolvedRuleVersion[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM campaign_rules
        WHERE campaign_id = $1 AND rule_type = $2
        ORDER BY version DESC`,
      [campaignId, ruleType],
    )
    return result.rows.map(toResolved)
  }
}
