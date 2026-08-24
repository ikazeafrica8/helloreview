// AC-04: two active applications share phone+campaign; disclose nothing, mark Ambiguous, create one task.

import { beforeAll, describe, expect, test } from 'vitest'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

describe('AC-04 ambiguous applicant identity', () => {
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

  test('does not disclose candidates, sets Ambiguous and persists exactly one high-priority task', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { IdentityAmbiguityService, matchApplicant } = await importBuilt(
      'apps/api/dist/modules/identity-resolution/index.js',
    )
    const { HumanReviewTaskService } = await importBuilt('apps/api/dist/modules/human-tasks/index.js')
    const { Pool } = await import('pg')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url, max: 4 })
      try {
        const campaign = await pool.query(
          `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
           VALUES ('ac04', 'AC-04', 'payback', 'not_applicable', 'active', now(), now() + interval '30 days')
           RETURNING id`,
        )
        const campaignId = campaign.rows[0].id
        const privatePhone = '+821012345678'
        const privateApplicants = [
          { sourceId: 'ac04-app-1', name: '비공개 신청자 하나', blog: 'https://blog.example/private-one' },
          { sourceId: 'ac04-app-2', name: '비공개 신청자 둘', blog: 'https://blog.example/private-two' },
        ]
        const applicationIds = []
        for (const applicant of privateApplicants) {
          const inserted = await pool.query(
            `INSERT INTO applications (
               source_system, source_application_id, campaign_id, status, source_status,
               applicant_name, phone_normalized, blog_url, source_version, submitted_at,
               last_source_event_id, last_source_occurred_at, last_synchronized_at
             ) VALUES (
               'helloreview_website', $1, $2, 'received', 'received', $3, $4, $5, 1, now(),
               $6, now(), now()
             ) RETURNING id`,
            [
              applicant.sourceId,
              campaignId,
              applicant.name,
              privatePhone,
              applicant.blog,
              `${applicant.sourceId}-event`,
            ],
          )
          applicationIds.push(inserted.rows[0].id)
        }
        const participant = await pool.query(
          `INSERT INTO participants (name, phone_normalized) VALUES ('문의 참여자', $1) RETURNING id`,
          [privatePhone],
        )
        const participantId = participant.rows[0].id
        const decidedAt = new Date('2026-08-24T12:00:00Z')
        const match = matchApplicant({ kind: 'phone_campaign', candidateApplicationIds: applicationIds }, decidedAt)
        const service = new IdentityAmbiguityService(pool, new HumanReviewTaskService())
        const input = {
          sourceKey: 'kakao:ac04-contact-event',
          participantId,
          campaignId,
          workflowReference: 'pre-workflow:ac04-contact',
          match,
          activeCampaignIds: [campaignId],
          candidateLinks: applicationIds.map((applicationId) => ({ applicationId, linkedParticipantId: null })),
          decidedAt,
        }

        const first = await service.resolve(input)
        expect(first).toMatchObject({
          status: 'ambiguous',
          campaignSpecificTransitionsAllowed: false,
        })
        expect(first.humanReviewTaskId).toEqual(expect.any(String))
        const participantOutput = JSON.stringify({ message: first.participantMessage })
        for (const secret of [
          privatePhone,
          ...applicationIds,
          ...privateApplicants.flatMap((applicant) => [applicant.name, applicant.blog]),
        ]) {
          expect(participantOutput).not.toContain(secret)
        }

        const replay = await service.resolve(input)
        expect(replay.identityResolutionId).toBe(first.identityResolutionId)
        expect(replay.humanReviewTaskId).toBe(first.humanReviewTaskId)

        const resolution = await pool.query(
          `SELECT status, campaign_specific_transitions_allowed
             FROM identity_resolution_cases WHERE source_key = $1`,
          [input.sourceKey],
        )
        expect(resolution.rows).toEqual([{ status: 'ambiguous', campaign_specific_transitions_allowed: false }])
        const tasks = await pool.query(
          `SELECT reason_code, priority, status, automation_paused, case_packet
             FROM human_review_tasks WHERE identity_resolution_id = $1`,
          [first.identityResolutionId],
        )
        expect(tasks.rows).toHaveLength(1)
        expect(tasks.rows[0]).toMatchObject({
          reason_code: 'IDENTITY_AMBIGUOUS',
          priority: 'high',
          status: 'open',
          automation_paused: true,
        })
        const storedPacket = JSON.stringify(tasks.rows[0].case_packet)
        for (const secret of [
          privatePhone,
          ...applicationIds,
          ...privateApplicants.flatMap((applicant) => [applicant.name, applicant.blog]),
        ]) {
          expect(storedPacket).not.toContain(secret)
        }
      } finally {
        await pool.end()
      }
    })
  }, 300_000)
})
