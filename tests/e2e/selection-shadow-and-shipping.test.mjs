import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import { ApplicationSyncService, ManualCsvImportService } from '../../apps/api/dist/modules/application-sync/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { RankingEvidenceAdapter, SelectionService } from '../../apps/api/dist/modules/selection/index.js'
import { ShippingService } from '../../apps/api/dist/modules/shipping/index.js'
import {
  GuidelineDeliveryRepository,
  GuidelineDeliveryService,
} from '../../apps/api/dist/modules/guideline-delivery/index.js'
import { guidelineRequest, seedPhase7Workflow } from '../helpers/phase7-seed.mjs'

describe('T72/T77 selection-shadow and shipping release gates', () => {
  test('keeps CSV selection manual, then completes an owner-bound shipping journey exactly once', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const now = new Date('2026-08-24T12:00:00Z')
        const campaign = await pool.query(
          `INSERT INTO campaigns (code,name,type,visit_method,status,starts_at,ends_at)
           VALUES ('e2e-selection','E2E Selection','visit','visit_a','active',$1,$2) RETURNING id`,
          [new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z')],
        )
        const csv = [
          'application_id,campaign_code,application_status,applicant_name,phone_normalized,blog_url,blogger_level,blog_daily_visitors,blogger_region,submitted_at,updated_at',
          'e2e-selection-app,e2e-selection,received,E2E Applicant,+821012345678,https://blog.example/e2e,1,1500,서울,2026-08-24T11:00:00Z,2026-08-24T11:30:00Z',
        ].join('\n')
        await new ManualCsvImportService(
          pool,
          new ApplicationSyncService(pool),
          'e2e-selection-key-at-least-16-characters',
        ).importCsv({
          content: csv,
          sourceSystem: 'helloreview_website',
          exportedAt: new Date('2026-08-24T11:40:00Z'),
          importedAt: new Date('2026-08-24T11:41:00Z'),
        })
        const application = await pool.query(
          `SELECT id FROM applications WHERE source_application_id = 'e2e-selection-app'`,
        )
        const participant = await pool.query(`INSERT INTO participants (name) VALUES ('E2E Selection') RETURNING id`)
        const workflow = await pool.query(
          `INSERT INTO workflow_instances (
             participant_id, application_id, campaign_id, campaign_type, visit_method,
             application_state, selection_state, reservation_state,
             application_origin_at, selection_origin_at, secret_comment_origin_at,
             payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
             reservation_origin_at, guideline_origin_at, human_handoff_origin_at, automation_mode_origin_at
           ) VALUES ($1,$2,$3,'visit','visit_a','application_matched','not_reviewed','not_started',
                     $4,$4,$4,$4,$4,$4,$4,$4,$4,$4) RETURNING id`,
          [participant.rows[0].id, application.rows[0].id, campaign.rows[0].id, now],
        )
        const selection = new SelectionService(pool)
        const recommendationInput = {
          workflowId: workflow.rows[0].id,
          applicationId: application.rows[0].id,
          campaignId: campaign.rows[0].id,
          evidence: await new RankingEvidenceAdapter(pool).read({
            workflowId: workflow.rows[0].id,
            participantId: participant.rows[0].id,
            now,
            maximumAgeMs: 60 * 60_000,
            regionMapping: { 서울: 'capital' },
          }),
          policy: {
            version: 'e2e-selection-v1',
            eligibleLevels: [1, 2],
            minimumDailyVisitors: 1000,
            reviewBand: { lowerInclusive: 900, upperInclusive: 1099 },
            eligibleMappedRegions: ['capital'],
            measurementPeriod: 'website_average_daily',
          },
          actorReference: 'shadow-evaluator',
          occurredAt: now,
        }
        const recommendation = await selection.recordRecommendation(recommendationInput)
        expect(await selection.recordRecommendation(recommendationInput)).toMatchObject({ deduplicated: true })
        expect(
          (await pool.query(`SELECT selection_state FROM workflow_instances WHERE id = $1`, [workflow.rows[0].id]))
            .rows[0].selection_state,
        ).toBe('not_reviewed')
        const operatorDecision = await selection.recordManualDecision({
          workflowId: workflow.rows[0].id,
          recommendationId: recommendation.id,
          decision: 'selected',
          actorType: 'operator',
          actorReference: 'operator-e2e',
          authorized: true,
          scopeCode: 'WORKFLOW',
          reasonCode: 'MANUAL_OVERRIDE',
          correlationId: 'selection-e2e',
          occurredAt: new Date(now.getTime() + 1_000),
        })
        expect(operatorDecision.shadowOutcome).toBe('matched')
        expect(JSON.stringify(selection.participantFacingStatus())).not.toMatch(/1500|score|rank|level/i)
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM workflow_events
                WHERE workflow_id = $1 AND dimension = 'selection'`,
              [workflow.rows[0].id],
            )
          ).rows[0].count,
        ).toBe(0)

        const shippingIds = await seedPhase7Workflow(pool, 't77-e2e', {
          route: 'shipping',
          approvalState: 'not_required',
        })
        await pool.query(`UPDATE workflow_instances SET shipping_state = 'address_requested' WHERE id = $1`, [
          shippingIds.workflowId,
        ])
        await pool.query(
          `INSERT INTO message_templates (
             purpose_code, version, status, legal_classification, body,
             approved_by, approved_at, activated_at
           ) VALUES ('SHIPPING_ADDRESS_REQUEST',1,'active','operational_transactional',
                     '주소 입력: {{form_link}}','legal-e2e',$1,$1)`,
          [shippingIds.now],
        )
        // The submission has no policy field. The published campaign shipping rule below is the
        // only source of required fields, allowed postal regions, cutoff, and lock instants.
        await pool.query(
          `INSERT INTO campaign_rules (
             campaign_id, rule_type, version, status, configuration,
             effective_from, published_by, published_at
           ) VALUES ($1,'shipping',1,'published',$2::jsonb,$3,'shipping-e2e-operator',$3)`,
          [
            shippingIds.campaignId,
            JSON.stringify({
              requiredFields: ['recipientName', 'phone', 'postalCode', 'addressLine1', 'addressLine2'],
              allowedPostalPrefixes: ['06'],
              changeCutoffAt: new Date(shippingIds.now.getTime() + 3_600_000).toISOString(),
              lockAt: new Date(shippingIds.now.getTime() + 7_200_000).toISOString(),
            }),
            new Date(shippingIds.now.getTime() - 3_600_000),
          ],
        )
        const outbound = new OutboundIntentService(new MessageTemplateRepository())
        const shipping = new ShippingService(pool, Buffer.alloc(32, 11), outbound)
        const issued = await shipping.issueForm({
          workflowId: shippingIds.workflowId,
          participantId: shippingIds.participantId,
          channel: 'KAKAO',
          recipientReference: 'masked-shipping-e2e',
          formBaseUrl: 'https://forms.example/shipping',
          tokenTtlSeconds: 600,
          templateVersion: 1,
          actorId: 'shipping-e2e',
          occurredAt: shippingIds.now,
        })
        const submit = {
          token: issued.token,
          workflowId: shippingIds.workflowId,
          participantId: shippingIds.participantId,
          address: {
            recipientName: '홍길동',
            phone: '010-1234-5678',
            postalCode: '06236',
            addressLine1: '서울특별시 강남구 테헤란로 123',
            addressLine2: '4층',
          },
          actorReference: 'participant-e2e',
          occurredAt: new Date(shippingIds.now.getTime() + 2_000),
        }
        await expect(shipping.submit({ ...submit, participantId: participant.rows[0].id })).rejects.toMatchObject({
          reasonCode: 'SHIPPING_FORM_NOT_FOUND',
        })
        expect(await shipping.submit(submit)).toMatchObject({ outcome: 'stored', version: 1 })
        await expect(shipping.submit(submit)).rejects.toMatchObject({ reasonCode: 'SHIPPING_FORM_ALREADY_USED' })
        const guideline = new GuidelineDeliveryService(pool, new GuidelineDeliveryRepository(), outbound)
        const request = guidelineRequest(shippingIds, {
          triggeringEventId: 'shipping-e2e-guideline',
          occurredAt: new Date(shippingIds.now.getTime() + 3_000),
        })
        expect(await guideline.request(request)).toMatchObject({ outcome: 'queued', gate: { ready: true } })
        expect(await guideline.request(request)).toMatchObject({ outcome: 'suppressed' })
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM outbound_notifications
                WHERE purpose_code = 'GUIDELINE_DELIVERY:3'`,
            )
          ).rows[0].count,
        ).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })
})
