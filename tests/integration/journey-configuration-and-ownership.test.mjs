import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'

const at = (minutes = 0) => new Date(Date.parse('2026-08-28T01:00:00Z') + minutes * 60_000)

const seedCampaign = async (pool, code) => {
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ($1,'Journey config test','visit','visit_a','draft',$2,$3) RETURNING id`,
    [code, at(-1_440), at(43_200)],
  )
  return campaign.rows[0].id
}

const journeyConfig = (pool, campaignId, applicationUrl, overrides = {}) =>
  pool.query(
    `INSERT INTO campaign_journey_configurations (
       campaign_id, version, status, application_url, effective_from, published_by, published_at
     ) VALUES ($1,$2,$3,$4,$5,'operator:pseudo:1',$5) RETURNING id`,
    [campaignId, overrides.version ?? 1, overrides.status ?? 'published', applicationUrl, at(-10)],
  )

const ownership = (pool, campaignId, overrides = {}) =>
  pool.query(
    `INSERT INTO message_purpose_ownership (
       campaign_id, purpose_stem, authoritative_sender, trigger_audit_status,
       legacy_trigger_reference, platform_suppression_required, version, status, effective_from
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      campaignId,
      overrides.purposeStem ?? 'SELECTION_RESULT',
      overrides.authoritativeSender ?? 'helloreview_platform',
      overrides.triggerAuditStatus ?? 'audited_no_legacy_trigger',
      overrides.legacyTriggerReference ?? null,
      overrides.platformSuppressionRequired ?? false,
      overrides.version ?? 1,
      overrides.status ?? 'published',
      at(-10),
    ],
  )

describe('T136 journey configuration and sender ownership', () => {
  test('accepts one https application URL per campaign and refuses unsafe or duplicate ones', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const campaignId = await seedCampaign(pool, 'journey-url')
        await expect(journeyConfig(pool, campaignId, 'https://apply.example.com/campaign/a')).resolves.toBeTruthy()

        // Two open-ended published versions would give "the current application URL" two answers.
        await expect(
          journeyConfig(pool, campaignId, 'https://apply.example.com/campaign/b', { version: 2 }),
        ).rejects.toThrow(/campaign_journey_configurations_one_current_idx/)

        const other = await seedCampaign(pool, 'journey-url-unsafe')
        // This URL is interpolated into a participant message verbatim.
        await expect(journeyConfig(pool, other, 'http://apply.example.com/a')).rejects.toThrow(/https_application_url/)
        await expect(journeyConfig(pool, other, 'https://user:secret@apply.example.com/a')).rejects.toThrow(
          /credential_free_url|https_application_url/,
        )
        await expect(journeyConfig(pool, other, 'https://apply.example.com/a?token=abc')).rejects.toThrow(
          /credential_free_url|https_application_url/,
        )
      } finally {
        await pool.end()
      }
    })
  })

  test('refuses a platform ownership claim whose legacy trigger was never audited', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const campaignId = await seedCampaign(pool, 'ownership-audit')

        // The load-bearing constraint: T148's audit has to happen before the platform can claim a purpose.
        await expect(ownership(pool, campaignId, { triggerAuditStatus: 'not_audited' })).rejects.toThrow(
          /audit_before_platform/,
        )

        // The legacy sender may own a purpose while unaudited — that is the cutover state — but it
        // has to be pointed at.
        await expect(
          ownership(pool, campaignId, {
            authoritativeSender: 'website_legacy_trigger',
            triggerAuditStatus: 'not_audited',
          }),
        ).rejects.toThrow(/legacy_reference/)
        await expect(
          ownership(pool, campaignId, {
            authoritativeSender: 'website_legacy_trigger',
            triggerAuditStatus: 'not_audited',
            legacyTriggerReference: 'aligo:trigger:selection-result',
            platformSuppressionRequired: true,
          }),
        ).resolves.toBeTruthy()

        // Suppressing our own send only means something when something else sends.
        await expect(
          ownership(pool, campaignId, {
            purposeStem: 'GUIDELINE_DELIVERY',
            platformSuppressionRequired: true,
          }),
        ).rejects.toThrow(/suppression_coherence/)
      } finally {
        await pool.end()
      }
    })
  })

  test('keeps the ownership ledger free of secrets and readable by purpose', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const campaignId = await seedCampaign(pool, 'ownership-readable')
        await ownership(pool, campaignId, {
          authoritativeSender: 'website_legacy_trigger',
          triggerAuditStatus: 'audited_legacy_trigger_exists',
          legacyTriggerReference: 'aligo:trigger:selection-result',
          platformSuppressionRequired: true,
        })
        await ownership(pool, campaignId, { purposeStem: 'GUIDELINE_DELIVERY', version: 1 })

        const rows = (
          await pool.query(
            `SELECT purpose_stem, authoritative_sender, trigger_audit_status,
                    legacy_trigger_reference, platform_suppression_required
               FROM message_purpose_ownership WHERE campaign_id = $1 ORDER BY purpose_stem`,
            [campaignId],
          )
        ).rows
        expect(rows).toEqual([
          {
            purpose_stem: 'GUIDELINE_DELIVERY',
            authoritative_sender: 'helloreview_platform',
            trigger_audit_status: 'audited_no_legacy_trigger',
            legacy_trigger_reference: null,
            platform_suppression_required: false,
          },
          {
            purpose_stem: 'SELECTION_RESULT',
            authoritative_sender: 'website_legacy_trigger',
            trigger_audit_status: 'audited_legacy_trigger_exists',
            legacy_trigger_reference: 'aligo:trigger:selection-result',
            platform_suppression_required: true,
          },
        ])
        expect(JSON.stringify(rows)).toContainNoPii()

        // A reference shaped like a credential or an endpoint is refused.
        await expect(
          ownership(pool, campaignId, {
            purposeStem: 'NON_SELECTION_NOTICE',
            authoritativeSender: 'website_legacy_trigger',
            legacyTriggerReference: 'https://api.aligo.in/send?key=SECRET',
          }),
        ).rejects.toThrow(/reference_shape/)
      } finally {
        await pool.end()
      }
    })
  })

  test('freezes published journey and ownership versions, allowing only supersession', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const campaignId = await seedCampaign(pool, 'journey-frozen')
        const config = await journeyConfig(pool, campaignId, 'https://apply.example.com/frozen')
        const owned = await ownership(pool, campaignId)

        await expect(
          pool.query(`UPDATE campaign_journey_configurations SET application_url = $2 WHERE id = $1`, [
            config.rows[0].id,
            'https://apply.example.com/rewritten',
          ]),
        ).rejects.toThrow(/cannot be modified/)
        await expect(
          pool.query(`DELETE FROM campaign_journey_configurations WHERE id = $1`, [config.rows[0].id]),
        ).rejects.toThrow(/cannot be deleted/)
        await expect(
          pool.query(`UPDATE message_purpose_ownership SET authoritative_sender = 'operator_manual' WHERE id = $1`, [
            owned.rows[0].id,
          ]),
        ).rejects.toThrow(/cannot be modified/)

        // Closing a version so a superseding one can take over is the one permitted write.
        await expect(
          pool.query(
            `UPDATE campaign_journey_configurations SET effective_to = $2, status = 'superseded' WHERE id = $1`,
            [config.rows[0].id, at(60)],
          ),
        ).resolves.toBeTruthy()
        await expect(
          pool.query(`UPDATE campaign_journey_configurations SET effective_to = $2 WHERE id = $1`, [
            config.rows[0].id,
            at(120),
          ]),
        ).rejects.toThrow(/its end cannot be moved/)

        // With the first version closed, a second may take over.
        await expect(
          journeyConfig(pool, campaignId, 'https://apply.example.com/v2', { version: 2 }),
        ).resolves.toBeTruthy()
      } finally {
        await pool.end()
      }
    })
  })
})
