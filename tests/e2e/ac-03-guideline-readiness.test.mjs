import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  GuidelineDeliveryRepository,
  GuidelineDeliveryService,
} from '../../apps/api/dist/modules/guideline-delivery/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { evaluateReservationRules } from '../../apps/api/dist/modules/rules-engine/index.js'
import { guidelineRequest, seedPhase7Workflow } from '../helpers/phase7-seed.mjs'

describe('AC-03 guideline readiness — release gate', () => {
  test('Given Visit B invalid time, When guideline requested, Then correction only and state stays Not Ready', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase7Workflow(pool, 'ac03', {
          route: 'visit_b',
          reservationState: 'correction_required',
          approvalState: 'not_required',
        })
        const validation = evaluateReservationRules(
          {
            campaignId: ids.campaignId,
            normalizedBusinessName: 'hellocafe',
            normalizedBranchName: 'gangnam',
            localDate: '2026-08-31',
            localTime: '19:00:00',
            timezone: 'Asia/Seoul',
            bookingMethod: 'visit_b',
            businessApprovalState: 'not_required',
            reservationStatus: 'completed',
            campaignStatus: 'active',
            capacityAvailable: true,
          },
          {
            version: 7,
            configuration: {
              expectedCampaignId: ids.campaignId,
              businesses: [{ normalizedName: 'hellocafe', normalizedBranch: 'gangnam' }],
              campaignStartsOn: '2026-08-01',
              campaignEndsOn: '2026-09-30',
              allowedIsoWeekdays: [1],
              windowsByIsoWeekday: {
                1: [{ startsAt: '10:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: true }],
              },
              timezone: 'Asia/Seoul',
              bookingMethod: 'visit_b',
              requireCurrentBusinessApproval: false,
              acceptedReservationStatus: 'completed',
              minimumLeadMinutes: 60,
              blackoutDates: [],
              requiredCampaignStatus: 'active',
              capacityRestrictionConfigured: true,
            },
          },
          ids.now,
        )
        expect(validation.failures.map((failure) => failure.ruleCode)).toEqual(['RESERVATION_TIME'])

        const result = await new GuidelineDeliveryService(
          pool,
          new GuidelineDeliveryRepository(),
          new OutboundIntentService(new MessageTemplateRepository()),
        ).request(guidelineRequest(ids, { reservationValidation: validation }))
        expect(result).toMatchObject({
          outcome: 'blocked',
          gate: { ready: false, reasonCode: 'RESERVATION_NOT_VALID' },
          correctionNotification: { status: 'pending' },
        })
        expect((await pool.query(`SELECT purpose_code FROM outbound_notifications`)).rows).toEqual([
          { purpose_code: 'RESERVATION_CORRECTION:INVALID_TIME' },
        ])
        // Readiness composes this correction without the judged evidence, so it says the one thing
        // it can safely read from the failed rule and defers the expected condition to an operator.
        expect((await pool.query(`SELECT rendered_content FROM outbound_notifications`)).rows[0].rendered_content).toBe(
          '예약 가능 시간을 다시 선택해 주세요. 보내주신 내용: 19:00 / 필요한 조건: 담당자 확인 후 안내드리겠습니다',
        )
        expect(
          (await pool.query(`SELECT guideline_state FROM workflow_instances WHERE id = $1`, [ids.workflowId])).rows[0]
            .guideline_state,
        ).toBe('not_ready')
        expect((await pool.query(`SELECT count(*)::integer AS count FROM guideline_deliveries`)).rows[0].count).toBe(0)
      } finally {
        await pool.end()
      }
    })
  })
})
