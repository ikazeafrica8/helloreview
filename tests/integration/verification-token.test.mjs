// Integration tier: website-issued, single-application verification token persistence and consumption (T30).

import { beforeAll, describe, expect, test } from 'vitest'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

describe('T30 application verification token persistence', () => {
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

  test('valid consumes once for the intended application; unknown, expired and reused fail closed', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { ApplicationVerificationTokenService, VerificationTokenError, IDENTITY_RESOLUTION_REASON } =
      await importBuilt('apps/api/dist/modules/identity-resolution/index.js')
    const { Pool } = await import('pg')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url, max: 4 })
      try {
        const campaign = await pool.query(
          `INSERT INTO campaigns (code, name, type, visit_method, starts_at, ends_at)
           VALUES ('t30-token', 'T30 token', 'payback', 'not_applicable', now(), now() + interval '30 days')
           RETURNING id`,
        )
        const campaignId = campaign.rows[0].id
        const application = await pool.query(
          `INSERT INTO applications (
             source_system, source_application_id, campaign_id, status, source_status,
             applicant_name, phone_normalized, blog_url, source_version, submitted_at,
             last_source_event_id, last_source_occurred_at, last_synchronized_at
           ) VALUES (
             'helloreview_website', 't30-application', $1, 'received', 'received',
             '토큰 신청자', '+821012345678', 'https://blog.example/token', 1, now(),
             't30-event', now(), now()
           ) RETURNING id`,
          [campaignId],
        )
        const participant = await pool.query(
          `INSERT INTO participants (name, phone_normalized) VALUES ('토큰 참여자', '+821012345678') RETURNING id`,
        )

        const key = 'integration-verification-key-at-least-16-characters'
        const service = new ApplicationVerificationTokenService(pool, key)
        const rawToken = 'website-secret-token-that-must-never-be-stored'
        const issuedAt = new Date('2026-08-24T11:00:00Z')
        await service.registerWebsiteToken({
          applicationId: application.rows[0].id,
          rawToken,
          issuedAt,
          expiresAt: new Date('2026-08-24T12:00:00Z'),
        })

        await expect(
          service.consume({
            rawToken,
            participantId: participant.rows[0].id,
            consumedAt: new Date('2026-08-24T11:30:00Z'),
          }),
        ).resolves.toMatchObject({
          category: 'verified',
          candidateApplicationIds: [application.rows[0].id],
        })

        const stored = await pool.query(
          `SELECT token_digest, consumed_by_participant_id FROM application_verification_tokens`,
        )
        expect(stored.rows).toHaveLength(1)
        expect(stored.rows[0].token_digest).toMatch(/^[0-9a-f]{64}$/)
        expect(stored.rows[0].token_digest).not.toBe(rawToken)
        expect(JSON.stringify(stored.rows)).not.toContain(rawToken)
        expect(stored.rows[0].consumed_by_participant_id).toBe(participant.rows[0].id)

        await expect(
          service.consume({
            rawToken,
            participantId: participant.rows[0].id,
            consumedAt: new Date('2026-08-24T11:31:00Z'),
          }),
        ).rejects.toMatchObject({
          reasonCode: IDENTITY_RESOLUTION_REASON.TOKEN_REUSED,
        })
        await expect(
          service.consume({
            rawToken: 'unknown-token',
            participantId: participant.rows[0].id,
            consumedAt: new Date('2026-08-24T11:31:00Z'),
          }),
        ).rejects.toBeInstanceOf(VerificationTokenError)

        const expiredToken = 'website-expired-token'
        await service.registerWebsiteToken({
          applicationId: application.rows[0].id,
          rawToken: expiredToken,
          issuedAt: new Date('2026-08-24T09:00:00Z'),
          expiresAt: new Date('2026-08-24T10:00:00Z'),
        })
        await expect(
          service.consume({
            rawToken: expiredToken,
            participantId: participant.rows[0].id,
            consumedAt: new Date('2026-08-24T11:31:00Z'),
          }),
        ).rejects.toMatchObject({ reasonCode: IDENTITY_RESOLUTION_REASON.TOKEN_EXPIRED })
      } finally {
        await pool.end()
      }
    })
  }, 300_000)
})
