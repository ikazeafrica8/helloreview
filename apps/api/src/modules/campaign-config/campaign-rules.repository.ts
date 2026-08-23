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

/** One allowed reservation interval on one weekday, with its boundary behaviour (§16.7). */
export type ReservationWindow = Readonly<{
  id: string
  /** ISO-8601: 1 = Monday through 7 = Sunday. */
  isoWeekday: number
  /** Local wall-clock time, "HH:MM:SS". Not an instant — see the schema note. */
  startsAt: string
  endsAt: string
  startInclusive: boolean
  endInclusive: boolean
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

  /**
   * Every allowed window for one weekday of a rule version (T22, §16.7).
   *
   * Returns ALL of them, which is the whole point. §16.7's Time check reads "Time falls inside AT
   * LEAST ONE allowed interval", so a business open 11:00–14:00 and again 17:00–21:00 needs both
   * rows evaluated — and a caller that took only the first would silently accept 15:00, when the
   * business is closed.
   *
   * The weekday is ISO-8601 (1 = Monday), matching what `Date.prototype.getDay()` does NOT return.
   * Callers must convert; the mismatch is exactly the kind of off-by-one that puts a Sunday
   * reservation into Saturday's windows, so the boundary is named here rather than assumed.
   */
  async reservationWindows(campaignRuleId: string, isoWeekday: number): Promise<readonly ReservationWindow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id, weekday, starts_at, ends_at, start_inclusive, end_inclusive
         FROM campaign_time_windows
        WHERE campaign_rule_id = $1 AND weekday = $2
        ORDER BY starts_at`,
      [campaignRuleId, String(isoWeekday)],
    )

    return result.rows.map((row) => ({
      id: asString(row.id, 'id'),
      isoWeekday: Number(asString(row.weekday, 'weekday')),
      startsAt: asString(row.starts_at, 'starts_at'),
      endsAt: asString(row.ends_at, 'ends_at'),
      startInclusive: row.start_inclusive === true,
      endInclusive: row.end_inclusive === true,
    }))
  }

  /**
   * Is `isoDate` blacked out for this rule version (T22, §16.7)?
   *
   * Takes a calendar date string (YYYY-MM-DD) in the campaign's timezone, never a Date. Passing a
   * Date would force this query to pick a time of day, and midnight UTC is 09:00 in Seoul — so an
   * 08:00 Seoul reservation on a blacked-out day would compare against the previous date and pass.
   */
  async isBlackout(campaignRuleId: string, isoDate: string): Promise<boolean> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT 1 FROM campaign_blackouts WHERE campaign_rule_id = $1 AND blackout_date = $2 LIMIT 1`,
      [campaignRuleId, isoDate],
    )
    return result.rows.length > 0
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
