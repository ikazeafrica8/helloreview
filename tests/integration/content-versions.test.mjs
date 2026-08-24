// Integration tier: immutable guideline, payback-term and message-template versions (T24).
//
// These are database guarantees, so the tests use a freshly migrated PostgreSQL rather than mocks.
// The service tests also prove that the supported publish/approve/activate path can create a new
// version after the database correctly refuses edits to the old one.

import { beforeAll, describe, expect, test } from 'vitest'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const recordingLogger = () => {
  const at = () => () => undefined
  return {
    trace: at(),
    debug: at(),
    info: at(),
    warn: at(),
    error: at(),
    fatal: at(),
    child: () => recordingLogger(),
  }
}

const setup = async (url) => {
  const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
  const { AuditLogService } = await importBuilt('apps/api/dist/modules/audit-log/index.js')
  const { ConfigurationPublishingService } = await importBuilt('apps/api/dist/modules/campaign-config/index.js')
  const { Pool } = await import('pg')

  await applyMigrations(url)
  const pool = new Pool({ connectionString: url })
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, starts_at, ends_at)
     VALUES ('content-v', 'Content Versions', 'payback', 'not_applicable', now(), now() + interval '30 days')
     RETURNING id`,
  )
  const campaignId = String(campaign.rows[0].id)
  const auditLog = new AuditLogService(pool, recordingLogger())
  const publishing = new ConfigurationPublishingService(pool, auditLog)
  return { pool, campaignId, publishing }
}

const addGuideline = async (pool, campaignId, version, body) => {
  const { rows } = await pool.query(
    `INSERT INTO guideline_versions (campaign_id, version, body_text, effective_from)
     VALUES ($1, $2, $3, '2099-01-01T00:00:00Z')
     RETURNING id`,
    [campaignId, version, body],
  )
  return String(rows[0].id)
}

const addTemplate = async (
  pool,
  { purpose = 'PAYBACK_CONSENT_REQUEST', version, body, providerApproval = false, providerCode = null },
) => {
  const { rows } = await pool.query(
    `INSERT INTO message_templates
       (purpose_code, version, legal_classification, body, requires_provider_approval, provider_template_code)
     VALUES ($1, $2, 'consent_related', $3, $4, $5)
     RETURNING id`,
    [purpose, version, body, providerApproval, providerCode],
  )
  return String(rows[0].id)
}

const actor = { type: 'operator', id: 'op_a1b2c3d4' }

describe('T24 content versions', () => {
  beforeAll(() => {
    for (const workspace of [
      'packages/contracts',
      'packages/observability',
      'packages/db',
      'packages/testing',
      'apps/api',
    ]) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('guideline publication freezes exact content and a successor is a new version', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { pool, campaignId, publishing } = await setup(url)
      try {
        const firstId = await addGuideline(pool, campaignId, 1, 'first approved guideline')
        await publishing.publishGuidelineVersion({
          guidelineVersionId: firstId,
          effectiveFrom: new Date('2026-09-01T00:00:00Z'),
          publishedAt: new Date('2026-08-25T00:00:00Z'),
          actor,
        })

        await expect(
          pool.query(`UPDATE guideline_versions SET body_text = 'rewritten history' WHERE id = $1`, [firstId]),
        ).rejects.toThrow(/published and cannot be modified/)
        await expect(pool.query(`DELETE FROM guideline_versions WHERE id = $1`, [firstId])).rejects.toThrow(
          /published and cannot be deleted/,
        )

        const secondId = await addGuideline(pool, campaignId, 2, 'replacement guideline')
        await publishing.publishGuidelineVersion({
          guidelineVersionId: secondId,
          effectiveFrom: new Date('2026-10-01T00:00:00Z'),
          publishedAt: new Date('2026-09-25T00:00:00Z'),
          actor,
        })

        const { rows } = await pool.query(
          `SELECT version, status, body_text, effective_to FROM guideline_versions ORDER BY version`,
        )
        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject({ version: 1, status: 'superseded', body_text: 'first approved guideline' })
        expect(rows[0].effective_to).toEqual(new Date('2026-10-01T00:00:00Z'))
        expect(rows[1]).toMatchObject({ version: 2, status: 'published', body_text: 'replacement guideline' })

        const audit = await pool.query(
          `SELECT action, target_id FROM audit_logs WHERE action = 'GUIDELINE_VERSION_PUBLISHED' ORDER BY occurred_at`,
        )
        expect(audit.rows.map((row) => row.target_id)).toEqual([firstId, secondId])
      } finally {
        await pool.end()
      }
    })
  })

  test('guideline and template version keys are enforced by PostgreSQL', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { pool, campaignId } = await setup(url)
      try {
        await addGuideline(pool, campaignId, 1, 'one')
        await expect(addGuideline(pool, campaignId, 1, 'duplicate')).rejects.toThrow(/guideline_versions_version_key/)

        await addTemplate(pool, { version: 1, body: 'template one' })
        await expect(addTemplate(pool, { version: 1, body: 'duplicate template' })).rejects.toThrow(
          /message_templates_version_key/,
        )

        // Version numbers and participant-facing content must be meaningful even for direct SQL.
        await expect(addGuideline(pool, campaignId, 0, 'bad version')).rejects.toThrow(
          /guideline_versions_positive_version/,
        )
        await expect(addTemplate(pool, { version: 2, body: '   ' })).rejects.toThrow(/message_templates_nonempty_body/)
      } finally {
        await pool.end()
      }
    })
  })

  test('template approval freezes reviewed text; activation retires the prior version', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { pool, publishing } = await setup(url)
      try {
        const v1 = await addTemplate(pool, { version: 1, body: 'approved v1' })
        await publishing.approveTemplate({ templateId: v1, occurredAt: new Date('2026-08-25T00:00:00Z'), actor })
        await publishing.activateTemplate({ templateId: v1, occurredAt: new Date('2026-08-26T00:00:00Z'), actor })

        await expect(pool.query(`UPDATE message_templates SET body = 'changed' WHERE id = $1`, [v1])).rejects.toThrow(
          /approved and cannot be modified/,
        )

        const v2 = await addTemplate(pool, { version: 2, body: 'approved v2' })
        await publishing.approveTemplate({ templateId: v2, occurredAt: new Date('2026-09-01T00:00:00Z'), actor })
        await publishing.activateTemplate({ templateId: v2, occurredAt: new Date('2026-09-02T00:00:00Z'), actor })

        const { rows } = await pool.query(
          `SELECT version, status, body, activated_at, retired_at FROM message_templates ORDER BY version`,
        )
        expect(rows[0]).toMatchObject({ version: 1, status: 'retired', body: 'approved v1' })
        expect(rows[0].retired_at).toEqual(new Date('2026-09-02T00:00:00Z'))
        expect(rows[1]).toMatchObject({ version: 2, status: 'active', body: 'approved v2' })

        await expect(
          pool.query(`UPDATE message_templates SET activated_at = now() WHERE id = $1`, [v2]),
        ).rejects.toThrow(/activation timestamp cannot be modified/)
        await expect(pool.query(`UPDATE message_templates SET retired_at = now() WHERE id = $1`, [v1])).rejects.toThrow(
          /retirement timestamp cannot be modified/,
        )

        const audit = await pool.query(
          `SELECT action FROM audit_logs
            WHERE target_type = 'message_template'
            ORDER BY occurred_at, action`,
        )
        expect(audit.rows.map((row) => row.action)).toEqual([
          'TEMPLATE_APPROVED',
          'TEMPLATE_ACTIVATED',
          'TEMPLATE_APPROVED',
          'TEMPLATE_ACTIVATED',
          'TEMPLATE_RETIRED',
        ])
      } finally {
        await pool.end()
      }
    })
  })

  test('legal review and provider approval cannot be bypassed by lifecycle shortcuts', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { CAMPAIGN_CONFIG_REASON, ConfigurationPublishingError } = await importBuilt(
      'apps/api/dist/modules/campaign-config/index.js',
    )

    await withPostgres(async ({ url }) => {
      const { pool, publishing } = await setup(url)
      try {
        const needsProvider = await addTemplate(pool, {
          version: 1,
          body: 'provider-reviewed body',
          providerApproval: true,
        })

        await expect(
          pool.query(`UPDATE message_templates SET status = 'active' WHERE id = $1`, [needsProvider]),
        ).rejects.toThrow(/cannot move from draft to active/)

        await publishing.approveTemplate({
          templateId: needsProvider,
          occurredAt: new Date('2026-08-25T00:00:00Z'),
          actor,
        })
        await expect(
          publishing.activateTemplate({
            templateId: needsProvider,
            occurredAt: new Date('2026-08-26T00:00:00Z'),
            actor,
          }),
        ).rejects.toMatchObject({
          name: ConfigurationPublishingError.name,
          reasonCode: CAMPAIGN_CONFIG_REASON.TEMPLATE_PROVIDER_APPROVAL_MISSING,
        })

        await pool.query(`UPDATE message_templates SET provider_template_code = 'alimtalk_123' WHERE id = $1`, [
          needsProvider,
        ])
        await publishing.activateTemplate({
          templateId: needsProvider,
          occurredAt: new Date('2026-08-27T00:00:00Z'),
          actor,
        })

        await expect(
          pool.query(`UPDATE message_templates SET provider_template_code = 'rewritten' WHERE id = $1`, [
            needsProvider,
          ]),
        ).rejects.toThrow(/already has provider code/)

        // The classification itself is frozen with the exact reviewed bytes.
        await expect(
          pool.query(`UPDATE message_templates SET legal_classification = 'definitely_advertising' WHERE id = $1`, [
            needsProvider,
          ]),
        ).rejects.toThrow(/approved and cannot be modified/)
      } finally {
        await pool.end()
      }
    })
  })

  test('payback terms use the same immutable exact-version rule as every campaign rule', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    await withPostgres(async ({ url }) => {
      const { pool, campaignId } = await setup(url)
      try {
        await pool.query(
          `INSERT INTO campaign_rules
             (campaign_id, rule_type, version, status, configuration, effective_from, published_by, published_at)
           VALUES ($1, 'payback', 1, 'published', $2, now(), $3, now())`,
          [campaignId, JSON.stringify({ terms: 'pay within seven days' }), actor.id],
        )

        await expect(
          pool.query(`UPDATE campaign_rules SET configuration = $1 WHERE campaign_id = $2 AND rule_type = 'payback'`, [
            JSON.stringify({ terms: 'different terms' }),
            campaignId,
          ]),
        ).rejects.toThrow(/published and cannot be modified/)

        await pool.query(
          `UPDATE campaign_rules
              SET status = 'superseded', effective_to = now()
            WHERE campaign_id = $1 AND rule_type = 'payback'`,
          [campaignId],
        )
        await pool.query(
          `INSERT INTO campaign_rules
             (campaign_id, rule_type, version, status, configuration, effective_from, published_by, published_at)
           VALUES ($1, 'payback', 2, 'published', $2, now(), $3, now())`,
          [campaignId, JSON.stringify({ terms: 'new exact version' }), actor.id],
        )

        const { rows } = await pool.query(
          `SELECT version, status, configuration FROM campaign_rules
            WHERE campaign_id = $1 AND rule_type = 'payback'
            ORDER BY version`,
          [campaignId],
        )
        expect(rows).toHaveLength(2)
        expect(rows[0].configuration).toEqual({ terms: 'pay within seven days' })
        expect(rows[1].configuration).toEqual({ terms: 'new exact version' })
      } finally {
        await pool.end()
      }
    })
  })
})
