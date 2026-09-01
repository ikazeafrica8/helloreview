// Integration tier: T137 deterministic candidate lookup and replay-safe workflow bootstrap.

import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations, createDbClient } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import { ApplicationCandidateLookupService } from '../../apps/api/dist/modules/identity-resolution/index.js'
import {
  ApplicationWorkflowBootstrapService,
  WorkflowInstanceService,
} from '../../apps/api/dist/modules/workflow-core/index.js'
import {
  createDirectApplicationSideEffectHandlers,
  createManualSelectionRecommendationSideEffectHandlers,
  createWorkflowSideEffectDispatcher,
} from '../../apps/worker/dist/processors/index.js'

const insertApplication = async (pool, { sourceId, campaignId, name, phone, blogUrl, occurredAt }) => {
  const result = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, blog_url, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('helloreview_website',$1,$2,'received','received',$3,$4,$5,1,$6,$7,$6,$6)
     RETURNING id`,
    [sourceId, campaignId, name, phone, blogUrl, occurredAt, `source-${sourceId}`],
  )
  return result.rows[0].id
}

describe('application workflow bootstrap and candidate lookup', () => {
  test('creates one workflow per application and never exposes candidate IDs in participant-safe results', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url, max: 6 })
      const occurredAt = new Date('2026-08-24T01:00:00Z')
      try {
        const campaigns = await pool.query(
          `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
           VALUES
             ('lookup-a','Lookup A','shipping','not_applicable','active',$1,$2),
             ('lookup-b','Lookup B','payback','not_applicable','active',$1,$2)
           RETURNING id, code`,
          [occurredAt, new Date('2026-09-24T01:00:00Z')],
        )
        const campaignA = campaigns.rows.find((row) => row.code === 'lookup-a').id
        const campaignB = campaigns.rows.find((row) => row.code === 'lookup-b').id
        const phone = '+821012345678'
        const applicationA = await insertApplication(pool, {
          sourceId: 'lookup-app-a',
          campaignId: campaignA,
          name: '홍길동',
          phone,
          blogUrl: 'https://blog.example/a',
          occurredAt,
        })
        await insertApplication(pool, {
          sourceId: 'lookup-app-a-shared-phone',
          campaignId: campaignA,
          name: '김하나',
          phone,
          blogUrl: 'https://blog.example/a-2',
          occurredAt,
        })
        const applicationB = await insertApplication(pool, {
          sourceId: 'lookup-app-b',
          campaignId: campaignB,
          name: '홍길동',
          phone,
          blogUrl: 'https://blog.example/b',
          occurredAt,
        })

        const lookup = new ApplicationCandidateLookupService(pool)
        const strong = await lookup.lookup({
          phoneNormalized: phone,
          campaignId: campaignA,
          applicantName: '홍길동',
          phoneNamePolicy: 'allow',
          blogCampaignPolicy: 'weak',
          decidedAt: occurredAt,
        })
        expect(strong.internal).toMatchObject({
          category: 'strong_match',
          candidateApplicationIds: [applicationA],
          automaticLinkAllowed: true,
        })
        expect(strong.participantSafe).toEqual({
          category: 'strong_match',
          reasonCode: 'IDENTITY_PHONE_CAMPAIGN_NAME',
          automaticLinkAllowed: true,
          nextAction: 'persist_link',
        })
        expect(strong.participantSafe).not.toHaveProperty('candidateApplicationIds')

        const ambiguous = await lookup.lookup({
          phoneNormalized: phone,
          campaignId: campaignA,
          phoneNamePolicy: 'allow',
          blogCampaignPolicy: 'weak',
          decidedAt: occurredAt,
        })
        expect(ambiguous.internal).toMatchObject({ category: 'ambiguous', automaticLinkAllowed: false })
        expect(ambiguous.internal.candidateApplicationIds).toHaveLength(2)
        expect(ambiguous.participantSafe).not.toHaveProperty('candidateApplicationIds')

        const nameOnly = await lookup.lookup({
          campaignId: campaignA,
          applicantName: '홍길동',
          phoneNamePolicy: 'allow',
          blogCampaignPolicy: 'weak',
          decidedAt: occurredAt,
        })
        expect(nameOnly.internal).toMatchObject({
          category: 'weak_match',
          automaticLinkAllowed: false,
          nextAction: 'additional_verification',
        })

        const workflows = new WorkflowInstanceService(pool)
        const bootstrap = new ApplicationWorkflowBootstrapService(pool, workflows)
        const first = await bootstrap.bootstrap({
          applicationId: applicationA,
          triggeringEventId: 'application-import:first',
          correlationId: 'correlation:first',
          occurredAt,
        })
        expect(first.workflow.snapshot.application).toBe('application_completed')
        const replay = await bootstrap.bootstrap({
          applicationId: applicationA,
          triggeringEventId: 'application-import:first-replay',
          correlationId: 'correlation:first-replay',
          occurredAt,
        })
        expect(first.created).toBe(true)
        expect(replay).toMatchObject({ created: false, workflow: { id: first.workflow.id } })

        const secondCampaignWorkflow = await bootstrap.bootstrap({
          applicationId: applicationB,
          participantId: first.workflow.participantId,
          triggeringEventId: 'application-import:second-campaign',
          correlationId: 'correlation:second-campaign',
          occurredAt,
        })
        expect(secondCampaignWorkflow.created).toBe(true)
        expect(secondCampaignWorkflow.workflow.participantId).toBe(first.workflow.participantId)

        const counts = await pool.query(
          `SELECT
             (SELECT count(*)::integer FROM participants) AS participants,
             (SELECT count(*)::integer FROM workflow_instances) AS workflows,
             (SELECT count(*)::integer FROM workflow_side_effects
               WHERE effect_code = 'BEGIN_IDENTITY_MATCHING') AS identity_effects`,
        )
        expect(counts.rows[0]).toMatchObject({ participants: 1, workflows: 2, identity_effects: 2 })
      } finally {
        await pool.end()
      }
    })
  }, 300_000)

  test('advances an imported application to a replay-safe manual-review recommendation only', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url, max: 6 })
      const db = createDbClient(url, 4)
      const occurredAt = new Date('2026-08-24T02:00:00Z')
      const progressedAt = new Date('2026-08-24T02:01:00Z')
      try {
        const campaign = await pool.query(
          `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
           VALUES ('direct-review','Direct Review','shipping','not_applicable','active',$1,$2)
           RETURNING id`,
          [occurredAt, new Date('2026-09-24T02:00:00Z')],
        )
        const applicationId = await insertApplication(pool, {
          sourceId: 'direct-review-app',
          campaignId: campaign.rows[0].id,
          name: '검토 신청자',
          phone: '+821055500001',
          blogUrl: 'https://blog.example/direct-review',
          occurredAt,
        })
        await pool.query(
          `UPDATE applications
              SET blogger_level = 1, blog_daily_visitors = 1500, blogger_region = '서울'
            WHERE id = $1`,
          [applicationId],
        )

        const workflows = new WorkflowInstanceService(pool)
        const bootstrap = new ApplicationWorkflowBootstrapService(pool, workflows)
        const created = await bootstrap.bootstrap({
          applicationId,
          triggeringEventId: 'application-import:direct-review',
          correlationId: 'correlation:direct-review',
          occurredAt,
        })
        const handlers = {
          ...createDirectApplicationSideEffectHandlers(() => progressedAt),
          ...createManualSelectionRecommendationSideEffectHandlers(() => progressedAt),
        }
        const dispatcher = createWorkflowSideEffectDispatcher({ db, handlers, now: () => progressedAt })

        await expect(dispatcher.dispatchBatch(10)).resolves.toEqual({ inspected: 3, finalized: 3, blocked: false })
        const workflow = await pool.query(
          `SELECT application_state, selection_state, version
             FROM workflow_instances WHERE id = $1`,
          [created.workflow.id],
        )
        expect(workflow.rows[0]).toEqual({
          application_state: 'application_matched',
          selection_state: 'review_pending',
          version: 2,
        })
        const recommendation = await pool.query(
          `SELECT result, reason_code, policy_version, input_facts
             FROM selection_recommendations WHERE workflow_id = $1`,
          [created.workflow.id],
        )
        expect(recommendation.rows).toEqual([
          expect.objectContaining({
            result: 'human_review',
            reason_code: 'SELECTION_MANUAL_REVIEW_REQUIRED',
            policy_version: null,
            input_facts: expect.objectContaining({
              bloggerLevel: 1,
              blogDailyVisitors: 1500,
              bloggerRegion: '서울',
              mappedRegion: null,
              measurementPeriod: 'website_average_daily',
            }),
          }),
        ])
        const effects = await pool.query(
          `SELECT effect_code, status
             FROM workflow_side_effects WHERE workflow_id = $1
            ORDER BY effect_code`,
          [created.workflow.id],
        )
        expect(effects.rows).toEqual([
          { effect_code: 'BEGIN_IDENTITY_MATCHING', status: 'completed' },
          { effect_code: 'LOAD_SELECTION_RULE', status: 'completed' },
          { effect_code: 'PERSIST_CHANNEL_LINK', status: 'suppressed' },
        ])
      } finally {
        await db.close()
        await pool.end()
      }
    })
  }, 300_000)
})
