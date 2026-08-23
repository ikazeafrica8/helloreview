// Integration tier: versioned business details and approved aliases (T23, FR-CAM-004, PRD §16.7).
//
// §16.7's Business check validates a booking against "exact normalized name or approved alias and
// branch". Everything here exists so that check can be answered against the details that were
// approved AT THE TIME — a business that renames itself must not retroactively invalidate a booking
// that was correct last month.
//
// The alias freeze is the part worth reading. An alias is an AUTHORIZATION, not a convenience: it
// is the set of names a booking may legitimately carry. Leaving it editable on a published version
// would be an unversioned back door into a versioned record — the details immutable while the names
// that validate against them stayed open to edit.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const setup = async (url) => {
  const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')
  await applyMigrations(url)
  const client = createDbClient(url)
  const campaign = await client.query(
    `INSERT INTO campaigns (code, name, type, visit_method, starts_at, ends_at)
     VALUES ('c1', 'C1', 'visit', 'visit_b', now(), now() + interval '30 days') RETURNING id`,
  )
  return { client, campaignId: String(campaign.rows[0].id) }
}

/** Insert a business version, normalizing through the real normalizer so the stored form is real. */
const addBusiness = async (client, campaignId, { version, status, name, branch = null }) => {
  const { normalizeBusinessName } = await importBuilt('apps/api/dist/modules/campaign-config/index.js')
  const { rows } = await client.query(
    `INSERT INTO campaign_businesses
       (campaign_id, version, status, name, normalized_name, branch, normalized_branch, effective_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [
      campaignId,
      version,
      status,
      name,
      normalizeBusinessName(name),
      branch,
      branch === null ? null : normalizeBusinessName(branch),
    ],
  )
  return String(rows[0].id)
}

const addAlias = async (client, businessId, alias) => {
  const { normalizeBusinessName } = await importBuilt('apps/api/dist/modules/campaign-config/index.js')
  return client.query(
    `INSERT INTO campaign_business_aliases (campaign_business_id, alias, normalized_alias) VALUES ($1, $2, $3)`,
    [businessId, alias, normalizeBusinessName(alias)],
  )
}

describe('campaign businesses', () => {
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

  test('T23 criterion 1: a published version is frozen; changes require a new version', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        const id = await addBusiness(client, campaignId, {
          version: 1,
          status: 'published',
          name: '스타벅스',
          branch: '강남점',
        })

        for (const [column, value] of [
          ['name', `'투썸플레이스'`],
          ['branch', `'홍대점'`],
          ['phone', `'02-000-0000'`],
          ['booking_url', `'https://example.invalid'`],
        ]) {
          await expect(
            client.query(`UPDATE campaign_businesses SET ${column} = ${value} WHERE id = $1`, [id]),
            `${column} must be frozen on a published version`,
          ).rejects.toThrow(/published and cannot be modified/)
        }

        await expect(client.query(`DELETE FROM campaign_businesses WHERE id = $1`, [id])).rejects.toThrow(
          /published and cannot be deleted/,
        )

        // A new version is the supported way to change details.
        await client.query(`UPDATE campaign_businesses SET effective_to = now(), status = 'superseded' WHERE id = $1`, [
          id,
        ])
        await addBusiness(client, campaignId, {
          version: 2,
          status: 'published',
          name: '투썸플레이스',
          branch: '홍대점',
        })

        const { rows } = await client.query(`SELECT count(*)::int AS n FROM campaign_businesses`)
        expect(rows[0].n).toBe(2)
      } finally {
        await client.close()
      }
    })
  })

  test('T23 criterion 2: aliases are a first-class LIST, frozen with their version', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        const draft = await addBusiness(client, campaignId, { version: 1, status: 'draft', name: '스타벅스' })

        // Several names, each its own row — not a delimited string, which would break the first
        // time a Korean business name contained the delimiter.
        await addAlias(client, draft, '스벅')
        await addAlias(client, draft, '스타 벅스')
        await addAlias(client, draft, 'Starbucks')

        const before = await client.query(
          `SELECT count(*)::int AS n FROM campaign_business_aliases WHERE campaign_business_id = $1`,
          [draft],
        )
        expect(before.rows[0].n).toBe(3)

        await client.query(`UPDATE campaign_businesses SET status = 'published' WHERE id = $1`, [draft])

        // An alias authorizes a booking name. Adding one to a published version would retroactively
        // authorize bookings under a name nobody approved at the time.
        await expect(addAlias(client, draft, '아무거나')).rejects.toThrow(/alias list of a published/)
        await expect(
          client.query(`DELETE FROM campaign_business_aliases WHERE campaign_business_id = $1`, [draft]),
        ).rejects.toThrow(/alias list of a published/)
      } finally {
        await client.close()
      }
    })
  })

  test('two aliases that normalize identically are one alias written twice', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        const draft = await addBusiness(client, campaignId, { version: 1, status: 'draft', name: '스타벅스' })
        await addAlias(client, draft, '스벅 강남')

        // Different spacing, same normalized form.
        await expect(addAlias(client, draft, '스벅강남')).rejects.toThrow(/campaign_business_aliases_key/)
      } finally {
        await client.close()
      }
    })
  })

  test('T23 criterion 3: branch is stored separately from the name', async () => {
    // So a booking at the right business but the wrong branch is distinguishable from a booking at
    // the wrong business — §16.7 gives those different failure actions.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        await addBusiness(client, campaignId, {
          version: 1,
          status: 'published',
          name: '스타벅스',
          branch: '강남점',
        })

        const { rows } = await client.query(
          `SELECT name, normalized_name, branch, normalized_branch FROM campaign_businesses`,
        )
        expect(rows[0].name).toBe('스타벅스')
        expect(rows[0].branch).toBe('강남점')
        // The name does not silently contain the branch.
        expect(rows[0].normalized_name).not.toContain('강남')
      } finally {
        await client.close()
      }
    })
  })

  test('the stored normalized form matches what the normalizer produces today', async () => {
    // A denormalized column is only trustworthy while it agrees with the function that wrote it.
    // This is the assertion that would fail if the normalizer's rules ever changed without a
    // backfill — which would silently stop matching bookings that used to match.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { normalizeBusinessName } = await importBuilt('apps/api/dist/modules/campaign-config/index.js')

    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        await addBusiness(client, campaignId, {
          version: 1,
          status: 'published',
          name: '㈜스타벅스 (강남점)',
          branch: '강남 점',
        })

        const { rows } = await client.query(
          `SELECT name, normalized_name, branch, normalized_branch FROM campaign_businesses`,
        )
        expect(rows[0].normalized_name).toBe(normalizeBusinessName(String(rows[0].name)))
        expect(rows[0].normalized_branch).toBe(normalizeBusinessName(String(rows[0].branch)))
      } finally {
        await client.close()
      }
    })
  })

  test('at most one open-ended published version per campaign', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        await addBusiness(client, campaignId, { version: 1, status: 'published', name: '스타벅스' })

        await expect(
          addBusiness(client, campaignId, { version: 2, status: 'published', name: '투썸' }),
        ).rejects.toThrow(/campaign_businesses_one_current_idx/)
      } finally {
        await client.close()
      }
    })
  })

  test('the cascade the schema comment promises: a draft deletes with its aliases', async () => {
    // The comment says the CASCADE is safe "because a published version cannot be deleted". That is
    // a claim about two mechanisms agreeing, so it is checked rather than asserted.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { client, campaignId } = await setup(url)
      try {
        const draft = await addBusiness(client, campaignId, { version: 1, status: 'draft', name: '드래프트' })
        await addAlias(client, draft, '별칭')

        await client.query(`DELETE FROM campaign_businesses WHERE id = $1`, [draft])

        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM campaign_business_aliases WHERE campaign_business_id = $1`,
          [draft],
        )
        expect(rows[0].n, 'the draft’s aliases should have cascaded away').toBe(0)
      } finally {
        await client.close()
      }
    })
  })
})
