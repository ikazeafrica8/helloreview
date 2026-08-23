// Integration tier: versioned, immutable campaign rules (T21, PRD §13.5, FR-CAM-001/002/005/007).
//
// Against a real migrated Postgres, because every guarantee here is a database guarantee. The
// immutability is a TRIGGER and the "one current version" rule is a PARTIAL UNIQUE INDEX; a test
// that checked the TypeScript around them would prove the application intends to behave and
// nothing about whether a migration, an admin script, or a production fix can behave otherwise.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const AT = (iso) => new Date(iso)

/** A campaign plus a repository, against a freshly migrated database. */
const setup = async (url) => {
  const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')
  const { CampaignRulesRepository } = await importBuilt('apps/api/dist/modules/campaign-config/index.js')
  await applyMigrations(url)

  const client = createDbClient(url)
  const { rows } = await client.query(
    `INSERT INTO campaigns (code, name, type, visit_method, starts_at, ends_at)
     VALUES ('c1', 'Campaign One', 'visit', 'visit_b', now(), now() + interval '30 days')
     RETURNING id`,
  )
  const campaignId = String(rows[0].id)

  // The repository takes a pg Pool. createDbClient owns one; reaching for it here keeps the test
  // using the same driver configuration the application does.
  const repository = new CampaignRulesRepository({ query: client.query })
  return { client, campaignId, repository }
}

/** Insert a rule version directly, so the test controls status and effective window exactly. */
const insertVersion = async (
  client,
  campaignId,
  { ruleType = 'selection', version, status, from, to = null, config = {} },
) =>
  client.query(
    `INSERT INTO campaign_rules (campaign_id, rule_type, version, status, configuration, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [campaignId, ruleType, version, status, JSON.stringify(config), from, to],
  )

describe('campaign rules', () => {
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

  test('T21 criterion 1: UNIQUE(campaign, rule type, version) holds', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        await insertVersion(client, campaignId, { version: 1, status: 'draft', from: AT('2026-01-01T00:00:00Z') })

        await expect(
          insertVersion(client, campaignId, { version: 1, status: 'draft', from: AT('2026-02-01T00:00:00Z') }),
        ).rejects.toThrow()

        // The same version number under a DIFFERENT rule type is fine — the types version
        // independently, so correcting a blackout must not renumber the selection threshold.
        await insertVersion(client, campaignId, {
          ruleType: 'reservation',
          version: 1,
          status: 'draft',
          from: AT('2026-01-01T00:00:00Z'),
        })
      } finally {
        await client.close()
      }
    })
  })

  test('T21 criterion 1: a PUBLISHED version rejects updates', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        await insertVersion(client, campaignId, {
          version: 1,
          status: 'published',
          from: AT('2026-01-01T00:00:00Z'),
          config: { threshold: 10 },
        })

        // The configuration is what a past decision cited. Changing it silently rewrites history.
        await expect(
          client.query(`UPDATE campaign_rules SET configuration = '{"threshold":999}' WHERE version = 1`),
        ).rejects.toThrow(/published and cannot be modified/)

        // So is moving when it started applying.
        await expect(
          client.query(`UPDATE campaign_rules SET effective_from = now() WHERE version = 1`),
        ).rejects.toThrow(/published and cannot be modified/)

        // And a published version can never go back to being editable.
        await expect(client.query(`UPDATE campaign_rules SET status = 'draft' WHERE version = 1`)).rejects.toThrow(
          /cannot move from published to draft/,
        )

        // Nor be deleted — SPEC.md §8 lists deleting business history under "Never".
        await expect(client.query(`DELETE FROM campaign_rules WHERE version = 1`)).rejects.toThrow(
          /published and cannot be deleted/,
        )

        const { rows } = await client.query(`SELECT configuration FROM campaign_rules WHERE version = 1`)
        expect(rows[0].configuration).toEqual({ threshold: 10 })
      } finally {
        await client.close()
      }
    })
  })

  test('a DRAFT is still freely editable — freezing it would make the table unusable', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        await insertVersion(client, campaignId, {
          version: 1,
          status: 'draft',
          from: AT('2026-01-01T00:00:00Z'),
          config: { threshold: 10 },
        })
        await client.query(`UPDATE campaign_rules SET configuration = '{"threshold":20}' WHERE version = 1`)

        const { rows } = await client.query(`SELECT configuration FROM campaign_rules WHERE version = 1`)
        expect(rows[0].configuration).toEqual({ threshold: 20 })
      } finally {
        await client.close()
      }
    })
  })

  test('closing a version is permitted ONCE, and its end can never be moved afterwards', async () => {
    // The single legitimate write to a published row: publishing a successor has to close its
    // predecessor. Allowing the end to move afterwards would let someone silently rewrite which
    // rules applied over a period a decision was already made in.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        await insertVersion(client, campaignId, { version: 1, status: 'published', from: AT('2026-01-01T00:00:00Z') })

        await client.query(
          `UPDATE campaign_rules SET effective_to = '2026-06-01T00:00:00Z', status = 'superseded' WHERE version = 1`,
        )

        await expect(
          client.query(`UPDATE campaign_rules SET effective_to = '2026-07-01T00:00:00Z' WHERE version = 1`),
        ).rejects.toThrow(/already ended/)
      } finally {
        await client.close()
      }
    })
  })

  test('at most ONE published version per rule type may be open-ended', async () => {
    // Otherwise "the current rules" has two answers, and the resolver returns whichever the query
    // planner happens to produce first.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        await insertVersion(client, campaignId, { version: 1, status: 'published', from: AT('2026-01-01T00:00:00Z') })

        await expect(
          insertVersion(client, campaignId, { version: 2, status: 'published', from: AT('2026-02-01T00:00:00Z') }),
        ).rejects.toThrow(/campaign_rules_one_current_idx/)

        // A draft may be open-ended: a draft is not current.
        await insertVersion(client, campaignId, { version: 2, status: 'draft', from: AT('2026-02-01T00:00:00Z') })
      } finally {
        await client.close()
      }
    })
  })

  test('T21 criterion 3: resolving the version effective at an instant is a QUERY', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId, repository } = await setup(url)
      try {
        // v1 governed January–March, v2 March onward.
        await insertVersion(client, campaignId, {
          version: 1,
          status: 'superseded',
          from: AT('2026-01-01T00:00:00Z'),
          to: AT('2026-03-01T00:00:00Z'),
          config: { threshold: 10 },
        })
        await insertVersion(client, campaignId, {
          version: 2,
          status: 'published',
          from: AT('2026-03-01T00:00:00Z'),
          config: { threshold: 20 },
        })

        const inJanuary = await repository.resolveEffectiveVersion(campaignId, 'selection', AT('2026-01-15T00:00:00Z'))
        expect(inJanuary?.version).toBe(1)

        const inApril = await repository.resolveEffectiveVersion(campaignId, 'selection', AT('2026-04-15T00:00:00Z'))
        expect(inApril?.version).toBe(2)
      } finally {
        await client.close()
      }
    })
  })

  test('the interval is HALF-OPEN, so the changeover instant has exactly one answer', async () => {
    // The boundary is where two independently-written implementations disagree, and where
    // FR-CAM-007's "no silent retroactive rule application" either holds or does not.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId, repository } = await setup(url)
      try {
        const changeover = '2026-03-01T00:00:00Z'
        await insertVersion(client, campaignId, {
          version: 1,
          status: 'superseded',
          from: AT('2026-01-01T00:00:00Z'),
          to: AT(changeover),
        })
        await insertVersion(client, campaignId, { version: 2, status: 'published', from: AT(changeover) })

        // Exactly at the changeover: the NEW version.
        expect((await repository.resolveEffectiveVersion(campaignId, 'selection', AT(changeover)))?.version).toBe(2)
        // One millisecond before: still the old one.
        expect(
          (await repository.resolveEffectiveVersion(campaignId, 'selection', AT('2026-02-28T23:59:59.999Z')))?.version,
        ).toBe(1)
      } finally {
        await client.close()
      }
    })
  })

  test('an instant before any version resolves to nothing, rather than the earliest', async () => {
    // Returning the earliest version would be a silent retroactive application of rules that did
    // not exist yet — precisely what FR-CAM-007 forbids.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId, repository } = await setup(url)
      try {
        await insertVersion(client, campaignId, { version: 1, status: 'published', from: AT('2026-03-01T00:00:00Z') })

        expect(
          await repository.resolveEffectiveVersion(campaignId, 'selection', AT('2026-01-01T00:00:00Z')),
        ).toBeUndefined()
      } finally {
        await client.close()
      }
    })
  })

  test('a DRAFT never resolves as effective, whatever its dates say', async () => {
    // Otherwise unreviewed configuration governs a live participant.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId, repository } = await setup(url)
      try {
        await insertVersion(client, campaignId, { version: 1, status: 'draft', from: AT('2026-01-01T00:00:00Z') })

        expect(
          await repository.resolveEffectiveVersion(campaignId, 'selection', AT('2026-06-01T00:00:00Z')),
        ).toBeUndefined()
        expect(await repository.currentVersion(campaignId, 'selection')).toBeUndefined()
      } finally {
        await client.close()
      }
    })
  })

  test('rule types resolve independently of one another', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId, repository } = await setup(url)
      try {
        await insertVersion(client, campaignId, {
          ruleType: 'selection',
          version: 7,
          status: 'published',
          from: AT('2026-01-01T00:00:00Z'),
        })
        await insertVersion(client, campaignId, {
          ruleType: 'reservation',
          version: 1,
          status: 'published',
          from: AT('2026-01-01T00:00:00Z'),
        })

        expect((await repository.currentVersion(campaignId, 'selection'))?.version).toBe(7)
        expect((await repository.currentVersion(campaignId, 'reservation'))?.version).toBe(1)
        expect(await repository.currentVersion(campaignId, 'guideline')).toBeUndefined()
      } finally {
        await client.close()
      }
    })
  })

  test('T21 criterion 2: type and visit method are ENUMS, so nonsense cannot be stored', async () => {
    // FR-CAM-001/002. The acceptance condition is "routing never depends on repeated free-text
    // interpretation" — which only holds if the database refuses the free text.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')
      await applyMigrations(url)
      const client = createDbClient(url)
      try {
        await expect(
          client.query(
            `INSERT INTO campaigns (code, name, type, starts_at, ends_at)
             VALUES ('bad', 'Bad', 'Shipping ', now(), now() + interval '1 day')`,
          ),
        ).rejects.toThrow()

        await expect(
          client.query(
            `INSERT INTO campaigns (code, name, type, visit_method, starts_at, ends_at)
             VALUES ('bad2', 'Bad', 'visit', 'B', now(), now() + interval '1 day')`,
          ),
        ).rejects.toThrow()

        // visit_method is NOT NULL with an explicit `not_applicable`, which keeps §16.4's routing
        // table total — no branch ever has to decide what a null means.
        const { rows } = await client.query(
          `INSERT INTO campaigns (code, name, type, starts_at, ends_at)
           VALUES ('ship', 'Shipping', 'shipping', now(), now() + interval '1 day')
           RETURNING visit_method`,
        )
        expect(rows[0].visit_method).toBe('not_applicable')
      } finally {
        await client.close()
      }
    })
  })
})
