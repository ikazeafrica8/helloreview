// Integration tier: reservation windows and blackouts (T22, PRD §16.7, FR-RES-004/005).
//
// These two tables are what §16.7's Weekday, Time, Boundary and Blackout checks read. Each of those
// checks has a participant-facing consequence — a correction message telling someone their booking
// is invalid — so a schema that cannot express the real configuration produces a platform that
// tells correct bookings they are wrong.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

/** A campaign with one published reservation rule version, plus a repository. */
const setup = async (url) => {
  const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')
  const { CampaignRulesRepository } = await importBuilt('apps/api/dist/modules/campaign-config/index.js')
  await applyMigrations(url)

  const client = createDbClient(url)
  const campaign = await client.query(
    `INSERT INTO campaigns (code, name, type, visit_method, starts_at, ends_at)
     VALUES ('c1', 'Campaign One', 'visit', 'visit_b', now(), now() + interval '30 days')
     RETURNING id`,
  )
  const campaignId = String(campaign.rows[0].id)

  const rule = await client.query(
    `INSERT INTO campaign_rules (campaign_id, rule_type, version, status, configuration, effective_from)
     VALUES ($1, 'reservation', 1, 'published', '{}', now())
     RETURNING id`,
    [campaignId],
  )
  const ruleId = String(rule.rows[0].id)

  return { client, campaignId, ruleId, repository: new CampaignRulesRepository({ query: client.query }) }
}

const addWindow = async (client, ruleId, weekday, startsAt, endsAt, options = {}) =>
  client.query(
    `INSERT INTO campaign_time_windows (campaign_rule_id, weekday, starts_at, ends_at, start_inclusive, end_inclusive)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ruleId, String(weekday), startsAt, endsAt, options.startInclusive ?? true, options.endInclusive ?? false],
  )

describe('reservation windows and blackouts', () => {
  beforeAll(() => {
    for (const workspace of ['packages/db', 'packages/testing', 'apps/api']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('T22 criterion 1: multiple windows on one weekday persist and ALL are returned', async () => {
    // The lunch break. A business open 11:00–14:00 and again 17:00–21:00 is ordinary, and §16.7's
    // Time check reads "at least one allowed interval". A schema with one start and one end per
    // weekday cannot express it, and the workaround — a single 11:00–21:00 window — silently
    // accepts a 15:00 booking when the business is closed.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, ruleId, repository } = await setup(url)
      try {
        await addWindow(client, ruleId, 2, '11:00:00', '14:00:00')
        await addWindow(client, ruleId, 2, '17:00:00', '21:00:00')

        const windows = await repository.reservationWindows(ruleId, 2)

        expect(windows).toHaveLength(2)
        expect(windows.map((w) => `${w.startsAt}-${w.endsAt}`)).toEqual(['11:00:00-14:00:00', '17:00:00-21:00:00'])
        // The gap between them is the point: nothing here says 15:00 is allowed.
        expect(windows.some((w) => w.startsAt <= '15:00:00' && '15:00:00' < w.endsAt)).toBe(false)
      } finally {
        await client.close()
      }
    })
  })

  test('windows are scoped to their weekday, so Tuesday cannot leak into Wednesday', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, ruleId, repository } = await setup(url)
      try {
        await addWindow(client, ruleId, 2, '11:00:00', '14:00:00')
        await addWindow(client, ruleId, 3, '09:00:00', '18:00:00')

        expect(await repository.reservationWindows(ruleId, 2)).toHaveLength(1)
        expect((await repository.reservationWindows(ruleId, 3))[0]?.startsAt).toBe('09:00:00')
        // A weekday with no windows configured is closed, not unconstrained.
        expect(await repository.reservationWindows(ruleId, 7)).toHaveLength(0)
      } finally {
        await client.close()
      }
    })
  })

  test('T22 criterion 2: boundary inclusivity is stored PER WINDOW', async () => {
    // §16.7 lists Boundary as its own check. A shop may accept a booking at closing time for a
    // 10-minute service and refuse it for a 90-minute one — a property of the window, not of the
    // platform, so a global setting would make one of the two campaigns wrong.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, ruleId, repository } = await setup(url)
      try {
        await addWindow(client, ruleId, 1, '09:00:00', '12:00:00', { startInclusive: true, endInclusive: true })
        await addWindow(client, ruleId, 1, '13:00:00', '18:00:00', { startInclusive: false, endInclusive: false })

        const windows = await repository.reservationWindows(ruleId, 1)

        expect(windows[0]).toMatchObject({ startInclusive: true, endInclusive: true })
        expect(windows[1]).toMatchObject({ startInclusive: false, endInclusive: false })
      } finally {
        await client.close()
      }
    })
  })

  test('the default is start-inclusive and end-EXCLUSIVE', async () => {
    // Asymmetric on purpose. 11:00–14:00 normally means bookings stop at 14:00, not that 14:00 is
    // the last acceptable slot — and defaulting both ends to inclusive would make adjacent windows
    // overlap at their shared boundary, so 14:00 would fall in both the morning and afternoon one.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, ruleId, repository } = await setup(url)
      try {
        await client.query(
          `INSERT INTO campaign_time_windows (campaign_rule_id, weekday, starts_at, ends_at)
           VALUES ($1, '4', '10:00:00', '16:00:00')`,
          [ruleId],
        )

        expect((await repository.reservationWindows(ruleId, 4))[0]).toMatchObject({
          startInclusive: true,
          endInclusive: false,
        })
      } finally {
        await client.close()
      }
    })
  })

  test('an identical duplicate window is refused; a distinct overlapping one is not', async () => {
    // Two identical rows are a configuration mistake — evaluated twice to the same answer. Distinct
    // overlapping windows stay legal: unusual but coherent, and refusing them would be the schema
    // making a judgement T25's activation validation is better placed to make.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, ruleId } = await setup(url)
      try {
        await addWindow(client, ruleId, 5, '10:00:00', '14:00:00')

        await expect(addWindow(client, ruleId, 5, '10:00:00', '14:00:00')).rejects.toThrow(
          /campaign_time_windows_no_duplicate_key/,
        )

        await addWindow(client, ruleId, 5, '13:00:00', '15:00:00')
      } finally {
        await client.close()
      }
    })
  })

  test('windows belong to a RULE VERSION, so editing them cannot rewrite the past', async () => {
    // The decision the table turns on. If windows hung off the campaign, adding one today would
    // retroactively change what "valid" meant for a reservation validated last week — the silent
    // retroactive rule application FR-CAM-007 forbids.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId, ruleId, repository } = await setup(url)
      try {
        await addWindow(client, ruleId, 2, '11:00:00', '14:00:00')

        // A second version of the same rule type, with different windows.
        await client.query(`UPDATE campaign_rules SET effective_to = now(), status = 'superseded' WHERE id = $1`, [
          ruleId,
        ])
        const v2 = await client.query(
          `INSERT INTO campaign_rules (campaign_id, rule_type, version, status, configuration, effective_from)
           VALUES ($1, 'reservation', 2, 'published', '{}', now()) RETURNING id`,
          [campaignId],
        )
        const v2Id = String(v2.rows[0].id)
        await addWindow(client, v2Id, 2, '09:00:00', '22:00:00')

        // Each version still reports its own windows. The old validation remains explicable.
        expect((await repository.reservationWindows(ruleId, 2))[0]?.startsAt).toBe('11:00:00')
        expect((await repository.reservationWindows(v2Id, 2))[0]?.startsAt).toBe('09:00:00')
      } finally {
        await client.close()
      }
    })
  })

  test('T22 criterion 3: UNIQUE(rule version, date) holds for blackouts', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId, ruleId } = await setup(url)
      try {
        await client.query(
          `INSERT INTO campaign_blackouts (campaign_rule_id, blackout_date, reason) VALUES ($1, '2026-09-17', 'Chuseok')`,
          [ruleId],
        )

        await expect(
          client.query(`INSERT INTO campaign_blackouts (campaign_rule_id, blackout_date) VALUES ($1, '2026-09-17')`, [
            ruleId,
          ]),
        ).rejects.toThrow(/campaign_blackouts_date_key/)

        // The same date under a DIFFERENT rule version is a different fact, not a duplicate.
        const other = await client.query(
          `INSERT INTO campaign_rules (campaign_id, rule_type, version, status, configuration, effective_from)
           VALUES ($1, 'guideline', 1, 'draft', '{}', now()) RETURNING id`,
          [campaignId],
        )
        await client.query(
          `INSERT INTO campaign_blackouts (campaign_rule_id, blackout_date) VALUES ($1, '2026-09-17')`,
          [String(other.rows[0].id)],
        )
      } finally {
        await client.close()
      }
    })
  })

  test('a blackout is a CALENDAR DATE, not an instant', async () => {
    // Storing it as a timestamp forces every comparison to pick a time of day, and midnight UTC is
    // 09:00 in Seoul — so an 08:00 Seoul reservation on a blacked-out day would compare against the
    // previous date and pass. §16.7's Timezone check exists because this mistake is easy.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, ruleId, repository } = await setup(url)
      try {
        await client.query(
          `INSERT INTO campaign_blackouts (campaign_rule_id, blackout_date) VALUES ($1, '2026-09-17')`,
          [ruleId],
        )

        expect(await repository.isBlackout(ruleId, '2026-09-17')).toBe(true)
        expect(await repository.isBlackout(ruleId, '2026-09-16')).toBe(false)
        expect(await repository.isBlackout(ruleId, '2026-09-18')).toBe(false)

        const { rows } = await client.query(
          `SELECT data_type FROM information_schema.columns
            WHERE table_name = 'campaign_blackouts' AND column_name = 'blackout_date'`,
        )
        expect(rows[0].data_type, 'a blackout must be a date, never a timestamp').toBe('date')
      } finally {
        await client.close()
      }
    })
  })

  test('deleting a DRAFT version discards its windows; a published one cannot be deleted at all', async () => {
    // The cascade is only safe because of that second half. Verified rather than assumed, because
    // "CASCADE is fine here" is exactly the kind of claim that stops being true after a later edit.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId, ruleId } = await setup(url)
      try {
        await addWindow(client, ruleId, 2, '11:00:00', '14:00:00')

        // Published: refused, so its windows can never be orphaned by a cascade.
        await expect(client.query(`DELETE FROM campaign_rules WHERE id = $1`, [ruleId])).rejects.toThrow(
          /published and cannot be deleted/,
        )

        const draft = await client.query(
          `INSERT INTO campaign_rules (campaign_id, rule_type, version, status, configuration, effective_from)
           VALUES ($1, 'shipping', 1, 'draft', '{}', now()) RETURNING id`,
          [campaignId],
        )
        const draftId = String(draft.rows[0].id)
        await addWindow(client, draftId, 2, '08:00:00', '09:00:00')

        await client.query(`DELETE FROM campaign_rules WHERE id = $1`, [draftId])

        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM campaign_time_windows WHERE campaign_rule_id = $1`,
          [draftId],
        )
        expect(rows[0].n).toBe(0)
      } finally {
        await client.close()
      }
    })
  })
})
